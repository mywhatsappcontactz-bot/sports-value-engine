// src/core/engine/cornersAggregator.ts
//
// Computes expected corners (home/away) for a match from soccerstats.com
// team-level season data, using the same attack-strength x defense-weakness
// x league-average structure as the goals model (computeFootballLambdas),
// but WITHOUT shrinkage or Negative Binomial dispersion yet — those come
// later, once real Brier-score data justifies the added complexity.
//
// NOTE: This is for the prediction/tip scanner only. It writes to
// stats.homeCornersAvg/awayCornersAvg, which valueEngine.ts and
// computeFootballLambdas never read — corners has no influence on
// value-bet edge/Kelly calculations.

import {
  fetchCornersData,
  findCornersTeam,
  CornerLeagueData,
  CornerTeamStats,
} from '../../scrapers/football/soccerStatsCornersScraper';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

interface LeagueCornerAverages {
  avgHomeCornersWon: number;
  avgHomeCornersConceded: number;
  avgAwayCornersWon: number;
  avgAwayCornersConceded: number;
}

// League-wide averages, computed by averaging every team's home/away
// for/against figures across the league table. Needed as the denominator
// for attack-strength / defense-weakness ratios.
function computeLeagueAverages(leagueData: CornerLeagueData): LeagueCornerAverages {
  const teams = [...leagueData.teams.values()];
  const n = teams.length;

  if (n === 0) {
    throw new Error('Cannot compute league averages from empty team list');
  }

  const sum = teams.reduce(
    (acc, t) => ({
      homeFor: acc.homeFor + t.homeCornersFor,
      homeAgainst: acc.homeAgainst + t.homeCornersAgainst,
      awayFor: acc.awayFor + t.awayCornersFor,
      awayAgainst: acc.awayAgainst + t.awayCornersAgainst,
    }),
    { homeFor: 0, homeAgainst: 0, awayFor: 0, awayAgainst: 0 }
  );

  return {
    avgHomeCornersWon: sum.homeFor / n,
    avgHomeCornersConceded: sum.homeAgainst / n,
    avgAwayCornersWon: sum.awayFor / n,
    avgAwayCornersConceded: sum.awayAgainst / n,
  };
}

interface ExpectedCorners {
  homeCornersAvg: number; // lambda_home — expected corners won by home team
  awayCornersAvg: number; // lambda_away — expected corners won by away team
}

// Naive Dixon-Coles-style expected corners — no shrinkage, no NB dispersion.
// homeCornersAvg = leagueAvg.homeCornersWon * homeAttackStrength * awayDefenseWeakness
// awayCornersAvg = leagueAvg.awayCornersWon * awayAttackStrength * homeDefe

function computeExpectedCorners(
  homeStats: CornerTeamStats,
  awayStats: CornerTeamStats,
  leagueAvg: LeagueCornerAverages
): ExpectedCorners {
  const homeAttackStrength = leagueAvg.avgHomeCornersWon > 0
    ? homeStats.homeCornersFor / leagueAvg.avgHomeCornersWon : 1;
  const awayDefenseWeakness = leagueAvg.avgAwayCornersConceded > 0
    ? awayStats.awayCornersAgainst / leagueAvg.avgAwayCornersConceded : 1;

  const awayAttackStrength = leagueAvg.avgAwayCornersWon > 0
    ? awayStats.awayCornersFor / leagueAvg.avgAwayCornersWon : 1;
  const homeDefenseWeakness = leagueAvg.avgHomeCornersConceded > 0
    ? homeStats.homeCornersAgainst / leagueAvg.avgHomeCornersConceded : 1;

  const homeCornersAvg = leagueAvg.avgHomeCornersWon * homeAttackStrength * awayDefenseWeakness;
  const awayCornersAvg = leagueAvg.avgAwayCornersWon * awayAttackStrength * homeDefenseWeakness;

  return { homeCornersAvg, awayCornersAvg };
}

/**
 * Fetches corners data for the given league, computes expected corners for
 * both sides of a specific match, and writes the result to stats.homeCornersAvg
 * / stats.awayCornersAvg via the repository. Tip-scanner input only — never
 * touches value_bets or anything valueEngine.ts reads.
 *
 * Returns null (and logs a warning) if either team can't be matched, or if
 * the league has no corners data (e.g. preseason — see Austria/Belgium).
 */
export async function aggregateCornersForMatch(
  repository: Repository,
  matchId: string,
  leagueName: string,
  homeTeamName: string,
  awayTeamName: string
): Promise<ExpectedCorners | null> {
  const leagueData = await fetchCornersData(leagueName);
  if (!leagueData) {
    logger.warn('[CornersAggregator] No corners data for league', { leagueName, matchId });
    return null;
  }

  const homeStats = findCornersTeam(leagueData, homeTeamName);
  const awayStats = findCornersTeam(leagueData, awayTeamName);

  if (!homeStats || !awayStats) {
    logger.warn('[CornersAggregator] Could not match team(s) to corners data', {
      leagueName,
      matchId,
      homeTeamName,
      awayTeamName,
      homeMatched: !!homeStats,
      awayMatched: !!awayStats,
    });
    return null;
  }

  const leagueAvg = computeLeagueAverages(leagueData);
  const expected = computeExpectedCorners(homeStats, awayStats, leagueAvg);

  repository.updateCornersAvg(matchId, expected.homeCornersAvg, expected.awayCornersAvg);

  logger.info('[CornersAggregator] Wrote expected corners', {
    matchId,
    homeTeamName,
    awayTeamName,
    ...expected,
  });

  return expected;
}