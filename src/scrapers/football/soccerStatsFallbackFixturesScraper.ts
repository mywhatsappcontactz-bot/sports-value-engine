// src/scrapers/football/soccerStatsFallbackFixturesScraper.ts
//
// Fixtures source for the SAME 24 leagues already in oddsClient.ts's
// SPORT_KEYS.football — NOT a replacement for oddsClient, a fallback.
// oddsClient remains the only source for real bookmaker odds (value
// bets still need it). This exists so tipScanner.ts can keep getting
// fresh fixtures even when the odds API quota is exhausted, disabled,
// or simply not run — since tips no longer require odds at all (see
// tipScanner.ts's removed allOdds.length gate).
//
// Confirmed via soccerstats.com/leagues.asp (the site's own master
// league list): all 24 oddsClient leagues have real coverage here,
// including the four that took extra searching to confirm (Ireland,
// China, Bulgaria, Croatia).
//
// PARSER NOTE (updated): soccerstats.com actually serves TWO different
// latest.asp templates across leagues:
//   1. "Modern" template — schema.org SportsEvent microdata
//      (<time itemprop="startDate">, <span itemprop="homeTeam">...).
//      Confirmed against Sweden's real HTML. Gives a real DATE, no
//      real kickoff TIME (placeholder hour used instead).
//   2. "Legacy" template — plain <font> tags, no microdata at all.
//      Confirmed against Poland's real HTML on 2026-08-03 (see repo
//      notes / chat log for the raw markup dump). Date is a
//      "Mon 3 Aug" style string with NO YEAR; kickoff time IS present
//      and real (green-colored <font>, e.g. "18:00" — only upcoming
//      fixtures render the time in green; completed matches show a
//      stats/h2h link in that cell instead, which is what naturally
//      excludes them from this pattern).
//
// parseFixtures() tries the modern pattern first; if it returns 0
// matches, it falls back to the legacy pattern. This means a league
// that is GENUINELY empty (real off-season, e.g. Belgium/Austria
// during their break) will still correctly return 0 fixtures — it
// just costs one extra harmless regex pass over the same HTML.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { fetchViaFlare } from '../shared/flareFetch';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface FallbackFixture {
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO 8601 — see per-template notes above re: date/time accuracy
  leagueCode: string;
  sourceMatchId: string;
}

// League code map — the SAME 24 leagues as oddsClient.ts's SPORT_KEYS.football,
// mapped to their soccerstats.com codes (confirmed via leagues.asp). Key is a
// human-readable label for logging only; matching against existing oddsClient
// matches is done by team names + date, NOT by this label, since oddsClient's
// match.league comes from the API's own sport_title field and may not match
// this label exactly.
export const FALLBACK_LEAGUE_MAP: Record<string, string> = {
  'Veikkausliiga - Finland': 'finland',
  'Superettan - Sweden': 'sweden2',
  'Allsvenskan - Sweden': 'sweden',
  'Eliteserien - Norway': 'norway',
  'League of Ireland': 'ireland',
  'Brazil Serie B': 'brazil2',
  'China Super League': 'china',
  'Serie A - Italy': 'italy',
  'Brazil Serie A': 'brazil',
  'K League 1': 'southkorea',
  'Superliga - Denmark': 'denmark',
  'Bulgaria Professional League': 'bulgaria',
  'Scotland Premiership': 'scotland',
  'Belgium First Division': 'belgium',
  'Austria Bundesliga': 'austria',
  'Croatia 1.HNL': 'croatia',
  'Switzerland Super League': 'switzerland',
  'England Championship': 'england2',
  'England League 1': 'england3',
  'England League 2': 'england4',
  'Czech Republic Liga': 'czechrepublic',
  'EPL': 'england',
  'Russia Premier League': 'russia',
  'Poland Ekstraklasa': 'poland',
  'Ukraine Premier League': 'ukraine',
  'MLS': 'usa',
};

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours, same as the corners-leagues version
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function fixturesCachePath(leagueCode: string): string {
  return path.join(CACHE_DIR, `soccerstats-fallback-${safeFileName(leagueCode)}.json`);
}

interface CacheEntry {
  fixtures: FallbackFixture[];
  fetchedAt: number;
}

function readFixturesCache(leagueCode: string): FallbackFixture[] | null {
  try {
    const filePath = fixturesCachePath(leagueCode);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.fixtures;
  } catch (err: any) {
    logger.warn('[FallbackFixtures] Cache read failed', { leagueCode, error: err.message });
    return null;
  }
}

