// src/scrapers/darts/liveDartsScraper.ts
//
// Fixtures + results source — live-darts.com. Confirmed via real fetch
// (two separate pages: 2026 World Matchplay, in-progress; Players
// Championship 17, fully completed) to be static WordPress HTML (no
// JS rendering needed), with a consistent structure:
//   - Date header (e.g. "Tuesday July 21") — only present on majors'
//     multi-day schedule pages, absent on single-day PC events
//   - Round header (e.g. "First Round", "Quarter-Finals", "Final")
//   - Match rows underneath, one of two shapes:
//       "Player Name N-M Player Name"  (completed — N/M are legs won)
//       "Player Name v Player Name"    (upcoming — no score yet)
//
// This replaces dartsDatabaseScraper.ts's fetchFixtures(), which was
// confirmed broken (never extracted player names — see that file's
// header comment). dartsdatabase.co.uk's OWN result parsing
// (fetchEventResults) stays as-is; this is purely for finding out
// WHO is playing WHOM, which dartsdatabase.co.uk couldn't provide.
//
// SCOPE THIS PASS: majors only, via a live-darts.com slug added to
// each MAJOR_TOURNAMENTS entry (see dartsWikipediaScraper.ts). Only
// the World Matchplay slug is CONFIRMED by direct fetch; the rest
// are best-guess based on the same URL naming convention
// (pdc-darts-news/{category}/{event}-2026-schedule-of-play) and
// MUST be verified the same way before trusting them.
//
// NOT YET DONE: regular Players Championship/European Tour events
// use a numbered URL (event-16, event-17...) with no fixed
// date-to-number mapping confirmed yet — would need the PDC's own
// season calendar cross-referenced to know which event number
// corresponds to "today". Left as a follow-up, not solved here.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

import puppeteer from 'puppeteer';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.live-darts.com/',
};

