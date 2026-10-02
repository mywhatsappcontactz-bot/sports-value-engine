// src/core/engine/cardsSotSeasonTotals.ts

import { MatchLogRow, DOMESTIC_LEAGUE_COMP_NAMES } from '../../scrapers/football/fbrefCardsSotScraper';

// ─── TYPES ─────────────────────────────────────────────────
// Mirrors CornerTeamStats' shape (cornersAggregator.ts) exactly —
// season-total for/against, split by venue, NOT per-match or
// recency-weighted. This is what makes it feed into the same
// attack-strength x defense-weakness formula as corners.

export interface CardTeamStats {
  team: string;
  homeCardsFor: number;
  homeCardsAgainst: number;
  awayCardsFor: number;
  awayCardsAgainst: number;
}

export interface SotTeamStats {
  team: string;
  homeSotFor: number;
  homeSotAgainst: number;
  awaySotFor: number;
  awaySotAgainst: number;
}

export interface CardLeagueData {
  teams: Map<string, CardTeamStats>;
}

export interface SotLeagueData {
  teams: Map<string, SotTeamStats>;
}

// Raw scrape output: one team's own matchlog rows, keyed by team slug.
// Each row has the team's OWN cards/SOT for that match — nothing about
// what they conceded. This is what scrapeAllTeamsCardsAndSot returns.
type TeamRowsMap = Record<string, MatchLogRow[]>;

// ─── DOMESTIC LEAGUE FILTER ─────────────────────────────────────
// Filters a team's raw matchlog rows down to domestic-league matches
// only, using the comp field FBref's matchlogs_for table provides (see
// fbrefCardsSotScraper.ts). Called before building season totals so
// cup/European fixtures (e.g. "FA Community Shield" — confirmed present
// via direct inspection, see conversation) don't get summed alongside
// domestic league matches and inflate a team's season totals with
// harder-fought or differently-officiated competition data.
//
// Fails OPEN (returns rows unfiltered) when this league has no mapping
// in DOMESTIC_LEAGUE_COMP_NAMES, rather than silently dropping every row
// for an unmapped league — the caller should treat an unmapped league's
// totals as unfiltered/uncertain rather than getting an empty result.
function filterToDomesticLeague(rows: MatchLogRow[], leagueName: string): MatchLogRow[] {
  const compName = DOMESTIC_LEAGUE_COMP_NAMES[leagueName];
  if (!compName) {
    return rows;
  }
  return rows.filter((r) => r.comp === compName);
}

// ─── OPPONENT LOOKUP ─────────────────────────────────────────────
// FBref matchlogs don't include the opponent's stats for a given row —
// only the team's own. To get "against" values (cards/SOT the team
// conceded), find the opponent's own matchlog row for the same fixture
// (matched on date) and use THEIR "for" value as this team's "against".
//
// ASSUMPTION: team names in MatchLogRow.opponent match the keys used in
// allTeamRows (both derived from FBref's own naming) closely enough for
// a normalized string match. Verify against real scrape output — FBref
// sometimes abbreviates opponent names differently than squad slugs
// (e.g. "Manchester Utd" vs "Manchester United").
function normalizeTeamName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findOpponentRow(
  allTeamRows: TeamRowsMap,
  opponentName: string,
  date: string,
): MatchLogRow | undefined {
  const normalizedOpponent = normalizeTeamName(opponentName);
  for (const [teamSlug, rows] of Object.entries(allTeamRows)) {
    if (normalizeTeamName(teamSlug) !== normalizedOpponent) continue;
    return rows.find((r) => r.date === date);
  }
  return undefined;
}

