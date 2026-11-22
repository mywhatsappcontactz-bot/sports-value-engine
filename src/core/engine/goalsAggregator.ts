// src/core/engine/goalsAggregator.ts
//
// Computes expected goals (home/away) for a match from soccerstats.com
// team-level season data, using the same attack-strength x defense-weakness
// x league-average structure as cornersAggregator.ts.
//
// Scoped to leagues NOT already covered by fcStatsScraper.ts: Spain,
// Spain2, Germany, Germany2, Turkey, Netherlands. Writes to
// stats.additionalContext.homeGoalsAvg/awayGoalsAvg, which
// computeFootballLambdas already reads from — unlike corners, this DOES
// feed into value bet edge/Kelly calculations.
//
// NOTE: naive lambda only — the Dixon-Coles rho correction is applied
// downstream in dixonColesAdjustment.ts, not here. This function's job
// is just producing lambda_home/lambda_away.

import {
  scrapeSoccerStatsGoals,
  TeamGoalsSplit,
} from '../../scrapers/football/soccerStatsGoalsScraper';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

interface LeagueGoalsAverages {
  avgHomeGoalsFor: number;
  avgHomeGoalsAgainst: number;
  avgAwayGoalsFor: number;
  avgAwayGoalsAgainst: number;
}

function computeLeagueAverages(teams: TeamGoalsSplit[]): LeagueGoalsAverages {
  const n = teams.length;

  if (n === 0) {
    throw new Error('Cannot compute league averages from empty team list');
  }

  const sum = teams.reduce(
    (acc, t) => ({
      homeFor: acc.homeFor + t.homeGoalsFor,
      homeAgainst: acc.homeAgainst + t.homeGoalsAgainst,
      awayFor: acc.awayFor + t.awayGoalsFor,
      awayAgainst: acc.awayAgainst + t.awayGoalsAgainst,
    }),
    { homeFor: 0, homeAgainst: 0, awayFor: 0, awayAgainst: 0 }
  );

  return {
    avgHomeGoalsFor: sum.homeFor / n,
    avgHomeGoalsAgainst: sum.homeAgainst / n,
    avgAwayGoalsFor: sum.awayFor / n,
    avgAwayGoalsAgainst: sum.awayAgainst / n,
  };
}

interface ExpectedGoals {
  homeGoalsAvg: number;
  awayGoalsAvg: number;
}

// Shrink small-sample strengths toward 1.0; clamp final lambdas (see conversation).
const GOALS_SHRINK_K = 6;
const GOALS_LAMBDA_MIN = 0.4;
const GOALS_LAMBDA_MAX = 3.0;
function shrinkStrength(ratio: number, gp?: number): number {
  if (!gp || gp <= 0) return ratio;
  return (gp * ratio + GOALS_SHRINK_K) / (gp + GOALS_SHRINK_K);
}
function clampLambda(x: number): number {
  return Math.min(GOALS_LAMBDA_MAX, Math.max(GOALS_LAMBDA_MIN, x));
}

function computeExpectedGoals(
  homeStats: TeamGoalsSplit,
  awayStats: TeamGoalsSplit,
  leagueAvg: LeagueGoalsAverages
): ExpectedGoals {
  const homeAttackStrength = shrinkStrength(leagueAvg.avgHomeGoalsFor > 0
    ? homeStats.homeGoalsFor / leagueAvg.avgHomeGoalsFor : 1, homeStats.homeGp);
  const awayDefenseWeakness = shrinkStrength(leagueAvg.avgAwayGoalsAgainst > 0
    ? awayStats.awayGoalsAgainst / leagueAvg.avgAwayGoalsAgainst : 1, awayStats.awayGp);

  const awayAttackStrength = shrinkStrength(leagueAvg.avgAwayGoalsFor > 0
    ? awayStats.awayGoalsFor / leagueAvg.avgAwayGoalsFor : 1, awayStats.awayGp);
  const homeDefenseWeakness = shrinkStrength(leagueAvg.avgHomeGoalsAgainst > 0
    ? homeStats.homeGoalsAgainst / leagueAvg.avgHomeGoalsAgainst : 1, homeStats.homeGp);

  const homeGoalsAvg = clampLambda(leagueAvg.avgHomeGoalsFor * homeAttackStrength * awayDefenseWeakness);
  const awayGoalsAvg = clampLambda(leagueAvg.avgAwayGoalsFor * awayAttackStrength * homeDefenseWeakness);

  return { homeGoalsAvg, awayGoalsAvg };
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function findGoalsTeam(teams: TeamGoalsSplit[], teamName: string): TeamGoalsSplit | null {
  const key = normalize(teamName);
  for (const t of teams) {
    const tKey = normalize(t.teamName);
    if (tKey === key || tKey.includes(key) || key.includes(tKey)) {
      return t;
    }
  }
  return null;
}

export async function aggregateGoalsForMatch(
  repository: Repository,
  matchId: string,
  leagueCode: string,
  homeTeamName: string,
  awayTeamName: string
): Promise<ExpectedGoals | null> {
  const teams = await scrapeSoccerStatsGoals(leagueCode);
  if (!teams.length) {
    logger.warn('[GoalsAggregator] No goals data for league', { leagueCode, matchId });
    return null;
  }

  const homeStats = findGoalsTeam(teams, homeTeamName);
  const awayStats = findGoalsTeam(teams, awayTeamName);

  if (!homeStats || !awayStats) {
    logger.warn('[GoalsAggregator] Could not match team(s) to goals data', {
      leagueCode,
      matchId,
      homeTeamName,
      awayTeamName,
      homeMatched: !!homeStats,
      awayMatched: !!awayStats,
    });
    return null;
  }

  const leagueAvg = computeLeagueAverages(teams);
  const expected = computeExpectedGoals(homeStats, awayStats, leagueAvg);

  repository.updateGoalsAvg(matchId, expected.homeGoalsAvg, expected.awayGoalsAvg);

  logger.info('[GoalsAggregator] Wrote expected goals', {
    matchId,
    homeTeamName,
    awayTeamName,
    ...expected,
  });

  return expected;
}