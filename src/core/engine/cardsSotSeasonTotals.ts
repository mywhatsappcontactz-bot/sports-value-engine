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
const TEAM_ALIASES: Record<string, string> = {
  kvmechelen: 'mechelen', fczurich: 'zurich', servette: 'servettefc', bscyoungboys: 'youngboys',
  dundeeutd: 'dundeeunited', dundeefc: 'dundee', hearts: 'heartofmidlothian',
  corum: 'yenicorumspor', amedsk: 'amedspor', basaksehir: 'istanbulbasaksehir',
  guimaraes: 'vitoriaguimaraes', vitoriasc: 'vitoriaguimaraes', vguimaraes: 'vitoriaguimaraes',
  newcastleutd: 'newcastleunited', leedsutd: 'leedsunited', manchesterutd: 'manchesterunited', nottmforest: 'nottinghamforest', tottenham: 'tottenhamhotspur', brighton: 'brightonandhovealbion',
  fcbarcelona: 'barcelona', athleticbilbao: 'athleticclub', deportivo: 'deportivoacoruna',
  racing: 'racingsantander', sevillafc: 'sevilla',
  fcaugsburg: 'augsburg', fsvmainz: 'mainz05', paderborn: 'paderborn07', efrankfurt: 'eintrachtfrankfurt', fckoln: 'koln', frankfurt: 'eintrachtfrankfurt', gladbach: 'monchengladbach',
};
function normalizeTeamName(name: string): string {
  const n = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return TEAM_ALIASES[n] ?? n;
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
  // Per-GAME averages. Only games where this team's own value AND the
  // opponent's row both exist are counted, so "for" and "against" share
  // one denominator. Teams with no home or no away games are left out
  // (caller logs "could not match") instead of getting a fake 0.
  const teams = new Map<string, CardTeamStats>();
  const filtered: TeamRowsMap = {};
  for (const [slug, rows] of Object.entries(allTeamRows)) filtered[slug] = filterToDomesticLeague(rows, leagueName);

  for (const [slug, rows] of Object.entries(filtered)) {
    let hF = 0, hA = 0, hN = 0, aF = 0, aA = 0, aN = 0;
    for (const row of rows) {
      if (row.cardsYellow === undefined) continue;
      const opp = findOpponentRow(filtered, row.opponent, row.date);
      if (!opp || opp.cardsYellow === undefined) continue;
      const f = row.cardsYellow + (row.cardsRed ?? 0);
      const ag = opp.cardsYellow + (opp.cardsRed ?? 0);
      if (row.venue === 'Home') { hF += f; hA += ag; hN++; }
      else if (row.venue === 'Away') { aF += f; aA += ag; aN++; }
    }
    if (hN === 0 || aN === 0) continue;
    teams.set(slug, {
      team: slug,
      homeCardsFor: hF / hN, homeCardsAgainst: hA / hN,
      awayCardsFor: aF / aN, awayCardsAgainst: aA / aN,
    });
  }
  return { teams };
}

export function buildSotSeasonTotals(allTeamRows: TeamRowsMap, leagueName: string): SotLeagueData {
  const teams = new Map<string, SotTeamStats>();
  const filtered: TeamRowsMap = {};
  for (const [slug, rows] of Object.entries(allTeamRows)) filtered[slug] = filterToDomesticLeague(rows, leagueName);
  for (const [slug, rows] of Object.entries(filtered)) {
    let hF = 0, hA = 0, hN = 0, aF = 0, aA = 0, aN = 0;
    for (const row of rows) {
      if (row.shotsOnTarget === undefined) continue;
      const opp = findOpponentRow(filtered, row.opponent, row.date);
      if (!opp || opp.shotsOnTarget === undefined) continue;
      if (row.venue === 'Home') { hF += row.shotsOnTarget; hA += opp.shotsOnTarget; hN++; }
      else if (row.venue === 'Away') { aF += row.shotsOnTarget; aA += opp.shotsOnTarget; aN++; }
    }
    if (hN === 0 || aN === 0) continue;
    teams.set(slug, { team: slug, homeSotFor: hF / hN, homeSotAgainst: hA / hN, awaySotFor: aF / aN, awaySotAgainst: aA / aN });
  }
  return { teams };
}

export interface ShotsTeamStats {
  team: string;
  homeShotsFor: number; homeShotsAgainst: number;
  awayShotsFor: number; awayShotsAgainst: number;
}
export interface ShotsLeagueData { teams: Map<string, ShotsTeamStats> }

export function buildShotsSeasonTotals(allTeamRows: TeamRowsMap, leagueName: string): ShotsLeagueData {
  const teams = new Map<string, ShotsTeamStats>();
  const filtered: TeamRowsMap = {};
  for (const [slug, rows] of Object.entries(allTeamRows)) filtered[slug] = filterToDomesticLeague(rows, leagueName);
  for (const [slug, rows] of Object.entries(filtered)) {
    let hF = 0, hA = 0, hN = 0, aF = 0, aA = 0, aN = 0;
    for (const row of rows) {
      if (row.shots === undefined) continue;
      const opp = findOpponentRow(filtered, row.opponent, row.date);
      if (!opp || opp.shots === undefined) continue;
      if (row.venue === 'Home') { hF += row.shots; hA += opp.shots; hN++; }
      else if (row.venue === 'Away') { aF += row.shots; aA += opp.shots; aN++; }
    }
    if (hN === 0 || aN === 0) continue;
    teams.set(slug, { team: slug, homeShotsFor: hF / hN, homeShotsAgainst: hA / hN, awayShotsFor: aF / aN, awayShotsAgainst: aA / aN });
  }
  return { teams };
}

export function findShotsTeam(data: ShotsLeagueData, teamName: string): ShotsTeamStats | undefined {
  const normalized = normalizeTeamName(teamName);
  for (const [slug, stats] of data.teams) if (normalizeTeamName(slug) === normalized) return stats;
  return undefined;
}

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