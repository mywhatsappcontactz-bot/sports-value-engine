// src/scrapers/football/soccerStatsFormScraper.ts
//
// Replaces FCStats' recentResults (per-team last-N match history) now that
// fcStatsScraper.ts is Cloudflare-blocked. soccerstats.com has no single
// "form" page with match-by-match detail (checked: the "Form (last 8)"
// section on a team's own teamstats.asp page is a LEAGUE-WIDE mini-table
// ranking OTHER teams by recent points — not this team's own match log).
//
// The real source is a 3-step chain, confirmed against real HTML
// (Poland/Cracovia Krakow, Russia/Rubin Kazan, 2026-08-03):
//   1. latest.asp?league=X       — team name -> teamstats.asp slug
//      (same page fixtures come from; every team link on it carries its
//      slug, e.g. 'u7156-cracovia-krakow')
//   2. teamstats.asp?league=X&stats=SLUG — slug -> numeric matchlist team id
//      (the page's own "Totals" row links to
//      matchlist.asp?league=X&matches=ID-99-0 for THIS team)
//   3. matchlist.asp?league=X&matches=ID-99-0 — the actual match-by-match
//      log: date, local team, visitor team, goals, outcome, all in one
//      sortable table, ALL matches played so far this season (not just
//      recent — we slice to the last N ourselves).
//
// Row markup for step 3 confirmed against 2 real rows (Rubin Kazan):
//   <tr bgcolor='#...' height='28'>
//   <td sorttable_customkey='20260726000000' align='center'><font .../>26 Jul</font></td>
//   <td><b>Rubin Kazan</b></td><td>FC Krasnodar</td>
//   <td sorttable_customkey='1' align='center'><b>1</b></td>
//   <td sorttable_customkey='3' align='center'><b>3</b></td>
//   ...
// The requested team is wrapped in <b> when it played at home, or is the
// PLAIN (non-bold) cell when it played away — position (local/visitor)
// isn't fixed, so venue is determined by which cell's text matches the
// team we searched for, not by column order. The goal counts are read
// from each cell's own sorttable_customkey attribute (a clean integer),
// not parsed out of the <b> text, since that attribute is guaranteed
// numeric and cheaper to match than digging through nested tags.
//
// Rows come back in ASCENDING date order (oldest first, confirmed: 26 Jul
// before 1 Aug) — we take the LAST N rows, then reverse so index 0 is the
// most recent match, matching FCStats' old ordering convention.
//
// UPDATED (corners recency project): each row also carries a link to its
// own pmatch.asp match report — e.g.
// <td align='center'><a class='vsmall' href='pmatch.asp?league=england&stats=1-1-2-2027'>...
// — confirmed present in every real row inspected. Previously parsed
// implicitly (regex ran past it) but discarded; now captured and exposed
// on RecentResult as pmatchPath, since soccerStatsMatchCornersScraper.ts
// needs it to fetch that specific match's real corner result for
// recency-weighted corners (see cornersRecencyWeighting.ts). Optional /
// nullable throughout, since this is additive — every existing caller of
// fetchRecentForm that only reads goalsFor/goalsAgainst/result/venue/date
// keeps working unchanged.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { fetchViaFlare } from '../shared/flareFetch';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface RecentResult {
  opponent: string;
  goalsFor: number;
  goalsAgainst: number;
  result: 'W' | 'L' | 'D';
  venue: 'home' | 'away';
  date: string; // ISO date, YYYY-MM-DD
  // Relative path to this match's own report page, e.g.
  // "pmatch.asp?league=england&stats=1-1-2-2027" — null if the row
  // didn't carry one (shouldn't normally happen, but the regex is
  // defensive rather than assuming every row has it).
  pmatchPath: string | null;
}