// ─── SEASON TOTALS: CARDS ─────────────────────────────────────────
// UPDATED: now requires leagueName, used to filter each team's rows to
// domestic-league-only (see filterToDomesticLeague) before summing.
// Both this team's rows AND the opponent's rows (used for "against"
// values via findOpponentRow) are filtered — otherwise a cup fixture
// could still leak in via the opponent side even after filtering the
// primary team's own rows.
export function buildCardSeasonTotals(allTeamRows: TeamRowsMap, leagueName: string): CardLeagueData {
  const teams = new Map<string, CardTeamStats>();

  const filteredAllTeamRows: TeamRowsMap = {};
  for (const [teamSlug, rows] of Object.entries(allTeamRows)) {
    filteredAllTeamRows[teamSlug] = filterToDomesticLeague(rows, leagueName);
  }

  for (const [teamSlug, rows] of Object.entries(filteredAllTeamRows)) {
    const stats: CardTeamStats = {
      team: teamSlug,
      homeCardsFor: 0,
      homeCardsAgainst: 0,
      awayCardsFor: 0,
      awayCardsAgainst: 0,
    };

    for (const row of rows) {
      const cardsFor = (row.cardsYellow ?? 0) + (row.cardsRed ?? 0);
      const oppRow = findOpponentRow(filteredAllTeamRows, row.opponent, row.date);
      const cardsAgainst = oppRow ? (oppRow.cardsYellow ?? 0) + (oppRow.cardsRed ?? 0) : undefined;

      if (row.venue === 'Home') {
        stats.homeCardsFor += cardsFor;
        if (cardsAgainst !== undefined) stats.homeCardsAgainst += cardsAgainst;
      } else if (row.venue === 'Away') {
        stats.awayCardsFor += cardsFor;
        if (cardsAgainst !== undefined) stats.awayCardsAgainst += cardsAgainst;
      }
    }

    teams.set(teamSlug, stats);
  }

  return { teams };
}

// ─── SEASON TOTALS: SOT ─────────────────────────────────────────────
// UPDATED: same domestic-league filtering as buildCardSeasonTotals above.
export function buildSotSeasonTotals(allTeamRows: TeamRowsMap, leagueName: string): SotLeagueData {
  const teams = new Map<string, SotTeamStats>();

  const filteredAllTeamRows: TeamRowsMap = {};
  for (const [teamSlug, rows] of Object.entries(allTeamRows)) {
    filteredAllTeamRows[teamSlug] = filterToDomesticLeague(rows, leagueName);
  }

  for (const [teamSlug, rows] of Object.entries(filteredAllTeamRows)) {
    const stats: SotTeamStats = {
      team: teamSlug,
      homeSotFor: 0,
      homeSotAgainst: 0,
      awaySotFor: 0,
      awaySotAgainst: 0,
    };

    for (const row of rows) {
      const sotFor = row.shotsOnTarget ?? 0;
      const oppRow = findOpponentRow(filteredAllTeamRows, row.opponent, row.date);
      const sotAgainst = oppRow?.shotsOnTarget;

      if (row.venue === 'Home') {
        stats.homeSotFor += sotFor;
        if (sotAgainst !== undefined) stats.homeSotAgainst += sotAgainst;
      } else if (row.venue === 'Away') {
        stats.awaySotFor += sotFor;
        if (sotAgainst !== undefined) stats.awaySotAgainst += sotAgainst;
      }
    }

    teams.set(teamSlug, stats);
  }

  return { teams };
}

// ─── TEAM FINDER ─────────────────────────────────────────────────
// Mirrors findCornersTeam's role — normalized lookup so callers don't
// need to know FBref's exact slug casing/formatting.
export function findCardTeam(data: CardLeagueData, teamName: string): CardTeamStats | undefined {
  const normalized = normalizeTeamName(teamName);
  for (const [slug, stats] of data.teams) {
    if (normalizeTeamName(slug) === normalized) return stats;
  }
  return undefined;
}

export function findSotTeam(data: SotLeagueData, teamName: string): SotTeamStats | undefined {
  const normalized = normalizeTeamName(teamName);
  for (const [slug, stats] of data.teams) {
    if (normalizeTeamName(slug) === normalized) return stats;
  }
  return undefined;
}