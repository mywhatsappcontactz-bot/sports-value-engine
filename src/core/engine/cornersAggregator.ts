// src/core/engine/cornersAggregator.ts
//
// Computes expected corners (home/away) for a match from soccerstats.com
// team-level season data, using the same attack-strength x defense-weakness
// x league-average structure as the goals model (computeFootballLambdas).
//
// SHRINKAGE — pulls each team's season-long venue-specific corners toward
// the league average, weighted by homeGp/awayGp (see applyShrinkage).
//
// RECENCY WEIGHTING (this pass) — for the 8 leagues confirmed to expose
// per-match corner data on soccerstats.com (see LEAGUES_WITH_MATCH_CORNERS
// below), ALSO fetches each team's last-5 real match results via
// soccerStatsFormScraper.ts / soccerStatsMatchCornersScraper.ts, computes
// a 0.85^i recency-weighted figure, and blends it with the shrinkage-
// adjusted season figure — see blendSeasonAndRecency. For the other 10
// leagues, this step is skipped entirely and behavior is unchanged from
// the shrinkage-only version.
//
// UNVALIDATED: recency weighting is a brand-new, unbacktested signal as
// of this change — same status shrinkage was in before it shipped, and
// the corners isotonic tables (CORNERS_TOTALS_ISOTONIC_BLOCKS,
// CORNERS_WINNER_ISOTONIC_BLOCKS, TEAM_CORNERS_*_BLOCKS in
// probabilityModel.ts) were all fit against shrinkage-only inputs. This
// change makes those tables stale again for the 8 leagues where recency
// weighting actually fires — same class of staleness this file's
// shrinkage change caused before its own refit. A recalibration pass
// covering all three corners markets will be needed again once this is
// live in production, same pattern as before.
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
import { fetchRecentForm } from '../../scrapers/football/soccerStatsFormScraper';
import { computeRecencyWeightedCorners } from './cornersRecencyWeighting';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

// ─── LEAGUES WITH PER-MATCH CORNER DATA ────────────────────────────────
// Confirmed via direct per-league check against real pmatch.asp report
// pages (2026-09, see conversation) — these 8 leagues have a real
// "Corners" result block on their match report pages; the other 10 in
// SOCCERSTATS_LEAGUE_MAP do not (checked: 2. Bundesliga, Turkey,
// Scotland, Belgium, Russia, Poland, Switzerland, Ukraine, MLS — all
// confirmed NO_CORNERS_BLOCK). Uses the same league-name keys as
// SOCCERSTATS_LEAGUE_MAP / FCSTATS_LEAGUE_MAP for consistency.
export const LEAGUES_WITH_MATCH_CORNERS = new Set<string>([
  'EPL',
  'Championship',
  'League 1',
  'League 2',
  'La Liga - Spain',
  'La Liga 2 - Spain',
  'Bundesliga - Germany',
  'Serie A - Italy',
  'Netherlands - Eredivisie',
]);

// soccerStatsFormScraper.ts's fetchRecentForm takes a soccerstats.com
// LEAGUE CODE (e.g. 'england'), not the display name used in
// LEAGUES_WITH_MATCH_CORNERS / SOCCERSTATS_LEAGUE_MAP — this maps
// between them. Mirrors SOCCERSTATS_LEAGUE_MAP's values for the 8
// covered leagues specifically.
const LEAGUE_NAME_TO_FORM_CODE: Record<string, string> = {
  'EPL': 'england',
  'Championship': 'england2',
  'League 1': 'england3',
  'League 2': 'england4',
  'La Liga - Spain': 'spain',
  'La Liga 2 - Spain': 'spain2',
  'Bundesliga - Germany': 'germany',
  'Serie A - Italy': 'italy',
  'Netherlands - Eredivisie': 'netherlands',
};

interface LeagueCornerAverages {
  avgHomeCornersWon: number;
  avgHomeCornersConceded: number;
  avgAwayCornersWon: number;
  avgAwayCornersConceded: number;
}

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

// ─── SHRINKAGE ────────────────────────────────────────────────────────────

const SHRINKAGE_PRIOR_GAMES = 4;

function shrinkTowardLeagueAvg(observed: number, gamesPlayed: number, leagueAvg: number): number {
  if (gamesPlayed <= 0) return leagueAvg;
  const weight = gamesPlayed / (gamesPlayed + SHRINKAGE_PRIOR_GAMES);
  return weight * observed + (1 - weight) * leagueAvg;
}

interface ShrunkTeamCorners {
  homeCornersFor: number;
  homeCornersAgainst: number;
  awayCornersFor: number;
  awayCornersAgainst: number;
}

function applyShrinkage(stats: CornerTeamStats, leagueAvg: LeagueCornerAverages): ShrunkTeamCorners {
  return {
    homeCornersFor: shrinkTowardLeagueAvg(stats.homeCornersFor, stats.homeGp, leagueAvg.avgHomeCornersWon),
    homeCornersAgainst: shrinkTowardLeagueAvg(stats.homeCornersAgainst, stats.homeGp, leagueAvg.avgHomeCornersConceded),
    awayCornersFor: shrinkTowardLeagueAvg(stats.awayCornersFor, stats.awayGp, leagueAvg.avgAwayCornersWon),
    awayCornersAgainst: shrinkTowardLeagueAvg(stats.awayCornersAgainst, stats.awayGp, leagueAvg.avgAwayCornersConceded),
  };
}

