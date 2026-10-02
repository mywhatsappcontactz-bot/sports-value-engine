// src/data-bridge/proballersFixturesSync.ts
//
// Bridges proballersScraper.ts into the matches table, for the
// tipscanner-only path — mirrors baseballFixturesSync.ts's structure
// closely (same duplicate-row protection, same Cleaner -> Validator
// pipeline), which itself mirrors basketballFixturesSync.ts.
//
// IMPORTANT: sport stays 'basketball' for these leagues, NOT a new sport
// value — modelBasketball() branches internally by match.league (same
// pattern already proven by applyBasketballIsotonicCalibration's
// isNba = league === 'NBA' check) to apply the corrected formula +
// PROBALLERS_ISOTONIC_BLOCKS for these leagues, while leaving NBA/WNBA's
// existing formula/calibration completely untouched.
//
// UNVERIFIED — same caution baseballFixturesSync.ts flags for itself:
// Cleaner/Validator's exact handling hasn't been directly confirmed for
// this new data source. Test end-to-end against a real fixture before
// trusting in production.
//
// FIX (2026-08-18): form and H2H now use SEPARATE game histories — see
// proballersStatsMapper.ts's header comment for the full reasoning.
// Short version: a brand-new season (confirmed live via ACB — 0 games
// found, correctly rejected by the validator with "Home form too small:
// 0 games") should NOT silently borrow last season's games as "recent
// form" (that's the exact bug scrape.ts's football fix addressed
// earlier today) — but H2H, which is about how two specific teams
// historically match up rather than a claim about current form, looks
// back across H2H_LOOKBACK_SEASONS prior seasons in addition to the
// current one, since two teams may only meet a handful of times per
// season.

import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import {
  fetchUpcomingGames,
  fetchLeagueSchedule,
  ProballersGame,
  ProballersUpcomingGame,
  PROBALLERS_LEAGUE_MAP,
} from '../scrapers/basketball/Proballersscraper';
import { proballersStatsToRawStats } from './proballersStatsMapper';

// UPDATED 2026-08-18: this list previously predated the cheerio parser
// fix (proballersScraper.ts's parseSchedule/parseUpcomingSchedule used
// to hang on catastrophic regex backtracking, which made several
// leagues LOOK broken — 0 games, timeouts — when they were actually
// fine). Replaced with the real exclusion list confirmed via
// basketballBacktest1.ts's 2026-08-18 run (post-fix, post-HOME_COURT_BIAS
// tuning), same list used to build proballersIsotonicFit.ts's training
// set — all three files now agree.
const EXCLUDED_LEAGUES = [
  'Liga A - Argentina',       // 57.5% hit rate, n=40
  'BSN - Puerto Rico',        // 64.3% hit rate, n=28
  'NBL - Australia',          // 66.7% hit rate, n=12
  'Philippines - PBA',        // stuck on stale 2011-12 data — no working current-season URL found as of 2026-08-17
];

const ACTIVE_LEAGUES = Object.keys(PROBALLERS_LEAGUE_MAP).filter(
  name => !EXCLUDED_LEAGUES.includes(name)
);

// How many seasons PRIOR to the current one to include when building
// H2H history. 2 was chosen as a starting point — enough to likely
// catch a few meetings between two specific teams across a reasonable
// window, without reaching so far back that "recent H2H" becomes
// misleading. Not backtested/tuned — a reasoned default, revisit if H2H
// sample sizes still look too thin or too stale in practice.
const H2H_LOOKBACK_SEASONS = 2;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Fetches the current season's games (undefined season arg — same
// "current" convention every other Proballers script in this codebase
// uses) plus H2H_LOOKBACK_SEASONS prior seasons, deduplicated by gameId.
async function fetchMultiSeasonHistory(leagueName: string): Promise<ProballersGame[]> {
  const now = new Date();
  const currentYear = now.getFullYear();
  const seasonArgs: (number | undefined)[] = [undefined];
  for (let i = 1; i <= H2H_LOOKBACK_SEASONS; i++) {
    seasonArgs.push(currentYear - i);
  }

  const allGames: ProballersGame[] = [];
  for (const season of seasonArgs) {
    try {
      const games = await fetchLeagueSchedule(leagueName, season);
      allGames.push(...games);
    } catch (err: any) {
      logger.warn('[ProballersFixturesSync] Multi-season H2H fetch failed for one season — continuing with what was found', {
        leagueName,
        season: season ?? 'current',
        error: err.message,
      });
    }
  }

  const seen = new Set<number>();
  return allGames.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
}

