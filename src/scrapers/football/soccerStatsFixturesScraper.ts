// src/scrapers/football/soccerStatsFixturesScraper.ts
//
// Reads upcoming fixtures embedded on each league's own latest.asp?league=X
// page. Two source templates exist on soccerstats.com (confirmed against
// real HTML across multiple leagues):
//   1. "Modern" — schema.org SportsEvent microdata blocks. Real DATE, no
//      real kickoff TIME (placeholder hour used instead).
//   2. "Legacy" — plain <font> tags, teamstats.asp team links separated by
//      " - ", green-colored kickoff time. Real date (no year) AND real
//      kickoff time.
//
// UPDATE (2026-08-18): this file originally only implemented the modern
// parser. Confirmed against live HTML that Spain/Germany/Turkey/Netherlands
// currently render the LEGACY template, not modern — meaning this file was
// returning 0 fixtures for those leagues even when real upcoming fixtures
// were on the page the whole time. soccerStatsFallbackFixturesScraper.ts
// already had both parsers with a try-modern-then-legacy dispatch; that
// same pattern is ported here.
//
// PURPOSE: TheOddsAPI free tier (oddsClient.ts SPORT_KEYS.football)
// does not cover Spain, Germany, Turkey, or Netherlands — meaning
// corners/goals tips can never fire for those leagues, since no `matches`
// row can ever be created for them via the existing pipeline. This
// scraper creates `matches` rows directly from soccerstats.com,
// bypassing that restriction entirely. Odds-independent by design.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { fetchViaFlare } from '../shared/flareFetch';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface ScrapedFixture {
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO 8601 — see per-template notes above re: date/time accuracy
  leagueCode: string;
  sourceMatchId: string; // stable per-fixture ID
}

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function fixturesCachePath(leagueCode: string): string {
  return path.join(CACHE_DIR, `soccerstats-fixtures-${safeFileName(leagueCode)}.json`);
}

interface CacheEntry {
  fixtures: ScrapedFixture[];
  fetchedAt: number;
}

function readFixturesCache(leagueCode: string): ScrapedFixture[] | null {
  try {
    const filePath = fixturesCachePath(leagueCode);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.fixtures;
  } catch (err: any) {
    logger.warn('[SoccerStatsFixtures] Cache read failed', { leagueCode, error: err.message });
    return null;
  }
}

function writeFixturesCache(leagueCode: string, fixtures: ScrapedFixture[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { fixtures, fetchedAt: Date.now() };
    fs.writeFileSync(fixturesCachePath(leagueCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[SoccerStatsFixtures] Failed to write cache', { leagueCode, error: err.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://www.soccerstats.com';

async function fetchHtml(url: string): Promise<string> {
  return fetchViaFlare(url);
}

// Placeholder-hour approach for the MODERN template only — that source only
// gives a real DATE, not a real kickoff time. The LEGACY template gives a
// genuinely real kickoff time, so it does NOT use this.
const PLACEHOLDER_HOUR_UTC = 15;

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Legacy dates ("Wed 19 Aug") have no year. Resolve one by assuming the
// nearest occurrence of that month/day is intended — if the resulting date
// would be more than ~6 months in the past, it must mean NEXT year instead.
function resolveLegacyYear(monthAbbr: string, day: number): number {
  const monthIndex = MONTH_ABBR.indexOf(monthAbbr);
  const now = new Date();
  const currentYear = now.getUTCFullYear();

  if (monthIndex === -1) return currentYear;

  const candidate = Date.UTC(currentYear, monthIndex, day);
  const sixMonthsMs = 183 * 24 * 60 * 60 * 1000;

  if (candidate < now.getTime() - sixMonthsMs) {
    return currentYear + 1;
  }
  return currentYear;
}

// ─── PARSER: MODERN TEMPLATE (schema.org microdata) ──────────────────────────
function parseModernFixtures(html: string, leagueCode: string): ScrapedFixture[] {
  const seen = new Set<string>();
  const fixtures: ScrapedFixture[] = [];

  const blockRegex =
    /<time itemprop="startDate" datetime="(\d{4}-\d{2}-\d{2})"><\/time>\s*<span itemprop="homeTeam"[^>]*>\s*<span itemprop="name" content="([^"]+)">\s*<\/span>\s*<\/span>\s*<span itemprop="awayTeam"[^>]*>\s*<span itemprop="name" content="([^"]+)">\s*<\/span>\s*<\/span>[\s\S]*?href='pmatch\.asp\?league=\w+&stats=([\w-]+)'/g;

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
// Confirmed against live Spain HTML 2026-08-18. Row shape:
//
//   <tr height='42' bgcolor='#ffffff'>
//   <td width='70' ...><font ...>Wed 19 Aug</font></td>
//   <td><a href='teamstats.asp?league=X&stats=ID1'>Home Team</a> - <a href='teamstats.asp?league=X&stats=ID2'>Away Team</a></td>
//   <td></td>
//   <td width='40'>
//   <font color='green' font style='font-size:11px;'>20:00</font>
//   </td>
//
// Only UPCOMING fixtures render a green-colored kickoff time in that cell —
// completed matches show a stats/h2h link there instead, which naturally
// excludes them from this pattern.
function parseLegacyFixtures(html: string, leagueCode: string): ScrapedFixture[] {
  const seen = new Set<string>();
  const fixtures: ScrapedFixture[] = [];

  // Slug character class includes '.' — some team slugs end in a period.
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

    // Same match can appear twice with home/away reversed elsewhere on the
    // page — dedupe on sorted ids so both orderings collapse together.
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
    // rest of the pipeline, same known limitation as other scrapers.
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
// Confirmed real structure (Sweden, 24-31 Jul 2026 fixtures) — each
// upcoming fixture appears as a schema.org SportsEvent block, repeated
// 3x across the page. Deduped by sourceMatchId (the pmatch.asp stats=
// param), keeping only the first occurrence of each match.

function parseFixtures(html: string, leagueCode: string): ScrapedFixture[] {
  let fixtures = parseModernFixtures(html, leagueCode);

  if (fixtures.length === 0) {
    const legacyFixtures = parseLegacyFixtures(html, leagueCode);
    if (legacyFixtures.length > 0) {
      logger.info(`[SoccerStatsFixtures] Modern pattern found 0, legacy pattern found ${legacyFixtures.length} for ${leagueCode}`);
      fixtures = legacyFixtures;
    }
  }

  if (fixtures.length === 0) {
    logger.warn('[SoccerStatsFixtures] Parsed 0 fixtures — possible markup change or genuinely empty schedule', { leagueCode });
  } else {
    logger.info(`[SoccerStatsFixtures] Parsed ${fixtures.length} fixtures for ${leagueCode}`);
  }

  return fixtures;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

export async function fetchUpcomingFixtures(leagueCode: string): Promise<ScrapedFixture[]> {
  const cached = readFixturesCache(leagueCode);
  if (cached) {
    logger.info('[SoccerStatsFixtures] Cache hit', { leagueCode });
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
    logger.error('[SoccerStatsFixtures] Fetch failed', { leagueCode, error: err.message });
    return [];
  }
}