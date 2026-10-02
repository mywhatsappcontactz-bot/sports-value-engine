// src/core/engine/standingsAggregator.ts
//
// Computes home/away table position for both sides of a match from
// fcstats.com's home/away-split standings tables, and writes the result
// into stats.additionalContext (NOT a dedicated column, since
// additionalContext is where cross-cutting model inputs live — see
// parkFactor/bullpenFactor/homeStrengthFactor in probabilityModel.ts for
// the same pattern).
//
// DESIGN: uses the HOME variant of standings for the home team's rank,
// and the AWAY variant for the away team's rank — NOT the combined Total
// table for both. This matches how computeFootballLambdas already splits
// every input by venue (homeVenueForm/awayVenueForm), so table position
// stays consistent with the rest of the model's venue-aware design
// rather than mixing an overall rank into a venue-split system.
//
// UNVALIDATED: this is a new signal with no isotonic fit or backtest
// behind it yet — same bootstrap status corners/cards/SOT were in before
// their own fits existed. Wiring this into eloStrengthRatio/lambda
// computation (probabilityModel.ts) is a SEPARATE step after this
// aggregator is confirmed working — this file only produces and stores
// the raw rank data, it does not yet change any tip.

import {
  fetchLeagueStandings,
  findStandingsRow,
  computeStandingsRank,
  StandingsRow,
} from '../../scrapers/football/fcStatsScraper';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

export interface TablePositionResult {
  homeTablePosition: number;
  awayTablePosition: number;
  leagueTeamCount: number;
}

/**
 * Fetches home-table standings for the home team and away-table standings
 * for the away team, resolves each team's row, computes rank within its
 * respective table, and writes homeTablePosition/awayTablePosition/
 * leagueTeamCount into stats.additionalContext.
 *
 * Returns null (and logs a warning) if either team can't be resolved, or
 * if standings data isn't available for this league (fcstats' league
 * coverage is narrower than soccerstats' — see FCSTATS_LEAGUE_MAP).
 */
export async function aggregateTablePositionForMatch(
  repository: Repository,
  matchId: string,
  leagueName: string,
  homeTeamName: string,
  awayTeamName: string
): Promise<TablePositionResult | null> {
  const homeStandings = await fetchLeagueStandings(leagueName, 'home');
  const awayStandings = await fetchLeagueStandings(leagueName, 'away');

  if (!homeStandings || !awayStandings) {
    logger.warn('[StandingsAggregator] No standings data for league', {
      leagueName,
      matchId,
      homeStandingsFound: !!homeStandings,
      awayStandingsFound: !!awayStandings,
    });
    return null;
  }

  const homeRow = findStandingsRow(homeStandings.rows, homeTeamName);
  const awayRow = findStandingsRow(awayStandings.rows, awayTeamName);

  if (!homeRow || !awayRow) {
    logger.warn('[StandingsAggregator] Could not match team(s) to standings data', {
      leagueName,
      matchId,
      homeTeamName,
      awayTeamName,
      homeMatched: !!homeRow,
      awayMatched: !!awayRow,
    });
    return null;
  }

  const homeRankMap = computeStandingsRank(homeStandings.rows);
  const awayRankMap = computeStandingsRank(awayStandings.rows);

  const homeTablePosition = homeRankMap.get(normalizeForLookup(homeRow.teamName));
  const awayTablePosition = awayRankMap.get(normalizeForLookup(awayRow.teamName));

  if (homeTablePosition === undefined || awayTablePosition === undefined) {
    // Shouldn't happen — homeRow/awayRow came from the same rows array
    // computeStandingsRank just ranked — but fail safe rather than write
    // a partial/undefined result.
    logger.warn('[StandingsAggregator] Rank lookup failed after row match — this indicates a bug', {
      matchId,
      homeTeamName: homeRow.teamName,
      awayTeamName: awayRow.teamName,
    });
    return null;
  }

  const result: TablePositionResult = {
    homeTablePosition,
    awayTablePosition,
    leagueTeamCount: homeStandings.rows.length,
  };

  // NOTE: assumes Repository has (or will have) a method to merge keys
  // into the JSON additionalContext blob, distinct from the dedicated-
  // column update methods (updateCornersAvg, updateGoalsAvg) used
  // elsewhere. If this method doesn't exist yet, it needs to be added —
  // flagged here rather than guessed at without seeing repository.ts.
   repository.updateTablePosition(
    matchId,
    result.homeTablePosition,
    result.awayTablePosition,
    result.leagueTeamCount
  );

  logger.info('[StandingsAggregator] Wrote table position', {
    matchId,
    homeTeamName: homeRow.teamName,
    awayTeamName: awayRow.teamName,
    ...result,
  });

  return result;
}

// Local copy of the same normalize used inside fcStatsScraper.ts's
// computeStandingsRank keys — duplicated rather than imported since
// fcStatsScraper.ts doesn't currently export its internal normalize().
// If team-name mismatches show up in testing, this is the first place to
// check for drift between this copy and the scraper's own.
function normalizeForLookup(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}