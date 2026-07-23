// src/scrapers/football/soccerStatsFixturesScraper.ts
//
// Reads the "Matches" (upcoming fixtures) section embedded on each
// league's own latest.asp?league=X page.
//
// PURPOSE: TheOddsAPI free tier (oddsClient.ts SPORT_KEYS.football)
// does not cover Spain, Germany, Turkey, or Netherlands — meaning
// corners tips can never fire for those leagues, since no `matches`
// row can ever be created for them via the existing pipeline. This
// scraper creates `matches` rows directly from soccerstats.com,
// bypassing that restriction entirely. Odds-independent by design.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface ScrapedFixture {
  homeTeam: string;
  awayTeam: string;
  startTime: string; // ISO 8601, best-effort from "Sat 18 Jul 13:00" + inferred year
  leagueCode: string;
  sourceMatchId: string; // from pmatch.asp's stats= param — stable per-fixture ID
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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function inferKickoffDate(day: number, monthAbbr: string, hour: number, minute: number): string | null {
  const month = MONTHS[monthAbbr.toLowerCase()];
  if (month === undefined) return null;

  const now = new Date();
  let year = now.getFullYear();

  let candidate = new Date(Date.UTC(year, month, day, hour, minute));
  const diffDays = (candidate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);

  // Dec scraped for early Jan match
  if (diffDays < -30) {
    year += 1;
    candidate = new Date(Date.UTC(year, month, day, hour, minute));
  } 
  // Jan scraped for Dec match from prior season
  else if (diffDays > 300) {
    year -= 1;
    candidate = new Date(Date.UTC(year, month, day, hour, minute));
  }

  return candidate.toISOString();
}

function stripHtmlTags(str: string): string {
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── PARSER ──────────────────────────────────────────────────────────────────

function parseFixtures(html: string, leagueCode: string): ScrapedFixture[] {
  const fixtures: ScrapedFixture[] = [];

  // Match HTML table rows <tr>...</tr> that contain a link to pmatch.asp
  const rowMatches = html.match(/<tr[^>]*>[\s\S]*?pmatch\.asp[\s\S]*?<\/tr>/gi) || [];

  for (const rowHtml of rowMatches) {
    const cleanRowText = stripHtmlTags(rowHtml);

    // 1. Extract Date/Time (e.g. "Sat 18 Jul 13:00")
    const dateMatch = cleanRowText.match(/(\w{3})\s+(\d{1,2})\s+(\w{3})\s+(\d{1,2}):(\d{2})/);
    if (!dateMatch) continue;

    const [, , dayStr, monthAbbr, hourStr, minuteStr] = dateMatch;
    const startTime = inferKickoffDate(
      parseInt(dayStr, 10),
      monthAbbr,
      parseInt(hourStr, 10),
      parseInt(minuteStr, 10)
    );
    if (!startTime) continue;

    // 2. Extract stats match ID from href
    const statsMatch = rowHtml.match(/href=["'][^"']*pmatch\.asp\?league=\w+&amp;stats=([\w-]+)["']/i) ||
                       rowHtml.match(/href=["'][^"']*pmatch\.asp\?league=\w+&stats=([\w-]+)["']/i);
    if (!statsMatch) continue;
    const sourceMatchId = statsMatch[1];

    // 3. Extract Team Names from anchors in table cells
    const anchorMatches = Array.from(rowHtml.matchAll(/<a[^>]*href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi));
    
    // Filter out pmatch control links and empty strings
    const teamNames = anchorMatches
      .filter(m => !m[1].includes('pmatch.asp') && !m[1].includes('latest.asp'))
      .map(m => stripHtmlTags(m[2]).trim())
      .filter(name => name.length > 0 && !/^\d+$/.test(name));

    let homeTeam = '';
    let awayTeam = '';

    if (teamNames.length >= 2) {
      homeTeam = teamNames[0];
      awayTeam = teamNames[1];
    } else {
      // Fallback: Parse from clean row text
      const fallbackMatch = cleanRowText.match(/(\d{1,2}:\d{2})\s+([A-Za-z0-9À-ÿ .'-]+?)\s+-\s+([A-Za-z0-9À-ÿ .'-]+?)(?=\s+\||$)/);
      if (fallbackMatch) {
        homeTeam = fallbackMatch[2].trim();
        awayTeam = fallbackMatch[3].trim();
      }
    }

    if (!homeTeam || !awayTeam) continue;

    fixtures.push({
      homeTeam,
      awayTeam,
      startTime,
      leagueCode,
      sourceMatchId,
    });
  }

  logger.info(`[SoccerStatsFixtures] Parsed ${fixtures.length} fixtures for ${leagueCode}`);
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
    } else {
      logger.warn('[SoccerStatsFixtures] Parsed 0 fixtures — possible markup change', { leagueCode });
    }

    return fixtures;
  } catch (err: any) {
    logger.error('[SoccerStatsFixtures] Fetch failed', { leagueCode, error: err.message });
    return [];
  }
}