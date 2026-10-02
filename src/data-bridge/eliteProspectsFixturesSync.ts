// src/data-bridge/eliteProspectsFixturesSync.ts
//
// Bridges eliteProspectsScraper.ts into the matches table — mirrors
// proballersFixturesSync.ts's structure closely (same duplicate-row
// protection, same Cleaner -> Validator pipeline, same current-season-
// for-form / multi-season-for-H2H split). See proballersFixturesSync.ts
// for the full reasoning behind that split; unchanged here.
//
// UNLIKE proballersFixturesSync.ts: sport is the real 'hockey' value,
// not reused from another sport — see eliteProspectsStatsMapper.ts's
// header for why that's safe here (hockey is already a recognized sport
// value throughout the codebase, confirmed via grep, not assumed).
//
// UNVERIFIED — same caution every *FixturesSync.ts file in this codebase
// flags for itself: Cleaner/Validator's exact handling hasn't been
// directly confirmed for this new data source. Test end-to-end against
// a real fixture before trusting in production.
//
// SEASON STRING FORMAT DIFFERS FROM PROBALLERS: EliteProspects seasons
// are "YYYY-YYYY" (e.g. "2024-2025"), not a single year like Proballers
// uses. buildSeasonString() below is a REASONED HEURISTIC, not a
// confirmed rule: hockey seasons in every league checked so far run
// roughly Sept-Apr/May, so if "now" is on/after September the season
// currently starting is treated as (year)-(year+1); before September,
// the season still in progress is treated as (year-1)-(year). This has
// NOT been verified against every league's actual real start date — if
// H2H results look thin or seasons don't line up right for a given
// league, this is the first place to check.
//
// NO EXCLUDED_LEAGUES YET: unlike Proballers' EXCLUDED_LEAGUES (built
// from real basketballBacktest1.ts hit-rate data), no hockey backtest
// has been run yet — ACTIVE_LEAGUES is every verified league in
// ELITEPROSPECTS_LEAGUE_MAP with no exclusions. Revisit once a hockey
// backtest script exists and produces real per-league numbers, same
// process Proballers went through.

import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import {
  fetchLeagueSchedule,
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../scrapers/hockey/eliteProspectsScraper';
import { eliteProspectsStatsToRawStats } from './eliteProspectsStatsMapper';

const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);

// How many seasons PRIOR to the current one to include when building
// H2H history — same value and same reasoning as
// proballersFixturesSync.ts's H2H_LOOKBACK_SEASONS (not independently
// tuned for hockey).
const H2H_LOOKBACK_SEASONS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// See header comment — REASONED HEURISTIC, not a confirmed rule.
function buildSeasonString(yearsAgo: number): string {
  const now = new Date();
  const isPastSeasonStart = now.getUTCMonth() >= 8; // September = index 8
  const seasonStartYear = (isPastSeasonStart ? now.getUTCFullYear() : now.getUTCFullYear() - 1) - yearsAgo;
  return `${seasonStartYear}-${seasonStartYear + 1}`;
}

// Fetches the current season's games plus H2H_LOOKBACK_SEASONS prior
// seasons, deduplicated by gameId. Mirrors
// proballersFixturesSync.ts's fetchMultiSeasonHistory exactly, adapted
// for EliteProspects' "YYYY-YYYY" season string format.
// Takes currentSeasonGames as a param instead of re-fetching season 0 —
// confirmed via real logs that the old version fired two separate HTTP
// requests for the exact same current-season URL (once here, once in
// syncOneLeague's own currentSeasonGames fetch), wasting cookie lifetime
// and doubling request volume for no benefit. Now only fetches the
// PRIOR seasons (i=1..N) and merges in the already-fetched current one.
async function fetchMultiSeasonHistory(leagueName: string, currentSeasonGames: EPGame[]): Promise<EPGame[]> {
  const seasonArgs: string[] = [];
  for (let i = 1; i <= H2H_LOOKBACK_SEASONS; i++) {
    seasonArgs.push(buildSeasonString(i));
  }

  const allGames: EPGame[] = [...currentSeasonGames];
  for (const season of seasonArgs) {
    try {
      const games = await fetchLeagueScores(leagueName, season);
      allGames.push(...games);
    } catch (err: any) {
      logger.warn('[EliteProspectsFixturesSync] Multi-season H2H fetch failed for one season — continuing with what was found', {
        leagueName,
        season,
        error: err.message,
      });
    }
  }

  const seen = new Set<number>();
  return allGames.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
}