interface TeamSlugEntry {
  slug: string;
  displayName: string;
}

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
// Three separate cache layers, matching how rarely each thing actually
// changes:
//   - slug map (team name -> teamstats.asp slug): essentially static for
//     a season, 7-day TTL, same as fcStatsScraper.ts used for league data.
//   - matchlist team id (slug -> numeric id used in matchlist.asp): same,
//     7-day TTL — this id doesn't change once assigned.
//   - actual match results: changes every matchday, 6-hour TTL, same as
//     soccerStatsFallbackFixturesScraper.ts uses for fixtures.

const SLUG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TEAMID_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESULTS_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function readCache<T>(filePath: string, ttlMs: number): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: { data: T; fetchedAt: number } = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= ttlMs) return null;
    return entry.data;
  } catch (err: any) {
    logger.warn('[SoccerStatsForm] Cache read failed', { filePath, error: err.message });
    return null;
  }
}

function writeCache<T>(filePath: string, data: T): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ data, fetchedAt: Date.now() }), 'utf-8');
  } catch (err: any) {
    logger.warn('[SoccerStatsForm] Failed to write cache', { filePath, error: err.message });
  }
}

function slugCachePath(leagueCode: string): string {
  return path.join(CACHE_DIR, `soccerstats-formslugs-${safeFileName(leagueCode)}.json`);
}

function teamIdCachePath(leagueCode: string, slug: string): string {
  return path.join(CACHE_DIR, `soccerstats-formteamid-${safeFileName(leagueCode)}-${safeFileName(slug)}.json`);
}

function resultsCachePath(leagueCode: string, teamId: string): string {
  return path.join(CACHE_DIR, `soccerstats-formmatches-${safeFileName(leagueCode)}-${safeFileName(teamId)}.json`);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://www.soccerstats.com';

async function fetchHtml(url: string): Promise<string> {
  return fetchViaFlare(url);
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Same generic-word stripping as soccerStatsCornersScraper.ts — prevents
// "Derry City" and "Manchester City" from scoring a false match on "city"
// alone.
const GENERIC_TEAM_WORDS = new Set([
  'city', 'united', 'fc', 'afc', 'town', 'rovers', 'athletic', 'albion',
  'wanderers', 'county', 'hotspur', 'academy', 'sporting',
]);

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  const stripGeneric = (s: string) => s.split(' ').filter((t) => !GENERIC_TEAM_WORDS.has(t));
  const ta = new Set(stripGeneric(na));
  const tb = new Set(stripGeneric(nb));
  if (ta.size === 0 || tb.size === 0) return 0;

  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union;
}

// ─── STEP 1: TEAM NAME -> SLUG ────────────────────────────────────────────────
// Scraped from latest.asp?league=X — the same page fixtures come from.
// Every team-link on that page (fixture rows, tables, etc.) carries this
// pattern, so one broad regex over the whole page is enough to build a
// complete slug map without needing a dedicated "team list" endpoint.

async function fetchTeamSlugMap(leagueCode: string): Promise<Map<string, TeamSlugEntry>> {
  const cachePath = slugCachePath(leagueCode);
  const cached = readCache<[string, TeamSlugEntry][]>(cachePath, SLUG_CACHE_TTL_MS);
  if (cached) {
    logger.info('[SoccerStatsForm] Slug map cache hit', { leagueCode });
    return new Map(cached);
  }

  const html = await fetchHtml(`${BASE}/latest.asp?league=${leagueCode}`);
  const slugMap = new Map<string, TeamSlugEntry>();

  // Slug character class includes '.' — some team slugs end in a period
  // (e.g. 'u7475-lokomotiv-m.' for "Lokomotiv M."), and [\w-]+ alone
  // silently fails to match those links entirely, dropping that team
  // from the slug map with no error (confirmed: Russia's "Lokomotiv M."
  // — real slug link present in the HTML, just never matched).
  const linkRegex = /href='teamstats\.asp\?league=\w+&stats=([\w.-]+)'>([^<]+)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const [, slug, displayName] = m;
    const key = normalize(displayName);
    if (!slugMap.has(key)) {
      slugMap.set(key, { slug, displayName: displayName.trim() });
    }
  }

  if (slugMap.size === 0) {
    logger.warn('[SoccerStatsForm] No team slugs found on latest.asp', { leagueCode });
  } else {
    writeCache(cachePath, Array.from(slugMap.entries()));
    logger.info(`[SoccerStatsForm] Parsed ${slugMap.size} team slugs`, { leagueCode });
  }

  return slugMap;
}

