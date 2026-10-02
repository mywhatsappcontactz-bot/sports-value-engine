// src/scrapers/hockey/eliteProspectsScraper.ts
//
// Scrapes game data from eliteprospects.com via the __NEXT_DATA__ JSON
// blob embedded in every league schedule/scores page (Next.js SSR).
//
// Confirmed 2026-08-31: eliteprospects.com's games payload shape is NOT
// stable — three different real shapes were observed across this one
// debugging session alone:
//   1. pageProps.games = flat array of Game objects (original capture)
//   2. pageProps.games.games = flat array (later capture, same URL)
//   3. pageProps.games.games = GraphQL Connection:
//      { __typename: "GameConnection", totalCount, pageInfo, edges: [{ node: {...Game} }] }
//      (confirmed on /schedule when totalCount was 0 — real empty
//      fixture list, not a bug)
// extractGamesArray() below normalizes all three into one flat Game[]
// so downstream code never needs to know which shape it got. If a FOURTH
// shape shows up later, add it there — don't guess, confirm via
// debugNextDataTag.ts first (kept in scripts/ for this purpose).
//
// Confirmed URL patterns:
//   https://www.eliteprospects.com/league/{code}/schedule           — upcoming fixtures
//   https://www.eliteprospects.com/league/{code}/scores/{season}    — completed season (season = "YYYY-YYYY", e.g. "2024-2025")
//   https://www.eliteprospects.com/league/{code}/scores             — current season (may be empty between seasons)
//
// "Completed" is derived from homeTeamScore/visitingTeamScore both being
// non-null — NOT from a specific status string. We've only ever seen
// status:"COMPLETED" in real captured data (every sample game was
// finished); we have not seen a real unplayed game's status value —
// EIHL's /schedule returned zero scheduled games (totalCount: 0) when
// checked. Nothing here depends on guessing that string.

import * as cheerio from 'cheerio'; // not used for game parsing (see header) — kept only if a future need for supplementary page scraping arises; safe to remove if unused
import { fetchViaEliteProspects } from '../shared/eliteProspectsFetch';
import { logger } from '../../core/utils/logger';

const BASE = 'https://www.eliteprospects.com';
const REQUEST_DELAY_MS = 1500; // same politeness delay as proballersScraper.ts

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── LEAGUE MAP ─────────────────────────────────────────────────────────
//
// ONLY codes directly verified against a real fetch go here. Do not add
// guessed slugs — verify each one the same way ACB/BSL/CBA were verified
// for Proballers (real fetch, confirm real game data returns, not a
// 404/redirect/empty page) before adding it to this map.
// Confirmed 2026-08-31/09-01: all codes below verified via a real fetch
// returning real games (either on the current season, or on the known
// 2024-2025 historical season when the current one hadn't started yet —
// same off-season disambiguation Proballers needed in August). 'ebel'
// and 'icehl' returned byte-identical pages (384146 bytes both) — almost
// certainly the same Austrian league under two slugs; keeping 'icehl'
// only since it matches the original site naming, dropping 'ebel' to
// avoid a silent duplicate.
export const ELITEPROSPECTS_LEAGUE_MAP: Record<string, { code: string }> = {
  'EIHL - United Kingdom':          { code: 'eihl' },
  'KHL - Russia':                   { code: 'khl' },
  'Liiga - Finland':                { code: 'liiga' },
  'AlpsHL':                         { code: 'alpshl' },
  'NHL':                            { code: 'nhl' },
  'AHL':                            { code: 'ahl' },
  'ECHL':                           { code: 'echl' },
  'SHL - Sweden':                   { code: 'shl' },
  'HockeyAllsvenskan - Sweden':     { code: 'hockeyallsvenskan' },
  'Mestis - Finland':               { code: 'mestis' },
  'DEL - Germany':                  { code: 'del' },
  'DEL2 - Germany':                 { code: 'del2' },
  'ICEHL - Austria':                { code: 'icehl' },
  'VHL - Russia':                   { code: 'vhl' },
};

// Candidate leagues from the original ~30-league survey — NOT yet
// verified. Slugs are unknown; do not guess them. Verify one at a time
// with verifyLeagueCode() below before moving any entry up into
// ELITEPROSPECTS_LEAGUE_MAP.
export const UNVERIFIED_CANDIDATE_LEAGUES: string[] = [
  'NHL', 'AHL', 'ECHL',
  'SHL', 'HockeyAllsvenskan (Sweden)', 'Liiga', 'Mestis (Finland)',
  'Metal Ligaen (Denmark)', 'Norway top flight',
  'DEL', 'DEL2 (Germany)', 'NL', 'SL (Switzerland)', 'ICEHL/EBEL (Austria)',
  'Extraliga (Czechia)', '1.liga (Czechia)', 'Extraliga (Slovakia)', '1.liga (Slovakia)',
  'Erste Liga (Hungary)',
  'VHL (Russia)', 'Poland', 'Latvia',
  'Ligue Magnus (France)', 'France2 (France)',
  'Italy', 'Italy2', 'Croatia', 'Serbia', 'Slovenia',
  'Asia League', 'China', 'Japan', 'AlpsHL', 'CEHL',
];