export interface EliteProspectsFixturesSyncResult {
  league: string;
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

function findExistingMatch(
  repo: Repository,
  homeTeam: string,
  awayTeam: string,
  dateIso: string,
): string | null {
  const upcoming = repo.getUpcomingMatches('hockey');
  const nHome = normalizeTeamName(homeTeam);
  const nAway = normalizeTeamName(awayTeam);

  for (const m of upcoming) {
    const matchDate = m.startTime.slice(0, 10);
    if (matchDate !== dateIso) continue;

    const mHome = normalizeTeamName(m.homeTeam);
    const mAway = normalizeTeamName(m.awayTeam);

    const sameOrientation = mHome === nHome && mAway === nAway;
    const swappedOrientation = mHome === nAway && mAway === nHome;

    if (sameOrientation || swappedOrientation) return m.id;
  }

  return null;
}

export async function syncOneLeague(leagueName: string): Promise<EliteProspectsFixturesSyncResult> {
  const result: EliteProspectsFixturesSyncResult = {
    league: leagueName,
    fixturesFound: 0,
    matchesCreated: 0,
    matchesReused: 0,
    statsSaved: 0,
    statsRejected: 0,
    errors: 0,
  };

  const repo = new Repository(getDb());
  const cleaner = new Cleaner();
  const validator = new Validator();

    let upcoming: EPGame[];
  let currentSeasonGames: EPGame[];
  let h2hHistoryGames: EPGame[];
  try {
    // upcoming + current-season run concurrently (independent); H2H
    // history depends on currentSeasonGames (reuses it instead of
    // re-fetching the same season — see fetchMultiSeasonHistory's
    // header comment), so it runs after, not in the same Promise.all.
    [upcoming, currentSeasonGames] = await Promise.all([
      fetchLeagueSchedule(leagueName), // upcoming/unplayed fixtures
      fetchLeagueScores(leagueName, buildSeasonString(0)), // CURRENT SEASON ONLY — form/goals/fatigue
    ]);
    h2hHistoryGames = await fetchMultiSeasonHistory(leagueName, currentSeasonGames);
  } catch (err: any) {
    logger.error('[EliteProspectsFixturesSync] Failed to fetch league data', { leagueName, error: err.message });
    result.errors++;
    return result;
  }

  result.fixturesFound = upcoming.length;
  console.log(`[DEBUG ELITEPROSPECTS-SYNC] ${leagueName}: ${upcoming.length} upcoming fixtures, ${currentSeasonGames.length} current-season games, ${h2hHistoryGames.length} multi-season H2H pool`);

  for (const fixture of upcoming) {
    try {
      let matchId = findExistingMatch(repo, fixture.homeTeam, fixture.awayTeam, fixture.date);

      if (matchId) {
        result.matchesReused++;
      } else {
        const externalId = `eliteprospects-${normalizeTeamName(leagueName)}-${fixture.date}-${normalizeTeamName(fixture.homeTeam)}-${normalizeTeamName(fixture.awayTeam)}`;

        matchId = repo.upsertMatch({
          sport: 'hockey',
          league: leagueName,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          // EliteProspects gives a full ISO datetime directly (dateTime
          // field, e.g. "2025-02-22T19:00:00+0000") — no manual
          // date+time-string parsing needed here, unlike Proballers'
          // buildStartTime() which had to reconstruct it from a raw
          // "5:00 PM"-style string.
          startTime: fixture.dateTime,
          status: 'upcoming',
          externalId,
          source: 'eliteprospects-fixtures-free',
        });
        result.matchesCreated++;
      }

      const rawStats = eliteProspectsStatsToRawStats(
        matchId,
        fixture.homeTeam,
        fixture.awayTeam,
        currentSeasonGames,
        h2hHistoryGames,
        fixture.date,
      );

      const cleanedStats = cleaner.cleanStats(rawStats, matchId, 'hockey');
      if (!cleanedStats) {
        logger.warn('[EliteProspectsFixturesSync] cleanStats returned null', {
          league: leagueName,
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        result.statsRejected++;
        continue;
      }

      const statsValidation = validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        logger.warn('[EliteProspectsFixturesSync] Stats failed validation — skipping', {
          league: leagueName,
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
      logger.error('[EliteProspectsFixturesSync] Failed to sync fixture', {
        league: leagueName,
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }
  }

  console.log(`[DEBUG ELITEPROSPECTS-SYNC] ${leagueName} complete:`, result);
  return result;
}

export async function syncAllEliteProspectsFixtures(): Promise<EliteProspectsFixturesSyncResult[]> {
  const results: EliteProspectsFixturesSyncResult[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    const result = await syncOneLeague(leagueName);
    results.push(result);
    await sleep(1000);
  }

  logger.info('[EliteProspectsFixturesSync] All leagues complete', {
    totalFixtures: results.reduce((s, r) => s + r.fixturesFound, 0),
    totalCreated: results.reduce((s, r) => s + r.matchesCreated, 0),
    totalReused: results.reduce((s, r) => s + r.matchesReused, 0),
    totalStatsSaved: results.reduce((s, r) => s + r.statsSaved, 0),
    totalErrors: results.reduce((s, r) => s + r.errors, 0),
  });

  return results;
}