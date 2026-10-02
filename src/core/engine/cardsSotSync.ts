// src/core/engine/cardsSotSync.ts
//
// Orchestrates the full cards/SOT pipeline for one league: fetches every
// team's FBref matchlog (cards + shooting), builds season totals filtered
// to domestic-league-only, and returns CardLeagueData/SotLeagueData ready
// to pass into cardsSotAggregator.ts's aggregateCardsForMatch/
// aggregateSotForMatch for each individual match.
//
// This is the missing piece connecting fbrefCardsSotScraper.ts (per-team
// raw fetch) -> cardsSotSeasonTotals.ts (build + domestic filter) ->
// cardsSotAggregator.ts (per-match expected value) — none of those three
// files call each other; something has to run them in sequence for a
// whole league before individual matches can be aggregated. This is that
// something.
//
// COST WARNING: scrapeAllTeamsCardsAndSot makes 2 requests per team
// (cards + SOT) with a 3.5s delay between each (FBref's own rate limit —
// see fbrefCardsSotScraper.ts). For EPL's ~16 currently-mapped teams,
// that's roughly 32 requests, ~2 minutes minimum. Run this ONCE per
// league per sync cycle, cache the result (leagueData doesn't change
// mid-matchday), and reuse it across every match aggregation for that
// league in the same run — do NOT call this per-match.
//
// SCOPE: TEAM_FBREF_IDS (fbrefCardsSotScraper.ts) now covers 7 leagues —
// EPL, LA_LIGA, BUNDESLIGA, SERIE_A, LIGUE_1, EREDIVISIE, PRIMEIRA_LIGA
// (restructured from a flat, EPL-only map — see conversation). Only
// BUNDESLIGA/SERIE_A/LIGUE_1/EREDIVISIE/PRIMEIRA_LIGA's domestic
// competition strings in DOMESTIC_LEAGUE_COMP_NAMES are still
// UNVERIFIED against a real match row (EPL and LA_LIGA are confirmed).
// Extending to a league still means both its team IDs AND its domestic
// competition name string need to be present and correct — same
// two-piece requirement as before, just more leagues to track now.
//
// leagueName passed into this function must match a key present in
// BOTH TEAM_FBREF_IDS and DOMESTIC_LEAGUE_COMP_NAMES exactly (e.g.
// 'EPL', 'LA_LIGA') — this is now enforced by scrapeAllTeamsCardsAndSot,
// which throws on an unknown leagueKey rather than silently returning
// nothing.
//
// NOT YET CALLED FROM ANYWHERE (confirmed via project-wide search, see
// conversation) — this pipeline is built but not wired into any sync
// task (Scan.ts, quickScan.ts, Tips.ts, etc.) yet. Decide and wire that
// separately once ready; this file alone does not run on its own.

import { scrapeAllTeamsCardsAndSot } from '../../scrapers/football/fbrefCardsSotScraper';
import {
  buildCardSeasonTotals,
  buildSotSeasonTotals,
  CardLeagueData,
  SotLeagueData,
} from './cardsSotSeasonTotals';
import { logger } from '../utils/logger';

export interface CardsSotLeagueData {
  cardData: CardLeagueData;
  sotData: SotLeagueData;
}

/**
 * Fetches and builds domestic-league-filtered cards + SOT season totals
 * for every team in TEAM_FBREF_IDS[leagueName], for the given season.
 * leagueName is used BOTH to select which league's team-ID set to scrape
 * (TEAM_FBREF_IDS[leagueName]) AND which domestic competition filter to
 * apply (DOMESTIC_LEAGUE_COMP_NAMES[leagueName]) — it must be a key
 * present in both maps, e.g. 'EPL', 'LA_LIGA', 'BUNDESLIGA'.
 *
 * Returns null if the scrape produced no usable data at all (e.g. every
 * team fetch failed) — callers should skip cards/SOT aggregation for
 * this league/run rather than pass empty data into
 * cardsSotAggregator.ts, which would throw on an empty team list
 * (computeLeagueCardAverages/computeLeagueSotAverages both throw on n=0).
 */
export async function syncCardsSotForLeague(
  season: string,
  leagueName: string
): Promise<CardsSotLeagueData | null> {
  logger.info('[CardsSotSync] Starting cards/SOT sync', { season, leagueName });

  const allTeamRows = await scrapeAllTeamsCardsAndSot(leagueName, season);

  const teamCount = Object.keys(allTeamRows).length;
  if (teamCount === 0) {
    logger.warn('[CardsSotSync] No team data fetched at all — aborting', { season, leagueName });
    return null;
  }

  // scrapeAllTeamsCardsAndSot returns { cards: MatchLogRow[], sot: MatchLogRow[] }
  // per team — split into two separate TeamRowsMap shapes for
  // buildCardSeasonTotals/buildSotSeasonTotals, which each expect their
  // own single-stat row map.
  const cardRows: Record<string, typeof allTeamRows[string]['cards']> = {};
  const sotRows: Record<string, typeof allTeamRows[string]['sot']> = {};
  for (const [teamSlug, data] of Object.entries(allTeamRows)) {
    cardRows[teamSlug] = data.cards;
    sotRows[teamSlug] = data.sot;
  }

  const cardData = buildCardSeasonTotals(cardRows, leagueName);
  const sotData = buildSotSeasonTotals(sotRows, leagueName);

  logger.info('[CardsSotSync] Cards/SOT sync complete', {
    season,
    leagueName,
    teamsWithCardData: cardData.teams.size,
    teamsWithSotData: sotData.teams.size,
  });

  return { cardData, sotData };
}