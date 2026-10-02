// src/core/engine/cardsSotAggregator.ts
//
// Computes expected cards and expected shots-on-target (home/away) for a
// match, using the SAME attack-strength x defense-weakness x league-average
// structure as cornersAggregator.ts — no shrinkage, no NB dispersion yet,
// same rationale: added later once real Brier-score data justifies it.
//
// NOTE: Tip-scanner input only, same as corners. Writes to
// stats.homeCardsAvg/awayCardsAvg and stats.homeSotAvg/awaySotAvg, which
// valueEngine.ts never reads — cards/SOT have no influence on value-bet
// edge/Kelly calculations, same isolation as corners.

import {
  CardLeagueData,
  CardTeamStats,
  SotLeagueData,
  SotTeamStats,
  findCardTeam,
  findSotTeam,
} from './cardsSotSeasonTotals';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

// ─── LEAGUE AVERAGES ─────────────────────────────────────────────

interface LeagueCardAverages {
  avgHomeCardsWon: number;
  avgHomeCardsConceded: number;
  avgAwayCardsWon: number;
  avgAwayCardsConceded: number;
}

interface LeagueSotAverages {
  avgHomeSotFor: number;
  avgHomeSotAgainst: number;
  avgAwaySotFor: number;
  avgAwaySotAgainst: number;
}

function computeLeagueCardAverages(leagueData: CardLeagueData): LeagueCardAverages {
  const teams = [...leagueData.teams.values()];
  const n = teams.length;
  if (n === 0) throw new Error('Cannot compute league card averages from empty team list');

  const sum = teams.reduce(
    (acc, t) => ({
      homeFor: acc.homeFor + t.homeCardsFor,
      homeAgainst: acc.homeAgainst + t.homeCardsAgainst,
      awayFor: acc.awayFor + t.awayCardsFor,
      awayAgainst: acc.awayAgainst + t.awayCardsAgainst,
    }),
    { homeFor: 0, homeAgainst: 0, awayFor: 0, awayAgainst: 0 },
  );

  return {
    avgHomeCardsWon: sum.homeFor / n,
    avgHomeCardsConceded: sum.homeAgainst / n,
    avgAwayCardsWon: sum.awayFor / n,
    avgAwayCardsConceded: sum.awayAgainst / n,
  };
}

function computeLeagueSotAverages(leagueData: SotLeagueData): LeagueSotAverages {
  const teams = [...leagueData.teams.values()];
  const n = teams.length;
  if (n === 0) throw new Error('Cannot compute league SOT averages from empty team list');

  const sum = teams.reduce(
    (acc, t) => ({
      homeFor: acc.homeFor + t.homeSotFor,
      homeAgainst: acc.homeAgainst + t.homeSotAgainst,
      awayFor: acc.awayFor + t.awaySotFor,
      awayAgainst: acc.awayAgainst + t.awaySotAgainst,
    }),
    { homeFor: 0, homeAgainst: 0, awayFor: 0, awayAgainst: 0 },
  );

  return {
    avgHomeSotFor: sum.homeFor / n,
    avgHomeSotAgainst: sum.homeAgainst / n,
    avgAwaySotFor: sum.awayFor / n,
    avgAwaySotAgainst: sum.awayAgainst / n,
  };
}

// ─── EXPECTED VALUES ─────────────────────────────────────────────

interface ExpectedCards {
  homeCardsAvg: number;
  awayCardsAvg: number;
}

interface ExpectedSot {
  homeSotAvg: number;
  awaySotAvg: number;
}

function computeExpectedCards(
  homeStats: CardTeamStats,
  awayStats: CardTeamStats,
  leagueAvg: LeagueCardAverages,
): ExpectedCards {
  const homeAttackStrength = leagueAvg.avgHomeCardsWon > 0
    ? homeStats.homeCardsFor / leagueAvg.avgHomeCardsWon : 1;
  const awayDefenseWeakness = leagueAvg.avgAwayCardsConceded > 0
    ? awayStats.awayCardsAgainst / leagueAvg.avgAwayCardsConceded : 1;

  const awayAttackStrength = leagueAvg.avgAwayCardsWon > 0
    ? awayStats.awayCardsFor / leagueAvg.avgAwayCardsWon : 1;
  const homeDefenseWeakness = leagueAvg.avgHomeCardsConceded > 0
    ? homeStats.homeCardsAgainst / leagueAvg.avgHomeCardsConceded : 1;

  return {
    homeCardsAvg: leagueAvg.avgHomeCardsWon * homeAttackStrength * awayDefenseWeakness,
    awayCardsAvg: leagueAvg.avgAwayCardsWon * awayAttackStrength * homeDefenseWeakness,
  };
}

