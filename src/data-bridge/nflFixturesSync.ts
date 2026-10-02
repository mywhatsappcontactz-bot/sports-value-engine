// src/data-bridge/nflFixturesSync.ts
//
// Bridges nflScraper.ts / nflModel.ts into the matches table, for the
// tipscanner-only path — mirrors proballersFixturesSync.ts's structure
// (same dedup logic, same Cleaner -> Validator pipeline).
//
// SCOPE: only pulls the CURRENT season's completed games for team
// history (not pooled multi-season like the backtest did) — live sync
// needs to be fast, not exhaustive. Early in a season this means thin
// history; nflStatsMapper.ts's MIN_PRIOR_GAMES gate (via nflModel.ts)
// correctly skips matchups where either team has fewer than 3 games yet.
//
// COST NOTE: unlike proballersFixturesSync.ts (one schedule-page fetch
// per league), this fetches ONE BOXSCORE PER COMPLETED GAME so far this
// season (via buildHistoryFromGames in nflModel.ts) — same cost pattern
// as the NFL backtest earlier tonight, just scoped to weeks-so-far
// instead of a full season. Early season this is cheap (few completed
// games); by mid-season this grows to ~100+ requests. Runs with the
// same politeness delay nflScraper.ts already has built in.

import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import {
  fetchWeekScoreboard,
  fetchFullSeason,
  NflGame,
} from '../scrapers/football-nfl/nflScraper';
import {
  buildHistoryFromGames,
  computeLeagueAverages,
  TeamGameRecord,
} from '../core/engine/nflModel';
import { nflStatsToRawStats } from './nflStatsMapper';

export interface NflFixturesSyncResult {
  fixturesFound: number;
  matchesCreated: number;
  matchesReused: number;
  statsSaved: number;
  statsRejected: number;
  insufficientHistory: number; // matches skipped entirely — not even attempted, not a "rejection"
  errors: number;
}

function normalizeTeamName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// Same duplicate-row guard pattern as proballersFixturesSync.ts /
// baseballFixturesSync.ts.
function findExistingMatch(
  repo: Repository,
  homeTeam: string,
  awayTeam: string,
  dateIso: string,
): string | null {
  const upcoming = repo.getUpcomingMatches('nfl');
  const nHome = normalizeTeamName(homeTeam);
  const nAway = normalizeTeamName(awayTeam);

  for (const m of upcoming) {
    const matchDate = m.startTime.slice(0, 10);
    if (matchDate !== dateIso) continue;

    const mHome = normalizeTeamName(m.homeTeam);
    const mAway = normalizeTeamName(m.awayTeam);

    if ((mHome === nHome && mAway === nAway) || (mHome === nAway && mAway === nHome)) {
      return m.id;
    }
  }

  return null;
}

/**
 * Determines current season year + type from the live scoreboard's own
 * response, rather than hardcoding — avoids the exact "current season"
 * staleness bug found with Proballers earlier tonight (ESPN's API
 * correctly reports its own current context, unlike Proballers' schedule
 * pages, so this is safe to trust directly).
 */
async function detectCurrentSeason(): Promise<{ year: number; seasonType: number } | null> {
  const current = await fetchWeekScoreboard();
  if (!current.length) return null;
  const sample = current[0];
  const year = parseInt(sample.date.slice(0, 4), 10);
  return { year, seasonType: sample.seasonType };
}

export async function syncNflFixtures(): Promise<NflFixturesSyncResult> {
  const result: NflFixturesSyncResult = {
    fixturesFound: 0,
    matchesCreated: 0,
    matchesReused: 0,
    statsSaved: 0,
    statsRejected: 0,
    insufficientHistory: 0,
    errors: 0,
  };

  const repo = new Repository(getDb());
  const cleaner = new Cleaner();
  const validator = new Validator();

  const season = await detectCurrentSeason();
  if (!season) {
    logger.warn('[NflFixturesSync] Could not detect current season — no games in scoreboard response');
    return result;
  }

  console.log(`[DEBUG NFL-SYNC] Detected season: ${season.year}, type ${season.seasonType}`);

  let allSeasonGames: NflGame[];
  try {
    allSeasonGames = await fetchFullSeason(season.year, season.seasonType as 1 | 2 | 3);
  } catch (err: any) {
    logger.error('[NflFixturesSync] Failed to fetch season games', { error: err.message });
    result.errors++;
    return result;
  }

  const upcoming = allSeasonGames.filter(g => !g.completed);
  const completed = allSeasonGames.filter(g => g.completed);

  result.fixturesFound = upcoming.length;
  console.log(`[DEBUG NFL-SYNC] ${upcoming.length} upcoming fixtures, ${completed.length} completed games for history`);

  if (completed.length === 0) {
    console.log('[DEBUG NFL-SYNC] No completed games yet this season — skipping (no history to build predictions from)');
    return result;
  }

  console.log(`[DEBUG NFL-SYNC] Fetching boxscores for ${completed.length} completed games (builds team history)...`);
  const fullHistory: Map<string, TeamGameRecord[]> = await buildHistoryFromGames(allSeasonGames);
  const leagueAvg = computeLeagueAverages(fullHistory);
  console.log(`[DEBUG NFL-SYNC] League averages: yardsPerPlay=${leagueAvg.avgYardsPerPlay.toFixed(2)}, turnovers=${leagueAvg.avgTurnovers.toFixed(2)}`);

  for (const fixture of upcoming) {
    try {
      let matchId = findExistingMatch(repo, fixture.homeTeam, fixture.awayTeam, fixture.date);

      if (matchId) {
        result.matchesReused++;
      } else {
        const externalId = `nfl-${fixture.date}-${normalizeTeamName(fixture.homeTeam)}-${normalizeTeamName(fixture.awayTeam)}`;

        matchId = repo.upsertMatch({
          sport: 'nfl',
          league: 'NFL',
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          startTime: `${fixture.date}T18:00:00.000Z`, // NFL start times vary; scoreboard date is reliable, exact kickoff time not currently parsed — approximate evening slot
          status: 'upcoming',
          externalId,
          source: 'nfl-espn-fixtures-free',
        });
        result.matchesCreated++;
      }

      const rawStats = nflStatsToRawStats(matchId, fixture.homeTeam, fixture.awayTeam, fullHistory, leagueAvg);

      if (!rawStats) {
        // Not enough history for one or both teams — expected and
        // common early in a season, not an error.
        result.insufficientHistory++;
        continue;
      }

      const cleanedStats = cleaner.cleanStats(rawStats, matchId, 'nfl');
      if (!cleanedStats) {
        logger.warn('[NflFixturesSync] cleanStats returned null', {
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        result.statsRejected++;
        continue;
      }

      const statsValidation = validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        logger.warn('[NflFixturesSync] Stats failed validation — skipping', {
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
    } catch (err: any) {
      result.errors++;
      logger.error('[NflFixturesSync] Failed to sync fixture', {
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }
  }

  console.log('[DEBUG NFL-SYNC] Complete:', result);
  logger.info('[NflFixturesSync] Complete', result);
  return result;
}