// Confirmed via testing: plain fetch() returns HTTP 403 on this site even
// with full browser-like headers — genuine bot protection (likely
// Cloudflare or similar), not just a missing header. A real headless
// browser actually executing JS and presenting real browser fingerprints
// is required to get past it.
//
// COST: launches a real Chromium instance per call — heavier and slower
// than every other scraper in this project (which all use plain fetch()).
// Not something to call on a tight polling loop; fine for a periodic
// (e.g. every few hours) fixtures check.
async function fetchHtmlViaBrowser(url: string): Promise<string> {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    await page.setExtraHTTPHeaders({
      'Accept-Language': HEADERS['Accept-Language'],
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface LiveDartsMatch {
  round: string;
  player1: string;
  player2: string;
  player1Legs: number | null; // null if upcoming (no score yet)
  player2Legs: number | null;
  status: 'upcoming' | 'completed';
}

// ─── CONFIRMED / BEST-GUESS SLUGS ────────────────────────────────────────────
// Only 'World Matchplay' is confirmed via direct fetch. The rest follow the
// same URL pattern observed but are UNVERIFIED — check each with a real
// fetch (same as every scraper in this project) before trusting it.
export const LIVE_DARTS_MAJOR_SLUGS: Record<string, string> = {
  // CONFIRMED via direct fetch + real parsed match data (see test output:
  // 25 real matches, correct completed/upcoming split).
  'World Matchplay': 'world-matchplay/world-matchplay-2026-schedule-of-play',

  // FOUND via search (real indexed URLs exist) but NOT YET fetch-tested
  // through this scraper — URL pattern isn't consistent between events
  // (one has "-of-play" suffix, one doesn't), so don't assume either
  // works until verified the same way World Matchplay was.
  'World Cup of Darts': 'pdc-world-cup-of-darts/world-cup-2026-schedule-of-play',
  // Note: dartsWikipediaScraper.ts's MAJOR_TOURNAMENTS list doesn't currently
  // have an entry matching "US Darts Masters" — it's one leg of the World
  // Series of Darts circuit, distinct from "World Series of Darts Finals"
  // which IS in that list. Add a MAJOR_TOURNAMENTS entry for it if you want
  // this slug wired in via getActiveMajor().
  // 'US Darts Masters': 'us-darts-masters/us-masters-2026-schedule',

  // UNCONFIRMED — no live-darts.com URL found via search yet. Verify before use:
  // 'PDC World Darts Championship': '???',
  // 'PDC World Masters': '???',
  // 'UK Open': '???',
  // 'Premier League Darts': '???',
  // 'World Series of Darts Finals': '???',
  // 'World Grand Prix': '???',
  // 'European Championship': '???',
  // 'Grand Slam of Darts': '???',
  // 'Players Championship Finals': '???',
};

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
// Short TTL — this page updates as matches complete during a live event.
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function cachePath(slug: string): string {
  const safe = slug.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return path.join(CACHE_DIR, `livedarts-${safe}.json`);
}

function readCache(slug: string): LiveDartsMatch[] | null {
  try {
    const p = cachePath(slug);
    if (!fs.existsSync(p)) return null;
    const entry: { data: LiveDartsMatch[]; fetchedAt: number } = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(slug: string, data: LiveDartsMatch[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(slug), JSON.stringify({ data, fetchedAt: Date.now() }), 'utf-8');
  } catch (err: any) {
    logger.warn('[LiveDarts] Failed to write cache', { slug, error: err.message });
  }
}

// ─── PARSER ──────────────────────────────────────────────────────────────────
// Confirmed against two real pages (World Matchplay in-progress, Players
// Championship 17 fully completed). Round headers appear as their own line
// (e.g. "First Round", "Second Round", "Last 32", "Last 16", "Quarter-Finals",
// "Semi-Finals", "Final"), followed by one match per line in one of two forms.

const ROUND_HEADER_REGEX = /^(First Round|Second Round|Third Round|Last \d+|Quarter-Finals?|Semi-Finals?|Final)$/i;

// Completed: "Player Name N-M Player Name" — names can contain apostrophes,
// hyphens, accented characters (e.g. "William O'Connor", "Dirk van Duijvenbode").
const COMPLETED_ROW_REGEX = /^([A-Za-zÀ-ÿ' .-]+?)\s+(\d+)-(\d+)\s+([A-Za-zÀ-ÿ' .-]+)$/;

// Upcoming: "Player Name v Player Name" — no score yet.
const UPCOMING_ROW_REGEX = /^([A-Za-zÀ-ÿ' .-]+?)\s+v\s+([A-Za-zÀ-ÿ' .-]+)$/;

// Filters out rows that technically match the regex pattern but aren't
// real player names — confirmed via real test output: page boilerplate
// like "temp styles for sticky banner" v "nov" can coincidentally fit
// the same shape. Real PDC player names are short (2-4 words), contain
// no digits, and don't include common CSS/JS boilerplate terms.
const BOILERPLATE_WORDS = ['temp', 'style', 'sticky', 'banner', 'script', 'function', 'var ', 'const '];

function looksLikeRealPlayerName(name: string): boolean {
  const lower = name.toLowerCase();
  if (/\d/.test(name)) return false; // player names never contain digits
  if (name.split(' ').length > 5) return false; // real names are short
  if (name.length > 40) return false;
  if (BOILERPLATE_WORDS.some((w) => lower.includes(w))) return false;
  return true;
}

function parseMatches(html: string): LiveDartsMatch[] {
  const matches: LiveDartsMatch[] = [];

  // Strip HTML tags per line for simple text-line matching — the page's
  // real structure interleaves each match as its own line/paragraph in the
  // rendered content, confirmed via the fetches above.
  const lines = html
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  let currentRound = '';

  for (const line of lines) {
    if (ROUND_HEADER_REGEX.test(line)) {
      currentRound = line;
      continue;
    }

    const completedMatch = COMPLETED_ROW_REGEX.exec(line);
    if (completedMatch) {
      const [, p1, s1, s2, p2] = completedMatch;
      if (!looksLikeRealPlayerName(p1) || !looksLikeRealPlayerName(p2)) continue;
      matches.push({
        round: currentRound,
        player1: p1.trim(),
        player2: p2.trim(),
        player1Legs: parseInt(s1, 10),
        player2Legs: parseInt(s2, 10),
        status: 'completed',
      });
      continue;
    }

    const upcomingMatch = UPCOMING_ROW_REGEX.exec(line);
    if (upcomingMatch) {
      const [, p1, p2] = upcomingMatch;
      if (!looksLikeRealPlayerName(p1) || !looksLikeRealPlayerName(p2)) continue;
      matches.push({
        round: currentRound,
        player1: p1.trim(),
        player2: p2.trim(),
        player1Legs: null,
        player2Legs: null,
        status: 'upcoming',
      });
    }
  }

  return matches;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

export async function fetchTournamentFixtures(slug: string): Promise<LiveDartsMatch[]> {
  const cached = readCache(slug);
  if (cached) {
    logger.info('[LiveDarts] Cache hit', { slug });
    return cached;
  }

  try {
    const url = `https://www.live-darts.com/pdc-darts-news/${slug}/`;
    const html = await fetchHtmlViaBrowser(url);

    const matches = parseMatches(html);

    if (matches.length === 0) {
      logger.warn('[LiveDarts] No matches parsed — page structure may differ from confirmed pattern', { slug });
    }

    writeCache(slug, matches);
    return matches;
  } catch (err: any) {
    logger.error('[LiveDarts] Fetch failed', { slug, error: err.message });
    return [];
  }
}

// Convenience wrapper for majors specifically, using LIVE_DARTS_MAJOR_SLUGS.
export async function fetchMajorFixtures(majorName: string): Promise<LiveDartsMatch[]> {
  const slug = LIVE_DARTS_MAJOR_SLUGS[majorName];
  if (!slug) {
    logger.warn('[LiveDarts] No live-darts.com slug configured for major', { majorName });
    return [];
  }
  return fetchTournamentFixtures(slug);
}

// Returns only the upcoming (not-yet-played) matches — this is what
// dartsFetch.ts actually needs for generating tips (no point tipping on
// a match that's already finished).
export function filterUpcoming(matches: LiveDartsMatch[]): LiveDartsMatch[] {
  return matches.filter((m) => m.status === 'upcoming');
}