function findSlugEntry(slugMap: Map<string, TeamSlugEntry>, teamName: string): TeamSlugEntry | null {
  const key = normalize(teamName);
  if (slugMap.has(key)) return slugMap.get(key)!;

  let best: TeamSlugEntry | null = null;
  let bestScore = 0;
  for (const [k, entry] of slugMap) {
    const score = similarity(key, k);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// ─── STEP 2: SLUG -> MATCHLIST TEAM ID ────────────────────────────────────────
// Scraped from teamstats.asp?league=X&stats=SLUG — the "Totals" row in the
// "Seasonal match statistics" section links to this team's own filtered
// matchlist. Confirmed pattern (Poland/Cracovia):
//   href='matchlist.asp?league=poland&matches=10-99-0'

async function fetchMatchlistTeamId(leagueCode: string, slug: string): Promise<string | null> {
  const cachePath = teamIdCachePath(leagueCode, slug);
  const cached = readCache<string>(cachePath, TEAMID_CACHE_TTL_MS);
  if (cached) return cached;

  const html = await fetchHtml(`${BASE}/teamstats.asp?league=${leagueCode}&stats=${slug}`);
  const match = /href='matchlist\.asp\?league=\w+&matches=(\d+)-99-0'/.exec(html);

  if (!match) {
    logger.warn('[SoccerStatsForm] Could not find matchlist team id', { leagueCode, slug });
    return null;
  }

  const teamId = match[1];
  writeCache(cachePath, teamId);
  return teamId;
}

// ─── STEP 3: MATCHLIST -> MATCH ROWS ──────────────────────────────────────────
// Confirmed against 2 real rows (Rubin Kazan, Russia). Local/visitor cell
// text may or may not be wrapped in <b> depending on which side is the
// requested team — (?:<b>)?...(?:<\/b>)? handles both without needing two
// separate patterns. Goal counts come from each cell's own
// sorttable_customkey attribute rather than the nested <b> text, since
// that attribute is a plain guaranteed integer.
//
// UPDATED: now also captures the row's pmatch.asp link, which appears
// later in the row after the goals cells — confirmed present as
// <td align='center'><a class='vsmall' href='pmatch.asp?league=...&stats=...'>
// in every real row inspected during the corners recency work. The
// [\s\S]*? between the goals cells and the href is non-greedy and
// unanchored to any specific intervening markup, since the cells between
// goals and the pmatch link (win/loss icon, etc.) aren't needed and may
// vary; this only requires that a pmatch.asp href eventually appears
// somewhere later in the same row before the next <tr> starts. If a row
// has no pmatch.asp link at all, the whole row fails to match and is
// silently dropped — same behavior as before this change for malformed
// rows, just now also applies to this new required group. Worth
// revisiting if real usage shows rows being dropped that shouldn't be.
interface RawMatchRow {
  year: string;
  month: string;
  day: string;
  local: string;
  visitor: string;
  homeGoals: number;
  awayGoals: number;
  pmatchPath: string | null;
}

function parseMatchlistRows(html: string): RawMatchRow[] {
  const rows: RawMatchRow[] = [];

  const rowRegex =
    /<tr bgcolor='#[0-9A-Fa-f]+' height='28'><td sorttable_customkey='(\d{4})(\d{2})(\d{2})\d{6}'\s*align='center'><font size='1' color='blue'>[^<]*<\/font><\/td><td>(?:<b>)?([^<]+?)(?:<\/b>)?<\/td><td>(?:<b>)?([^<]+?)(?:<\/b>)?<\/td><td sorttable_customkey='(\d+)' align='center'><b>\d+<\/b><\/td><td sorttable_customkey='(\d+)' align='center'><b>\d+<\/b><\/td>[\s\S]*?href='(pmatch\.asp\?[^']+)'/g;

  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(html)) !== null) {
    const [, year, month, day, local, visitor, homeGoalsStr, awayGoalsStr, pmatchPath] = m;
    rows.push({
      year,
      month,
      day,
      local: local.trim(),
      visitor: visitor.trim(),
      homeGoals: parseInt(homeGoalsStr, 10),
      awayGoals: parseInt(awayGoalsStr, 10),
      pmatchPath: pmatchPath ?? null,
    });
  }

  return rows;
}

