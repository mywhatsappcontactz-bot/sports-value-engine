// src/data-bridge/soccerStatsFixturesSync.ts
//
// Bridges soccerStatsFixturesScraper.ts output into the matches table,
// for leagues TheOddsAPI's free tier doesn't cover (Spain, Germany,
// Turkey, Netherlands — see SPORT_KEYS.football in oddsClient.ts vs
// SOCCERSTATS_LEAGUE_MAP in soccerStatsCornersScraper.ts for the gap).
//
// source: 'soccerstats-fixtures' distinguishes these from TheOddsAPI-
// sourced matches (source: 'theoddsapi') — upsertMatch's dedup key is
// (externalId, source), so this never collides with odds-API matches
// even for the 6 leagues both sources happen to cover.
//
// Run this alongside (not instead of) the existing realFetcher.ts
// pipeline — this only ever creates matches + triggers corners AND goals
// aggregation; it never touches odds or value bets (these matches have
// no odds rows, so valueEngine.ts's odds check always skips them —
// tip-scanner-only by construction).

import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { fetchUpcomingFixtures } from '../scrapers/football/soccerStatsFixturesScraper';
import { aggregateCornersForMatch } from '../core/engine/cornersAggregator';
import { aggregateGoalsForMatch } from '../core/engine/goalsAggregator';

// Only leagues TheOddsAPI's free tier does NOT cover — see SPORT_KEYS.football
// in oddsClient.ts. Deliberately excludes EPL/Championship/League1/League2/
// Italy/Scotland: those already get a matches row via realFetcher.ts, and
// upsertMatch's (externalId, source) dedup means a different source here
// would create a SEPARATE duplicate row for the same real fixture — which,
// since tipScanner.ts no longer gates on odds, would produce a duplicate
// corners tip plus a low-quality goals tip built on empty stub stats,
// standing right next to the real one. Only sync leagues with no existing
// match-creation path at all.
const LEAGUE_CODE_TO_NAME: Record<string, string> = {
  spain: 'La Liga - Spain',
  spain2: 'La Liga 2 - Spain',
  germany: 'Bundesliga - Germany',
  germany2: '2. Bundesliga - Germany',
  turkey: 'Turkey',
  netherlands: 'Netherlands - Eredivisie',
};

export interface FixturesSyncResult {
  leagueCode: string;
  fixturesFound: number;
  matchesSaved: number;
  cornersAggregated: number;
  goalsAggregated: number;
  errors: number;
}

export async function syncFixturesForLeague(leagueCode: string): Promise<FixturesSyncResult> {
  const result: FixturesSyncResult = {
    leagueCode,
    fixturesFound: 0,
    matchesSaved: 0,
    cornersAggregated: 0,
    goalsAggregated: 0,
    errors: 0,
  };

  const leagueName = LEAGUE_CODE_TO_NAME[leagueCode];
  if (!leagueName) {
    logger.warn('[FixturesSync] Unknown league code — not in LEAGUE_CODE_TO_NAME map', { leagueCode });
    return result;
  }

  const repo = new Repository(getDb());
  const fixtures = await fetchUpcomingFixtures(leagueCode);
  result.fixturesFound = fixtures.length;

  for (const fixture of fixtures) {
    try {
      const matchId = repo.upsertMatch({
        sport: 'football',
        league: leagueName,
        homeTeam: fixture.homeTeam,
        awayTeam: fixture.awayTeam,
        startTime: fixture.startTime,
        status: 'upcoming',
        externalId: fixture.sourceMatchId,
        source: 'soccerstats-fixtures',
      });
      result.matchesSaved++;

      // Corners aggregation needs a stats row to already exist (see
      // updateCornersAvg in repository.ts) — create a minimal stub with 0.3
      // completeness so corner aggregation can populate stats without prematurely
      // unlocking tipScanner.ts before goals data is present.
      const existingStats = repo.getStats(matchId);
      if (!existingStats) {
        repo.upsertStats({
          matchId,
          sport: 'football',
          h2h: [],
          homeForm: [],
          awayForm: [],
          referee: {},
          situational: {},
          additionalContext: {},
          confidenceFactors: { dataCompleteness: 0.3, h2hSampleSize: 0, formSampleSize: 0 },
        });
      }

      const corners = await aggregateCornersForMatch(
        repo, matchId, leagueName, fixture.homeTeam, fixture.awayTeam,
      );
      if (corners) result.cornersAggregated++;

      // Goals aggregation for the same leagues — uses soccerstats.com's
      // league CODE (e.g. 'spain'). Upon successful aggregation, bump 
      // dataCompleteness to 0.5 to allow tipScanner.ts to process the match.
      try {
        const goals = await aggregateGoalsForMatch(
          repo, matchId, leagueCode, fixture.homeTeam, fixture.awayTeam,
        );
        if (goals) {
          result.goalsAggregated++;
          repo.updateDataCompleteness(matchId, 0.5);
        }
      } catch (goalsErr: any) {
        logger.warn('[FixturesSync] Goals aggregation failed — keeping dataCompleteness at 0.3', {
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          error: goalsErr.message,
        });
      }

    } catch (err: any) {
      result.errors++;
      logger.error('[FixturesSync] Failed to sync fixture', {
        leagueCode,
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }
  }

  logger.info('[FixturesSync] Complete', result);
  return result;
}

export async function syncAllConfiguredLeagues(): Promise<FixturesSyncResult[]> {
  const results: FixturesSyncResult[] = [];
  for (const leagueCode of Object.keys(LEAGUE_CODE_TO_NAME)) {
    const result = await syncFixturesForLeague(leagueCode);
    results.push(result);
    await new Promise((r) => setTimeout(r, 2000)); // be polite to soccerstats.com
  }
  return results;
}