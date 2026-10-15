import { ShotsLeagueData, findShotsTeam } from './cardsSotSeasonTotals';
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

  if (!Number.isFinite(expected.homeCardsAvg) || expected.homeCardsAvg < 0.3 || expected.homeCardsAvg > 6 || !Number.isFinite(expected.awayCardsAvg) || expected.awayCardsAvg < 0.3 || expected.awayCardsAvg > 6) {
    logger.warn('[CardsAggregator] Implausible expected cards — not saved', { matchId, homeTeamName, awayTeamName, ...expected });
    return null;
  }
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

  if (!Number.isFinite(expected.homeSotAvg) || expected.homeSotAvg < 1 || expected.homeSotAvg > 12 || !Number.isFinite(expected.awaySotAvg) || expected.awaySotAvg < 1 || expected.awaySotAvg > 12) {
    logger.warn('[SotAggregator] Implausible expected SOT — not saved', { matchId, homeTeamName, awayTeamName, ...expected });
    return null;
  }
  repository.updateSotAvg(matchId, expected.homeSotAvg, expected.awaySotAvg);

  logger.info('[SotAggregator] Wrote expected SOT', {
    matchId,
    homeTeamName,
    awayTeamName,
    ...expected,
  });

  return expected;
}

export async function aggregateShotsForMatch(
  repository: Repository, leagueData: ShotsLeagueData, matchId: string,
  leagueName: string, homeTeamName: string, awayTeamName: string,
): Promise<{ homeShotsAvg: number; awayShotsAvg: number } | null> {
  const h = findShotsTeam(leagueData, homeTeamName);
  const a = findShotsTeam(leagueData, awayTeamName);
  if (!h || !a) {
    logger.warn('[ShotsAggregator] Could not match team(s) to shots data', { leagueName, matchId, homeTeamName, awayTeamName, homeMatched: !!h, awayMatched: !!a });
    return null;
  }
  const ts = [...leagueData.teams.values()];
  const mean = (f: (t: typeof ts[number]) => number) => ts.reduce((s, t) => s + f(t), 0) / ts.length;
  const lHF = mean(t => t.homeShotsFor), lHA = mean(t => t.homeShotsAgainst);
  const lAF = mean(t => t.awayShotsFor), lAA = mean(t => t.awayShotsAgainst);
  if (!(lHF > 0 && lHA > 0 && lAF > 0 && lAA > 0)) return null;
  const homeShotsAvg = lHF * (h.homeShotsFor / lHF) * (a.awayShotsAgainst / lAA);
  const awayShotsAvg = lAF * (a.awayShotsFor / lAF) * (h.homeShotsAgainst / lHA);
  const bad = (v: number) => !Number.isFinite(v) || v < 4 || v > 22;
  if (bad(homeShotsAvg) || bad(awayShotsAvg)) {
    logger.warn('[ShotsAggregator] Implausible expected shots - not saved', { matchId, homeTeamName, awayTeamName, homeShotsAvg, awayShotsAvg });
    return null;
  }
  repository.updateShotsAvg(matchId, homeShotsAvg, awayShotsAvg);
  logger.info('[ShotsAggregator] Wrote expected shots', { matchId, homeTeamName, awayTeamName, homeShotsAvg, awayShotsAvg });
  return { homeShotsAvg, awayShotsAvg };
}