export interface ProballersFixturesSyncResult {
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

    if (sameOrientation || swappedOrientation) return m.id;
  }

  return null;
}

function buildStartTime(date: string, time: string | null): string {
  if (!time) return `${date}T12:00:00.000Z`;

  const m = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return `${date}T12:00:00.000Z`;

  let [, hourStr, minStr, ampm] = m;
  let hour = parseInt(hourStr, 10);
  if (ampm.toUpperCase() === 'PM' && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === 'AM' && hour === 12) hour = 0;

  return `${date}T${String(hour).padStart(2, '0')}:${minStr}:00.000Z`;
}

export async function syncOneLeague(leagueName: string): Promise<ProballersFixturesSyncResult> {
  const result: ProballersFixturesSyncResult = {
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

  let upcoming: ProballersUpcomingGame[];
  let currentSeasonGames: ProballersGame[];
  let h2hHistoryGames: ProballersGame[];
  try {
    [upcoming, currentSeasonGames, h2hHistoryGames] = await Promise.all([
      fetchUpcomingGames(leagueName),
      fetchLeagueSchedule(leagueName), // CURRENT SEASON ONLY — form/PPG/fatigue
      fetchMultiSeasonHistory(leagueName), // current + prior seasons — H2H only
    ]);
  } catch (err: any) {
    logger.error('[ProballersFixturesSync] Failed to fetch league data', { leagueName, error: err.message });
    result.errors++;
    return result;
  }

  result.fixturesFound = upcoming.length;
  console.log(`[DEBUG PROBALLERS-SYNC] ${leagueName}: ${upcoming.length} upcoming fixtures, ${currentSeasonGames.length} current-season games, ${h2hHistoryGames.length} multi-season H2H pool`);

  for (const fixture of upcoming) {
    try {
      let matchId = findExistingMatch(repo, fixture.homeTeam, fixture.awayTeam, fixture.date);

      if (matchId) {
        result.matchesReused++;
      } else {
        const externalId = `proballers-${normalizeTeamName(leagueName)}-${fixture.date}-${normalizeTeamName(fixture.homeTeam)}-${normalizeTeamName(fixture.awayTeam)}`;

        matchId = repo.upsertMatch({
          sport: 'basketball',
          league: leagueName,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          startTime: buildStartTime(fixture.date, fixture.time),
          status: 'upcoming',
          externalId,
          source: 'proballers-fixtures-free',
        });
        result.matchesCreated++;
      }

      const rawStats = proballersStatsToRawStats(
        matchId,
        fixture.homeTeam,
        fixture.awayTeam,
        currentSeasonGames,
        h2hHistoryGames,
        fixture.date,
      );

      const cleanedStats = cleaner.cleanStats(rawStats, matchId, 'basketball');
      if (!cleanedStats) {
        logger.warn('[ProballersFixturesSync] cleanStats returned null', {
          league: leagueName,
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        });
        result.statsRejected++;
        continue;
      }

      const statsValidation = validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        logger.warn('[ProballersFixturesSync] Stats failed validation — skipping', {
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
      logger.error('[ProballersFixturesSync] Failed to sync fixture', {
        league: leagueName,
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }
  }

  console.log(`[DEBUG PROBALLERS-SYNC] ${leagueName} complete:`, result);
  return result;
}

export async function syncAllProballersFixtures(): Promise<ProballersFixturesSyncResult[]> {
  const results: ProballersFixturesSyncResult[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    const result = await syncOneLeague(leagueName);
    results.push(result);
    await sleep(1000);
  }

  logger.info('[ProballersFixturesSync] All leagues complete', {
    totalFixtures: results.reduce((s, r) => s + r.fixturesFound, 0),
    totalCreated: results.reduce((s, r) => s + r.matchesCreated, 0),
    totalReused: results.reduce((s, r) => s + r.matchesReused, 0),
    totalStatsSaved: results.reduce((s, r) => s + r.statsSaved, 0),
    totalErrors: results.reduce((s, r) => s + r.errors, 0),
  });

  return results;
}