// ─── RECENCY BLEND ────────────────────────────────────────────────────
//
// How much the recency-weighted figure can influence the final number,
// scaled by how much real recent-match data was actually obtained (e.g.
// 5/5 matches fetched successfully trusts recency more than 2/5).
// RECENCY_MAX_WEIGHT caps this even at perfect data confidence — the
// season-long shrinkage-adjusted average always retains at least half
// the weight, since it reflects a much larger sample and whole-season
// context a 5-match window can't fully replace. UNVALIDATED constant —
// a starting assumption, not backtested; revisit once real hit-rate data
// exists for the leagues where recency weighting is live.
const RECENCY_MAX_WEIGHT = 0.5;

function blendSeasonAndRecency(
  seasonAdjusted: number,
  recencyValue: number | null,
  matchesUsed: number,
  matchesAttempted: number
): number {
  if (recencyValue === null || matchesAttempted === 0) return seasonAdjusted;

  const dataConfidence = matchesUsed / matchesAttempted; // 0..1
  const recencyWeight = dataConfidence * RECENCY_MAX_WEIGHT;

  return seasonAdjusted * (1 - recencyWeight) + recencyValue * recencyWeight;
}

interface ExpectedCorners {
  homeCornersAvg: number;
  awayCornersAvg: number;
}

function computeExpectedCorners(
  homeStats: CornerTeamStats,
  awayStats: CornerTeamStats,
  leagueAvg: LeagueCornerAverages
): ExpectedCorners {
  const homeShrunk = applyShrinkage(homeStats, leagueAvg);
  const awayShrunk = applyShrinkage(awayStats, leagueAvg);

  const homeAttackStrength = leagueAvg.avgHomeCornersWon > 0
    ? homeShrunk.homeCornersFor / leagueAvg.avgHomeCornersWon : 1;
  const awayDefenseWeakness = leagueAvg.avgAwayCornersConceded > 0
    ? awayShrunk.awayCornersAgainst / leagueAvg.avgAwayCornersConceded : 1;

  const awayAttackStrength = leagueAvg.avgAwayCornersWon > 0
    ? awayShrunk.awayCornersFor / leagueAvg.avgAwayCornersWon : 1;
  const homeDefenseWeakness = leagueAvg.avgHomeCornersConceded > 0
    ? homeShrunk.homeCornersAgainst / leagueAvg.avgHomeCornersConceded : 1;

  const homeCornersAvg = leagueAvg.avgHomeCornersWon * homeAttackStrength * awayDefenseWeakness;
  const awayCornersAvg = leagueAvg.avgAwayCornersWon * awayAttackStrength * homeDefenseWeakness;

  return { homeCornersAvg, awayCornersAvg };
}

/**
 * If this league is one of the 8 confirmed to have per-match corner data,
 * fetches recent form + recency-weighted corners for one team and blends
 * it into the given season-adjusted figure. Returns the original value
 * unchanged for any league not in LEAGUES_WITH_MATCH_CORNERS, or if the
 * recency fetch fails/returns nothing usable — this is purely additive,
 * never a regression versus the season-only path.
 */
async function applyRecencyIfSupported(
  leagueName: string,
  teamName: string,
  seasonAdjusted: number
): Promise<number> {
  if (!LEAGUES_WITH_MATCH_CORNERS.has(leagueName)) {
    return seasonAdjusted;
  }

  const formCode = LEAGUE_NAME_TO_FORM_CODE[leagueName];
  if (!formCode) {
    logger.warn('[CornersAggregator] League in LEAGUES_WITH_MATCH_CORNERS but missing form code mapping', { leagueName });
    return seasonAdjusted;
  }

  try {
    const recentResults = await fetchRecentForm(formCode, teamName, 5);
    const recency = await computeRecencyWeightedCorners(recentResults);

    if (!recency) return seasonAdjusted;

    return blendSeasonAndRecency(seasonAdjusted, recency.value, recency.matchesUsed, recency.matchesAttempted);
  } catch (err: any) {
    logger.warn('[CornersAggregator] Recency weighting failed — falling back to season-only', {
      leagueName,
      teamName,
      error: err.message,
    });
    return seasonAdjusted;
  }
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
): Promise<{ homeCornersAvg: number; awayCornersAvg: number } | null> {
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
  const seasonAdjusted = computeExpectedCorners(homeStats, awayStats, leagueAvg);

  const homeCornersAvg = await applyRecencyIfSupported(leagueName, homeTeamName, seasonAdjusted.homeCornersAvg);
  const awayCornersAvg = await applyRecencyIfSupported(leagueName, awayTeamName, seasonAdjusted.awayCornersAvg);

  const expected = { homeCornersAvg, awayCornersAvg };

  logger.info('[CornersAggregator] Wrote expected corners', {
    matchId,
    homeTeamName,
    awayTeamName,
    homeGp: homeStats.homeGp,
    awayGp: awayStats.awayGp,
    recencyApplied: LEAGUES_WITH_MATCH_CORNERS.has(leagueName),
    ...expected,
  });

  repository.updateCornersAvg(matchId, expected.homeCornersAvg, expected.awayCornersAvg);

  return expected;
}