async function fetchMatchlistRows(leagueCode: string, teamId: string): Promise<RawMatchRow[]> {
  const cachePath = resultsCachePath(leagueCode, teamId);
  const cached = readCache<RawMatchRow[]>(cachePath, RESULTS_CACHE_TTL_MS);
  if (cached) return cached;

  const html = await fetchHtml(`${BASE}/matchlist.asp?league=${leagueCode}&matches=${teamId}-99-0`);
  const rows = parseMatchlistRows(html);

  if (rows.length > 0) {
    writeCache(cachePath, rows);
  }

  logger.info(`[SoccerStatsForm] Parsed ${rows.length} match rows`, { leagueCode, teamId });
  return rows;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Fetches the last `limit` completed matches for a team, most recent
 * first, in the same shape FCStats' recentResults used to provide.
 *
 * Returns [] (not null) if the team can't be resolved or has no match
 * history yet (e.g. a brand-new season, 0-1 games played) — callers
 * should treat that the same as "insufficient form data", same as an
 * empty FCStats result used to be treated.
 */
export async function fetchRecentForm(
  leagueCode: string,
  teamName: string,
  limit: number = 5,
): Promise<RecentResult[]> {
  const slugMap = await fetchTeamSlugMap(leagueCode);
  const slugEntry = findSlugEntry(slugMap, teamName);

  if (!slugEntry) {
    logger.warn('[SoccerStatsForm] Could not resolve team to a slug', { leagueCode, teamName });
    return [];
  }

  const teamId = await fetchMatchlistTeamId(leagueCode, slugEntry.slug);
  if (!teamId) return [];

  const rawRows = await fetchMatchlistRows(leagueCode, teamId);
  if (rawRows.length === 0) return [];

  // Rows arrive oldest-first — take the last `limit` (most recent), then
  // reverse so index 0 is the most recent match.
  const recentRaw = rawRows.slice(-limit).reverse();

  const results: RecentResult[] = [];
  for (const row of recentRaw) {
    const isHome = similarity(slugEntry.displayName, row.local) >= 0.5;
    const isAway = similarity(slugEntry.displayName, row.visitor) >= 0.5;

    if (!isHome && !isAway) {
      // Shouldn't happen — this matchlist is pre-filtered to this team's
      // own matches by teamId — but skip defensively rather than
      // misattribute a row to the wrong side.
      logger.warn('[SoccerStatsForm] Row matched neither local nor visitor', {
        leagueCode,
        teamName: slugEntry.displayName,
        local: row.local,
        visitor: row.visitor,
      });
      continue;
    }

    const goalsFor = isHome ? row.homeGoals : row.awayGoals;
    const goalsAgainst = isHome ? row.awayGoals : row.homeGoals;
    const opponent = isHome ? row.visitor : row.local;
    const result: 'W' | 'L' | 'D' = goalsFor > goalsAgainst ? 'W' : goalsFor < goalsAgainst ? 'L' : 'D';

    results.push({
      opponent,
      goalsFor,
      goalsAgainst,
      result,
      venue: isHome ? 'home' : 'away',
      date: `${row.year}-${row.month}-${row.day}`,
      pmatchPath: row.pmatchPath,
    });
  }

  return results;
}