function computeExpectedSot(
  homeStats: SotTeamStats,
  awayStats: SotTeamStats,
  leagueAvg: LeagueSotAverages,
): ExpectedSot {
  const homeAttackStrength = leagueAvg.avgHomeSotFor > 0
    ? homeStats.homeSotFor / leagueAvg.avgHomeSotFor : 1;
  const awayDefenseWeakness = leagueAvg.avgAwaySotAgainst > 0
    ? awayStats.awaySotAgainst / leagueAvg.avgAwaySotAgainst : 1;

  const awayAttackStrength = leagueAvg.avgAwaySotFor > 0
    ? awayStats.awaySotFor / leagueAvg.avgAwaySotFor : 1;
  const homeDefenseWeakness = leagueAvg.avgHomeSotAgainst > 0
    ? homeStats.homeSotAgainst / leagueAvg.avgHomeSotAgainst : 1;

  return {
    homeSotAvg: leagueAvg.avgHomeSotFor * homeAttackStrength * awayDefenseWeakness,
    awaySotAvg: leagueAvg.avgAwaySotFor * awayAttackStrength * homeDefenseWeakness,
  };
}

// ─── PUBLIC API ─────────────────────────────────────────────────

/**
 * Computes expected cards for both sides of a match and writes the result
 * to stats.homeCardsAvg / stats.awayCardsAvg via the repository.
 */
export async function aggregateCardsForMatch(
  repository: Repository,
  leagueData: CardLeagueData,
  matchId: string,
  leagueName: string,
  homeTeamName: string,
  awayTeamName: string,
): Promise<ExpectedCards | null> {
  const homeStats = findCardTeam(leagueData, homeTeamName);
  const awayStats = findCardTeam(leagueData, awayTeamName);

  if (!homeStats || !awayStats) {
    logger.warn('[CardsAggregator] Could not match team(s) to cards data', {
      leagueName,
      matchId,
      homeTeamName,
      awayTeamName,
      homeMatched: !!homeStats,
      awayMatched: !!awayStats,
    });
    return null;
  }

  const leagueAvg = computeLeagueCardAverages(leagueData);
  const expected = computeExpectedCards(homeStats, awayStats, leagueAvg);

  repository.updateCardsAvg(matchId, expected.homeCardsAvg, expected.awayCardsAvg);

  logger.info('[CardsAggregator] Wrote expected cards', {
    matchId,
    homeTeamName,
    awayTeamName,
    ...expected,
  });

  return expected;
}

/**
 * Computes expected SOT for both sides of a match and writes the result
 * to stats.homeSotAvg / stats.awaySotAvg via the repository.
 */
export async function aggregateSotForMatch(
  repository: Repository,
  leagueData: SotLeagueData,
  matchId: string,
  leagueName: string,
  homeTeamName: string,
  awayTeamName: string,
): Promise<ExpectedSot | null> {
  const homeStats = findSotTeam(leagueData, homeTeamName);
  const awayStats = findSotTeam(leagueData, awayTeamName);

  if (!homeStats || !awayStats) {
    logger.warn('[SotAggregator] Could not match team(s) to SOT data', {
      leagueName,
      matchId,
      homeTeamName,
      awayTeamName,
      homeMatched: !!homeStats,
      awayMatched: !!awayStats,
    });
    return null;
  }

  const leagueAvg = computeLeagueSotAverages(leagueData);
  const expected = computeExpectedSot(homeStats, awayStats, leagueAvg);

  repository.updateSotAvg(matchId, expected.homeSotAvg, expected.awaySotAvg);

  logger.info('[SotAggregator] Wrote expected SOT', {
    matchId,
    homeTeamName,
    awayTeamName,
    ...expected,
  });

  return expected;
}