// ─── TYPES ──────────────────────────────────────────────────────────────

export interface EPGame {
  gameId: number;
  date: string;              // ISO yyyy-mm-dd, as given by source
  dateTime: string;          // full ISO datetime with offset, as given by source
  homeTeam: string;
  awayTeam: string;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number | null;
  awayScore: number | null;
  scoreType: string | null;  // "FT" | "OT" | "SO" | null — as given by source, not enumerated/validated
  status: string;            // raw status string as given by source — logged, not branched on (see header note)
  leagueCode: string;
  matchUrl: string;          // relative path, e.g. /league/eihl/game/491885/...
  isCompleted: boolean;      // derived: homeScore !== null && awayScore !== null
}

// ─── FETCH + EXTRACT __NEXT_DATA__ ──────────────────────────────────────

// Single bounded, non-backtracking extraction of one known script tag —
// not a general-purpose HTML parse, so no risk of the catastrophic
// backtracking that broke the original Proballers regex approach.
const NEXT_DATA_RE = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

function extractNextData(html: string): any | null {
  const match = html.match(NEXT_DATA_RE);
  if (!match) {
    logger.warn('[EliteProspectsScraper] __NEXT_DATA__ script tag not found — page markup may have changed');
    return null;
  }
  try {
    return JSON.parse(match[1]);
  } catch (err: any) {
    logger.warn('[EliteProspectsScraper] Failed to JSON.parse __NEXT_DATA__', { error: err.message });
    return null;
  }
}

/**
 * Normalizes the three confirmed real shapes of pageProps.games into one
 * flat array of raw Game objects. See header comment for what each shape
 * looked like when captured. Returns [] (not null) when nothing usable
 * is found, INCLUDING the legitimate "GameConnection with totalCount: 0"
 * case — that's real data (no games), not a parse failure, so it's
 * logged at info level, not warn.
 */
function extractGamesArray(nextData: any, leagueCode: string): any[] {
  const container = nextData?.props?.pageProps?.games;

  // Shape 1: flat array directly.
  if (Array.isArray(container)) {
    return container;
  }

  const inner = container?.games;

  // Shape 2: one level of { games: [...] } wrapping.
  if (Array.isArray(inner)) {
    return inner;
  }

  // Shape 3: GraphQL Connection — { __typename: "GameConnection", totalCount, edges: [{ node }] }
   if (inner && Array.isArray(inner.edges)) {
    // Confirmed 2026-08-31: unlike standard GraphQL Relay connections,
    // eliteprospects.com's edges are NOT wrapped in a .node property —
    // each edge IS the Game object directly. Handling both defensively
    // in case a future response does use .node (cheap, and matches how
    // extractGamesArray already tolerates shape drift elsewhere).
    return inner.edges.map((e: any) => e?.node ?? e).filter(Boolean);
  }

  // Also handle the Connection shape appearing one level shallower, i.e.
  // pageProps.games itself being the Connection (no extra .games nesting)
  // — not yet observed directly, but cheap to cover given how much this
  // payload has already moved around in one session.
  if (container && Array.isArray(container.edges)) {
    return container.edges.map((e: any) => e?.node).filter(Boolean);
  }

  logger.warn('[EliteProspectsScraper] games data not found in any known shape', { leagueCode });
  return [];
}

function mapRawGame(raw: any, leagueCode: string): EPGame | null {
  if (!raw || raw.__typename !== 'Game') return null;
  const homeScore = typeof raw.homeTeamScore === 'number' ? raw.homeTeamScore : null;
  const awayScore = typeof raw.visitingTeamScore === 'number' ? raw.visitingTeamScore : null;
  const gameId = parseInt(raw.id, 10);
  if (isNaN(gameId) || !raw.homeTeam?.name || !raw.visitingTeam?.name || !raw.date) return null;

  return {
    gameId,
    date: raw.date,
    dateTime: raw.dateTime,
    homeTeam: raw.homeTeam.name,
    awayTeam: raw.visitingTeam.name,
    homeTeamId: parseInt(raw.homeTeam.id, 10),
    awayTeamId: parseInt(raw.visitingTeam.id, 10),
    homeScore,
    awayScore,
    scoreType: raw.scoreType ?? null,
    status: raw.status,
    leagueCode,
    matchUrl: raw.eliteprospectsUrlPath,
    isCompleted: homeScore !== null && awayScore !== null,
  };
}