function writeFixturesCache(leagueCode: string, fixtures: FallbackFixture[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { fixtures, fetchedAt: Date.now() };
    fs.writeFileSync(fixturesCachePath(leagueCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[FallbackFixtures] Failed to write cache', { leagueCode, error: err.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://www.soccerstats.com';

async function fetchHtml(url: string): Promise<string> {
  return fetchViaFlare(url);
}

// Placeholder-hour approach for the MODERN template only — that source only
// gives a real DATE, not a real kickoff time. The LEGACY template (below)
// gives a genuinely real kickoff time, so it does NOT use this.
const PLACEHOLDER_HOUR_UTC = 15;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Legacy dates ("Mon 3 Aug") have no year. Resolve one by assuming the
// nearest occurrence of that month/day is intended — if the resulting date
// would be more than ~6 months in the past relative to now, it must mean
// NEXT year instead (handles the turn-of-year case, e.g. parsing a January
// fixture in December). Not perfect for fixtures scraped more than ~6
// months out, but soccerstats' latest.asp only ever shows near-term
// fixtures, so that range is never actually hit in practice.
function resolveLegacyYear(monthAbbr: string, day: number): number {
  const monthIndex = MONTH_ABBR.indexOf(monthAbbr);
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  if (monthIndex === -1) return currentYear; // unrecognized abbreviation, best-effort fallback

  const candidate = Date.UTC(currentYear, monthIndex, day);
  const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;

  if (candidate < now.getTime() - sixMonthsMs) {
    return currentYear + 1;
  }
  return currentYear;
}

// ─── PARSER: MODERN TEMPLATE (schema.org microdata) ──────────────────────────
// Confirmed against real HTML (Sweden). Bounded to 2000 chars between the
// away-team span and the pmatch.asp link — prevents a malformed/missing href
// on one fixture from letting the non-greedy match jump forward into the
// NEXT fixture's link and silently misattributing sourceMatchId to the wrong
// teams. 2000 is a generous margin above what real fixture blocks need, not
// a value derived from testing the failure case itself — if fixtures start
// silently dropping after this changes, the bound is too tight for some
// league's markup and needs widening, not reverting.
function parseModernFixtures(html: string, leagueCode: string): FallbackFixture[] {
  const seen = new Set<string>();
  const fixtures: FallbackFixture[] = [];

  const blockRegex =
    /<time itemprop="startDate" datetime="(\d{4}-\d{2}-\d{2})"><\/time>\s*<span itemprop="homeTeam"[^>]*>\s*<span itemprop="name" content="([^"]+)">\s*<\/span>\s*<\/span>\s*<span itemprop="awayTeam"[^>]*>\s*<span itemprop="name" content="([^"]+)">\s*<\/span>\s*<\/span>[\s\S]{0,2000}?href="pmatch\.asp\?league=\w+&amp;stats=([\w-]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = blockRegex.exec(html)) !== null) {
    const [, dateStr, homeTeam, awayTeam, sourceMatchId] = m;

    if (seen.has(sourceMatchId)) continue;
    seen.add(sourceMatchId);

    const startTime = `${dateStr}T${String(PLACEHOLDER_HOUR_UTC).padStart(2, '0')}:00:00.000Z`;

    fixtures.push({
      homeTeam: homeTeam.trim(),
      awayTeam: awayTeam.trim(),
      startTime,
      leagueCode,
      sourceMatchId,
    });
  }

  return fixtures;
}

// ─── PARSER: LEGACY TEMPLATE (plain <font> markup, no microdata) ─────────────
// Confirmed against real HTML (Poland, 2026-08-03). Row shape:
//
//   <tr height='42' bgcolor='...'>
//   <td width='70' ...><font ...>Mon 3 Aug</font></td>
//   <td><a href='teamstats.asp?league=X&stats=ID1'>Home Team</a> - <a href='teamstats.asp?league=X&stats=ID2'>Away Team</a></td>
//   <td></td>
//   <td width='40'>
//   <font color='green' font style='font-size:11px;'>18:00</font>
//   </td>
//
// Only UPCOMING fixtures render a green-colored kickoff time in that last
// cell — completed matches show a stats/h2h link there instead — so
// requiring the green <font> naturally filters out results and keeps only
// fixtures still to be played. Bounded to 600 chars between the away-team
// link and the green time — real rows need well under that; a fixture
// missing a green time (i.e. a completed match) simply won't match at all,
// which is the intended behavior, not a bug.
function parseLegacyFixtures(html: string, leagueCode: string): FallbackFixture[] {
  const seen = new Set<string>();
  const fixtures: FallbackFixture[] = [];

  // Slug character class includes '.' — some team slugs end in a period
  // (e.g. 'u7475-lokomotiv-m.' for Russia's "Lokomotiv M."), and [\w-]+
  // alone silently fails to match those rows entirely, dropping every
  // fixture involving that team with no error at all. Confirmed:
  // Lokomotiv M.'s real upcoming fixtures were missing from Russia's
  // fixtures output because of exactly this.
  const rowRegex =
    /<font[^>]*>(\w{3}) (\d{1,2}) (\w{3})<\/font><\/td>\s*<td><a href='teamstats\.asp\?league=\w+&stats=([\w.-]+)'>([^<]+)<\/a>\s*-\s*<a href='teamstats\.asp\?league=\w+&stats=([\w.-]+)'>([^<]+)<\/a><\/td>[\s\S]{0,600}?<font color='green'[^>]*>(\d{1,2}):(\d{2})<\/font>/g;

  let m: RegExpExecArray | null;
  while ((m = rowRegex.exec(html)) !== null) {
    const [
      ,
      , // weekday abbreviation, unused
      dayStr,
      monthAbbr,
      homeId,
      homeTeam,
      awayId,
      awayTeam,
      hourStr,
      minuteStr,
    ] = m;

    const sourceMatchId = `${homeId}-${awayId}`;

    // soccerstats' legacy page lists each fixture inside both teams' own
    // mini-schedules elsewhere on the page, so the SAME match can appear
    // twice with home/away reversed (e.g. "CSKA Moscow vs Rostov" and
    // "Rostov vs CSKA Moscow" for the same kickoff). Deduping on
    // sourceMatchId alone misses this since homeId/awayId swap order.
    // dedupKey sorts the two ids so both orderings collapse to the same
    // key; sourceMatchId itself is left home/away-ordered as before,
    // since it's used elsewhere for lookups and shouldn't change shape.
    const dedupKey = [homeId, awayId].sort().join('-');
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const day = parseInt(dayStr, 10);
    const year = resolveLegacyYear(monthAbbr, day);
    const monthIndex = MONTH_ABBR.indexOf(monthAbbr);
    const hour = parseInt(hourStr, 10);
    const minute = parseInt(minuteStr, 10);

    // Legacy times are on soccerstats' own display timezone (not UTC, not
    // confirmed which zone) — treated as UTC here for consistency with the
    // rest of the pipeline. Same known limitation as other scrapers in this
    // project until a per-source timezone offset is added.
    const startTime =
      monthIndex === -1
        ? undefined
        : new Date(Date.UTC(year, monthIndex, day, hour, minute)).toISOString();

    if (!startTime) continue;

    fixtures.push({
      homeTeam: homeTeam.trim(),
      awayTeam: awayTeam.trim(),
      startTime,
      leagueCode,
      sourceMatchId,
    });
  }

  return fixtures;
}

// ─── PARSER: DISPATCH ─────────────────────────────────────────────────────────
function parseFixtures(html: string, leagueCode: string): FallbackFixture[] {
  let fixtures = parseModernFixtures(html, leagueCode);

  if (fixtures.length === 0) {
    const legacyFixtures = parseLegacyFixtures(html, leagueCode);
    if (legacyFixtures.length > 0) {
      logger.info(`[FallbackFixtures] Modern pattern found 0, legacy pattern found ${legacyFixtures.length} for ${leagueCode}`);
      fixtures = legacyFixtures;
    }
  }

  if (fixtures.length === 0) {
    logger.warn('[FallbackFixtures] Parsed 0 fixtures — possible markup change or genuinely empty schedule', { leagueCode });
  } else {
    logger.info(`[FallbackFixtures] Parsed ${fixtures.length} fixtures for ${leagueCode}`);
  }

  return fixtures;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

export async function fetchFallbackFixtures(leagueCode: string): Promise<FallbackFixture[]> {
  const cached = readFixturesCache(leagueCode);
  if (cached) {
    logger.info('[FallbackFixtures] Cache hit', { leagueCode });
    return cached;
  }

  try {
    const html = await fetchHtml(`${BASE}/latest.asp?league=${leagueCode}`);
    const fixtures = parseFixtures(html, leagueCode);

    if (fixtures.length > 0) {
      writeFixturesCache(leagueCode, fixtures);
    }

    return fixtures;
  } catch (err: any) {
    logger.error('[FallbackFixtures] Fetch failed', { leagueCode, error: err.message });
    return [];
  }
}
