// src/data-bridge/baseballFixturesSync.ts
//
// Bridges mlbScraper.ts into the matches table, for the tipscanner-only
// path — mirrors basketballFixturesSync.ts's role and structure closely
// (same duplicate-row protection, same Cleaner -> Validator pipeline).
//
// UNVERIFIED — see mlbStatsMapper.ts's file header for the two specific
// open questions (Cleaner/Validator baseball support, sample-size
// thresholds). Test end-to-end against a real fixture before trusting
// this in production, same caution that applied to mlbScraper.ts itself
// before its own smoke tests confirmed the API shape.
//
// Run this from wherever TipsOnlyScan.ts (or its baseball equivalent)
// orchestrates the free tipscanner-only sync, alongside
// syncAllBasketballFixtures — NOT from the paid realFetcher.ts path,
// since no paid odds API integration exists for MLB in this codebase.

import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import { fetchMlbFixtures, MlbFixture, fetchMlbMatchStats } from '../scrapers/baseball/mlbScraper';
import { mlbStatsToRawStats } from './mlbStatsMapper';

export interface BaseballFixturesSyncResult {
  league: 'mlb';
  fixturesFound: number;
  matchesCreated: number;
  matchesReused: number;
  statsSaved: number;
  statsRejected: number;
  errors: number;
}

function normalizeTeamName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Same duplicate-row guard as basketballFixturesSync.ts's
// findExistingMatch — checks for an existing 'upcoming' match with the
// same sport, calendar date, and matching team names (either
// orientation) before creating a new row.
function findExistingMatch(
  repo: Repository,
  homeTeam: string,
  awayTeam: string,
  dateIso: string, // YYYY-MM-DD
): string | null {
  const upcoming = repo.getUpcomingMatches('baseball');
  const nHome = normalizeTeamName(homeTeam);
  const nAway = normalizeTeamName(awayTeam);

  for (const m of upcoming) {
    const matchDate = m.startTime.slice(0, 10);
    if (matchDate !== dateIso) continue;

    const mHome = normalizeTeamName(m.homeTeam);
    const mAway = normalizeTeamName(m.awayTeam);

    const sameOrientation = mHome === nHome && mAway === nAway;
    const swappedOrientation = mHome === nAway && mAway === nHome;

    if (sameOrientation || swappedOrientation) {
      return m.id;
    }
  }

  return null;
}

export async function syncMlbFixtures(
  daysAhead: number = 7,
): Promise<BaseballFixturesSyncResult> {
  const fixtures: MlbFixture[] = await fetchMlbFixtures(daysAhead);
  console.log(`[DEBUG MLB-SYNC] mlb: ${fixtures.length} fixtures found`);

  const result: BaseballFixturesSyncResult = {
    league: 'mlb',
    fixturesFound: fixtures.length,
    matchesCreated: 0,
    matchesReused: 0,
    statsSaved: 0,
    statsRejected: 0,
    errors: 0,
  };

  const repo = new Repository(getDb());
  const cleaner = new Cleaner();
  const validator = new Validator();

  for (const fixture of fixtures) {
    try {
      let matchId = findExistingMatch(repo, fixture.homeTeam, fixture.awayTeam, fixture.date);

      if (matchId) {
        result.matchesReused++;
        console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} (${fixture.date}) — reused existing match ${matchId}`);
      } else {
        const externalId = `mlb-${fixture.date}-${normalizeTeamName(fixture.homeTeam)}-${normalizeTeamName(fixture.awayTeam)}`;

        matchId = repo.upsertMatch({
          sport: 'baseball',
          league: 'MLB',
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          startTime: `${fixture.date}T12:00:00.000Z`,
          status: 'upcoming',
          externalId,
          source: 'mlb-fixtures-free',
        });
        result.matchesCreated++;
        console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} (${fixture.date}) — created new match ${matchId}`);
      }

      const matchStats = await fetchMlbMatchStats(fixture.homeTeam, fixture.awayTeam);
      if (!matchStats) {
        console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — NO STATS DATA FOUND (team match failed)`);
        logger.warn('[BaseballFixturesSync] Could not fetch stats — team matching failed', {
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        continue;
      }

      console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — h2hRecords=${matchStats.h2h.length} homeForm=${matchStats.homeForm.length} awayForm=${matchStats.awayForm.length}`);

      const rawStats = mlbStatsToRawStats(matchStats, matchId);

      // NOTE: 'baseball' passed as the sport string here — see
      // mlbStatsMapper.ts's file header re: this being unverified against
      // Cleaner/Validator's actual implementation.
      const cleanedStats = cleaner.cleanStats(rawStats, matchId, 'baseball');
      if (!cleanedStats) {
        console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — cleanStats returned NULL`);
        logger.warn('[BaseballFixturesSync] cleanStats returned null', {
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        result.statsRejected++;
        continue;
      }

      const statsValidation = validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — VALIDATION FAILED:`, statsValidation.errors);
        logger.warn('[BaseballFixturesSync] Stats failed validation — skipping tip for this match', {
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          errors: statsValidation.errors,
        });
        result.statsRejected++;
        continue;
      }

      if (statsValidation.confidenceAdjustment < 1) {
        cleanedStats.confidenceFactors.dataCompleteness = parseFloat(
          (cleanedStats.confidenceFactors.dataCompleteness * statsValidation.confidenceAdjustment).toFixed(4)
        );
      }

      repo.upsertStats(cleanedStats);
      result.statsSaved++;
      console.log(`[DEBUG MLB-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — stats SAVED`);

    } catch (err: any) {
      result.errors++;
      console.log(`[DEBUG MLB-SYNC] EXCEPTION for ${fixture.homeTeam} vs ${fixture.awayTeam}: ${err.message}`);
      logger.error('[BaseballFixturesSync] Failed to sync fixture', {
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }

    // Be polite to statsapi.mlb.com — each fixture triggers 2 schedule
    // fetches (home team + away team, inside fetchMlbMatchStats), and
    // this loop can run through 20-30+ fixtures in one sync. The initial
    // build had NO delay here at all, which is the most likely cause of
    // the "fetch failed"/"terminated" errors seen in testing — same
    // throttling pattern already used for soccerstats.com (1500ms) and
    // TennisAbstract (5000ms) elsewhere in this codebase.
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[DEBUG MLB-SYNC] mlb complete:`, result);
  logger.info('[BaseballFixturesSync] Complete', result);
  return result;
}