function parseGamesFromHtml(html: string, leagueCode: string): EPGame[] {
  const nextData = extractNextData(html);
  const rawGames = extractGamesArray(nextData, leagueCode);

  const games = rawGames
    .map((g: any) => mapRawGame(g, leagueCode))
    .filter((g: EPGame | null): g is EPGame => g !== null);

  logger.info(`[EliteProspectsScraper] Parsed ${games.length} games`, { leagueCode });
  return games;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────

/**
 * Completed games for a season. Omit `season` for the current season
 * (may return an empty games array between seasons — confirmed possible
 * per original URL-pattern investigation, not yet observed directly).
 * season format: "YYYY-YYYY", e.g. "2024-2025".
 */
/**
 * Fetches ALL pages of a season's completed games. Confirmed 2026-08-31:
 * eliteprospects.com paginates via a simple ?page=N query param (real
 * browser Network tab confirmed, not guessed), page 1 is the same as no
 * param at all, pageInfo.limit is 100 games/page. Stops when a page
 * returns 0 games OR when totalCount has been reached — whichever comes
 * first, so this doesn't infinite-loop if totalCount is ever wrong/stale.
 */
export async function fetchLeagueScores(leagueName: string, season?: string): Promise<EPGame[]> {
  const league = ELITEPROSPECTS_LEAGUE_MAP[leagueName];
  if (!league) {
    logger.warn('[EliteProspectsScraper] Unknown or unverified league', { leagueName });
    return [];
  }
  const seasonSuffix = season ? `/${season}` : '';
  const baseUrl = `${BASE}/league/${league.code}/scores${seasonSuffix}`;

  const allGames: EPGame[] = [];
  let page = 1;
  let expectedTotal: number | null = null;

  while (true) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    console.log(`  [debug] fetching page ${page}: ${url} ...`);
    const html = await fetchViaEliteProspects(url);
    await sleep(REQUEST_DELAY_MS);

    const nextData = extractNextData(html);
    const totalCountOnPage = nextData?.props?.pageProps?.games?.games?.totalCount;
    if (typeof totalCountOnPage === 'number') {
      expectedTotal = totalCountOnPage;
    }

    const pageGames = parseGamesFromHtml(html, league.code);
    console.log(`  [debug] page ${page}: ${pageGames.length} games (running total will be ${allGames.length + pageGames.length}${expectedTotal !== null ? ` / ${expectedTotal}` : ''})`);

    if (pageGames.length === 0) break; // no more data — stop regardless of totalCount
    allGames.push(...pageGames);

    if (expectedTotal !== null && allGames.length >= expectedTotal) break; // reached confirmed total
    page++;

    // Safety cap — real seasons shouldn't need more than ~20 pages
    // (2000+ games) for any single league; stops a runaway loop if
    // totalCount/pageGames.length ever behave unexpectedly.
    if (page > 20) {
      logger.warn('[EliteProspectsScraper] Stopped pagination at page 20 safety cap', { leagueCode: league.code });
      break;
    }
  }

  console.log(`  [debug] pagination complete: ${allGames.length} total games across ${page} page(s)`);
  return allGames;
}
/** Upcoming/unplayed fixtures. */
export async function fetchLeagueSchedule(leagueName: string): Promise<EPGame[]> {
  const league = ELITEPROSPECTS_LEAGUE_MAP[leagueName];
  if (!league) {
    logger.warn('[EliteProspectsScraper] Unknown or unverified league', { leagueName });
    return [];
  }
  const url = `${BASE}/league/${league.code}/schedule`;
  const html = await fetchViaEliteProspects(url);
  await sleep(REQUEST_DELAY_MS);
  return parseGamesFromHtml(html, league.code);
}

/**
 * Checks whether a candidate league code returns real game data.
 * Use this to verify UNVERIFIED_CANDIDATE_LEAGUES entries one at a time
 * before adding them to ELITEPROSPECTS_LEAGUE_MAP — same discipline used
 * to verify ACB/BSL/CBA for Proballers.
 */
