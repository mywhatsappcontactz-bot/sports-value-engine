// src/data-bridge/basketballFixturesSync.ts
//
// Bridges nbaFixturesScraper.ts / wnbaFixturesScraper.ts into the matches
// table, for the tipscanner-only path — mirrors soccerStatsFixturesSync.ts's
// role for football, with two important differences:
//
// 1. DUPLICATE-ROW PROTECTION: football's fixtures sync only ever covers
// leagues the paid odds API does NOT cover, so there is structurally no
// way for it to create a duplicate row for a game the paid path already
// knows about. Basketball has no such guarantee — NBA/WNBA ARE covered by
// the paid odds API (kept intact for value bet, see realFetcher.ts) — so
// this module checks for an existing 'upcoming' match with the same sport
// + normalized team names + same calendar date BEFORE creating anything.
// If found (regardless of source), stats are attached to that existing
// row instead of creating a new one.
//
// 2. REAL VALIDATION: this now runs stats through the same Cleaner ->
// Validator pipeline realFetcher.ts's paid path uses (both are pure local
// computation — zero network calls, zero API cost, so this stays fully
// free) — matches that fail validation (stale data, insufficient sample
// size, etc.) are skipped rather than saved unconditionally. An earlier
// version of this file bypassed validation entirely, which was the root
// cause of unrealistically high-confidence basketball tips slipping
// through the free tipscanner path.
//
// Run this ONLY from TipsOnlyScan.ts, never from Scan.ts — Scan.ts's own
// basketball path already goes through realFetcher.ts -> oddsClient (paid).

import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import { fetchNBAFixtures, NBAFixture } from '../scrapers/basketball/nbaFixturesScraper';
import { fetchWNBAFixtures, WNBAFixtureEntry } from '../scrapers/basketball/wnbaFixturesScraper';
import {
  basketballStatsToRawStats,
  fetchBasketballH2HForLeague,
  BasketballLeague,
} from './realFetcher';

export interface BasketballFixturesSyncResult {
  league: BasketballLeague;
  fixturesFound: number;
  matchesCreated: number;
  matchesReused: number;
  statsSaved: number;
  statsRejected: number;
  errors: number;
}

const LEAGUE_DISPLAY_NAME: Record<BasketballLeague, string> = {
  nba: 'NBA',
  wnba: 'WNBA',
};

function normalizeTeamName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Finds an existing upcoming match for the same sport, same calendar date
// (UTC), and matching team names (either orientation — home/away can differ
// in source ordering conventions) — regardless of which source created it.
// This is the core duplicate-row guard described in the file header.
function findExistingMatch(
  repo: Repository,
  homeTeam: string,
  awayTeam: string,
  dateIso: string, // YYYY-MM-DD
): string | null {
  const upcoming = repo.getUpcomingMatches('basketball');
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

async function syncLeagueFixtures(
  league: BasketballLeague,
  fixtures: { date: string; homeTeam: string; awayTeam: string }[],
): Promise<BasketballFixturesSyncResult> {
  console.log(`[DEBUG BBALL-SYNC] ${league}: ${fixtures.length} fixtures found`);

  const result: BasketballFixturesSyncResult = {
    league,
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
  const leagueName = LEAGUE_DISPLAY_NAME[league];

  for (const fixture of fixtures) {
    try {
      let matchId = findExistingMatch(repo, fixture.homeTeam, fixture.awayTeam, fixture.date);

      if (matchId) {
        result.matchesReused++;
        console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} (${fixture.date}) — reused existing match ${matchId}`);
      } else {
        const externalId = `bbref-${fixture.date}-${normalizeTeamName(fixture.homeTeam)}-${normalizeTeamName(fixture.awayTeam)}`;

        matchId = repo.upsertMatch({
          sport: 'basketball',
          league: leagueName,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          startTime: `${fixture.date}T12:00:00.000Z`,
          status: 'upcoming',
          externalId,
          source: 'basketball-fixtures-free',
        });
        result.matchesCreated++;
        console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} (${fixture.date}) — created new match ${matchId}`);
      }

      const h2h = await fetchBasketballH2HForLeague(league, fixture.homeTeam, fixture.awayTeam);
      if (!h2h) {
        console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — NO H2H DATA FOUND`);
        logger.warn('[BasketballFixturesSync] No H2H data found', {
          league,
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        continue;
      }

      console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — h2hRecords=${h2h.recentMatches.length} homeForm=${h2h.homeForm.length} awayForm=${h2h.awayForm.length}`);

      const rawStats = basketballStatsToRawStats(h2h, matchId, league);
      const cleanedStats = cleaner.cleanStats(rawStats, matchId, 'basketball');
      if (!cleanedStats) {
        console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — cleanStats returned NULL`);
        logger.warn('[BasketballFixturesSync] cleanStats returned null', {
          league,
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        result.statsRejected++;
        continue;
      }

      const statsValidation = validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — VALIDATION FAILED:`, statsValidation.errors);
        logger.warn('[BasketballFixturesSync] Stats failed validation — skipping tip for this match', {
          league,
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
      console.log(`[DEBUG BBALL-SYNC] ${fixture.homeTeam} vs ${fixture.awayTeam} — stats SAVED`);

    } catch (err: any) {
      result.errors++;
      console.log(`[DEBUG BBALL-SYNC] EXCEPTION for ${fixture.homeTeam} vs ${fixture.awayTeam}: ${err.message}`);
      logger.error('[BasketballFixturesSync] Failed to sync fixture', {
        league,
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }
  }

  console.log(`[DEBUG BBALL-SYNC] ${league} complete:`, result);
  logger.info('[BasketballFixturesSync] League complete', result);
  return result;
}

export async function syncAllBasketballFixtures(
  daysAhead: number = 7,
): Promise<BasketballFixturesSyncResult[]> {
  console.log(`[DEBUG BBALL-SYNC] syncAllBasketballFixtures called, daysAhead=${daysAhead}`);
  const results: BasketballFixturesSyncResult[] = [];

  try {
    const nbaFixtures: NBAFixture[] = await fetchNBAFixtures(daysAhead);
    results.push(await syncLeagueFixtures('nba', nbaFixtures));
  } catch (err: any) {
    console.log(`[DEBUG BBALL-SYNC] NBA sync threw: ${err.message}`);
    logger.error('[BasketballFixturesSync] NBA sync failed', { error: err.message });
    results.push({ league: 'nba', fixturesFound: 0, matchesCreated: 0, matchesReused: 0, statsSaved: 0, statsRejected: 0, errors: 1 });
  }

  try {
    const wnbaFixtures: WNBAFixtureEntry[] = await fetchWNBAFixtures(daysAhead);
    results.push(await syncLeagueFixtures('wnba', wnbaFixtures));
  } catch (err: any) {
    console.log(`[DEBUG BBALL-SYNC] WNBA sync threw: ${err.message}`);
    logger.error('[BasketballFixturesSync] WNBA sync failed', { error: err.message });
    results.push({ league: 'wnba', fixturesFound: 0, matchesCreated: 0, matchesReused: 0, statsSaved: 0, statsRejected: 0, errors: 1 });
  }

  return results;
}