export async function verifyLeagueCode(code: string, season?: string): Promise<{ code: string; ok: boolean; gamesFound: number; note: string }> {
  try {
    // Optional season suffix — needed because "no games found" on the
    // CURRENT season is ambiguous: could be a wrong slug, or could just
    // be a real league that hasn't started its new season yet (this bit
    // us with Proballers in August too). Passing a known historical
    // season (e.g. "2024-2025", the one confirmed working for EIHL)
    // disambiguates: real games there = confirmed correct slug, still
    // 0/404 = genuinely wrong code.
    const seasonSuffix = season ? `/${season}` : '';
    const url = `${BASE}/league/${code}/scores${seasonSuffix}`;
    const html = await fetchViaEliteProspects(url);
    await sleep(REQUEST_DELAY_MS);
    const nextData = extractNextData(html);
    const rawGames = extractGamesArray(nextData, code);
    if (rawGames.length === 0) {
      return { code, ok: false, gamesFound: 0, note: 'No games found — could be wrong code, empty current season (try /scores/{season}), or real empty result' };
    }
    return { code, ok: true, gamesFound: rawGames.length, note: 'OK' };
  } catch (err: any) {
    return { code, ok: false, gamesFound: 0, note: `Fetch error: ${err.message}` };
  }
}

// ─── DERIVED STATS (same shape/logic as proballersScraper.ts) ───────────

export interface TeamFormEntry {
  date: string;
  opponent: string;
  result: 'W' | 'L';
  scoreFor: number;
  scoreAgainst: number;
  venue: 'home' | 'away';
}

export function buildTeamForm(games: EPGame[], teamName: string): TeamFormEntry[] {
  const entries: TeamFormEntry[] = [];
  for (const g of games) {
    if (!g.isCompleted) continue;
    if (g.homeTeam === teamName) {
      entries.push({
        date: g.date, opponent: g.awayTeam,
        result: g.homeScore! > g.awayScore! ? 'W' : 'L',
        scoreFor: g.homeScore!, scoreAgainst: g.awayScore!, venue: 'home',
      });
    } else if (g.awayTeam === teamName) {
      entries.push({
        date: g.date, opponent: g.homeTeam,
        result: g.awayScore! > g.homeScore! ? 'W' : 'L',
        scoreFor: g.awayScore!, scoreAgainst: g.homeScore!, venue: 'away',
      });
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date));
}

export function averageGoals(form: TeamFormEntry[], key: 'scoreFor' | 'scoreAgainst', lastN = 10): number {
  const slice = form.slice(0, lastN);
  if (!slice.length) return 3; // placeholder fallback — NOT verified against any model default, since modelHockey() doesn't exist yet. Revisit once probabilityModel.ts gets hockey support.
  return slice.reduce((s, e) => s + e[key], 0) / slice.length;
}

export function headToHead(games: EPGame[], teamA: string, teamB: string): EPGame[] {
  return games.filter(
    g => g.isCompleted && ((g.homeTeam === teamA && g.awayTeam === teamB) || (g.homeTeam === teamB && g.awayTeam === teamA))
  );
}

export function fatigueDays(form: TeamFormEntry[], asOfDate: string): number | undefined {
  if (!form.length) return undefined;
  const last = new Date(form[0].date).getTime();
  const now = new Date(asOfDate).getTime();
  return Math.round((now - last) / (1000 * 60 * 60 * 24));
}

// ─── QUICK TEST ─────────────────────────────────────────────────────────
// npx ts-node src/scrapers/hockey/eliteProspectsScraper.ts

async function main() {
  console.log('Fetching EIHL 2024-2025 completed scores...');
  const games = await fetchLeagueScores('EIHL - United Kingdom', '2024-2025');
  console.log(`\nTotal games parsed: ${games.length}`);
  games.slice(0, 5).forEach(g => {
    console.log(`  ${g.date} | ${g.homeTeam} ${g.homeScore}-${g.awayScore} ${g.awayTeam} [${g.scoreType}] status=${g.status}`);
  });

  console.log('\nFetching EIHL upcoming schedule...');
  const upcoming = await fetchLeagueSchedule('EIHL - United Kingdom');
  console.log(`Total upcoming entries parsed: ${upcoming.length}`);
  upcoming.slice(0, 5).forEach(g => {
    console.log(`  ${g.date} | ${g.homeTeam} vs ${g.awayTeam} status=${g.status} isCompleted=${g.isCompleted}`);
  });
  if (upcoming.length > 0) {
    console.log(`\nFirst upcoming game's raw status value: "${upcoming[0].status}" — confirm this matches expectations.`);
  } else {
    console.log('\n0 upcoming games — EIHL schedule may genuinely be empty right now (confirmed possible via GameConnection totalCount: 0).');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[EliteProspectsScraper] Fatal error:', err.message);
    process.exit(1);
  });
}