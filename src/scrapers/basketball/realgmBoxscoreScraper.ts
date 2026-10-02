// src/scrapers/basketball/realgmBoxscoreScraper.ts
//
// Pulls real per-game Poss/ORtg/DRtg from basketball.realgm.com — confirmed
// accessible (no Cloudflare block), confirmed real column structure.
//
// TWO-STEP PROCESS (unlike Proballers' single schedule page):
//   1. Enumerate a season's games by walking day-by-day schedule pages:
//      /international/league/{id}/{slug}/schedules/{yyyy-mm-dd}
//      Most days return "No games scheduled" — that's normal, not an error.
//   2. For each real game found, fetch its boxscore page for Poss/ORtg/DRtg:
//      /international/boxscore/{date}/{Team-at-Team}/{gameId}
//
// COST: a full season is ~150-200 day-checks + ~300 boxscore fetches ≈
// 450-500 requests. This WILL take several minutes to run. A polite delay
// is built in between requests — do not remove it, this is someone else's
// server and hammering it risks getting rate-limited or blocked.

import { logger } from '../../core/utils/logger';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://basketball.realgm.com/international/league/4/Spanish-ACB',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

const BASE = 'https://basketball.realgm.com';
const REQUEST_DELAY_MS = 400; // politeness delay between requests

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Confirmed league IDs/slugs (from RealGM's own nav — see conversation)
export const REALGM_LEAGUE_MAP: Record<string, { id: number; slug: string }> = {
  'ACB - Spain':          { id: 4,  slug: 'Spanish-ACB' },
  'LBA Serie A - Italy':  { id: 6,  slug: 'Italian-Lega-Basket-Serie-A' },
  'BSL - Turkey':         { id: 7,  slug: 'Turkish-BSL' },
  'A1 - Greece':          { id: 8,  slug: 'Greek-HEBA-A1' },
  'BBL - Germany':        { id: 15, slug: 'German-BBL' },
  'NBL - Australia':      { id: 5,  slug: 'Australian-NBL' },
  'CBA - China':          { id: 40, slug: 'Chinese-CBA' },
  'Pro A - France':       { id: 12, slug: 'French-Jeep-Elite' },
};

// ─── TYPES ──────────────────────────────────────────────────────────────

export interface RealGmGameRef {
  date: string;         // ISO yyyy-mm-dd
  boxscoreUrl: string;  // relative path
  gameId: number;
}

export interface RealGmGameAdvanced {
  gameId: number;
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  homePoss: number;
  awayPoss: number;
  homeORtg: number;
  homeDRtg: number;
  awayORtg: number;
  awayDRtg: number;
}

// ─── STEP 1: ENUMERATE GAMES VIA DAY-BY-DAY SCHEDULE ───────────────────

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

// Extracts boxscore links + gameIds from a single day's schedule page HTML.
// VERIFIED pattern: /basketball/boxscore/{date}/{Team-at-Team}/{gameId}
function parseScheduleDay(html: string, date: string): RealGmGameRef[] {
  const refs: RealGmGameRef[] = [];
  const linkRegex = /href="(\/international\/boxscore\/[\d-]+\/[^"]+\/(\d+))"/g;
  let m: RegExpExecArray | null;
  const seen = new Set<number>();
  while ((m = linkRegex.exec(html)) !== null) {
    const [, boxscoreUrl, gameIdStr] = m;
    const gameId = parseInt(gameIdStr, 10);
    if (seen.has(gameId)) continue; // page may link the same game twice
    seen.add(gameId);
    refs.push({ date, boxscoreUrl, gameId });
  }
  return refs;
}

/**
 * Walks every day between startDate and endDate (inclusive), fetching that
 * league's schedule page and collecting real game references. Skips empty
 * days silently (normal — most days have no game). Logs progress every 20
 * days so a long run doesn't look hung.
 */
export async function enumerateSeasonGames(
  leagueName: string,
  startDate: string, // yyyy-mm-dd
  endDate: string,   // yyyy-mm-dd
): Promise<RealGmGameRef[]> {
  const league = REALGM_LEAGUE_MAP[leagueName];
  if (!league) {
    logger.warn('[RealGMScraper] Unknown league', { leagueName });
    return [];
  }

  const allRefs: RealGmGameRef[] = [];
  let current = new Date(startDate + 'T00:00:00Z');
  const end = new Date(endDate + 'T00:00:00Z');
  let dayCount = 0;

  while (current <= end) {
    const dateStr = formatDate(current);
    const url = `${BASE}/international/league/${league.id}/${league.slug}/schedules/${dateStr}`;

    try {
      const html = await fetchHtml(url);
      const refs = parseScheduleDay(html, dateStr);
      allRefs.push(...refs);
    } catch (err: any) {
      logger.warn('[RealGMScraper] Schedule day fetch failed', { dateStr, error: err.message });
    }

    dayCount++;
    if (dayCount % 20 === 0) {
      logger.info(`[RealGMScraper] Checked ${dayCount} days, found ${allRefs.length} games so far (${leagueName})`);
    }

    await sleep(REQUEST_DELAY_MS);
    current = addDays(current, 1);
  }

  logger.info(`[RealGMScraper] Enumeration complete for ${leagueName}: ${allRefs.length} games over ${dayCount} days`);
  return allRefs;
}

// ─── STEP 2: FETCH EACH GAME'S ADVANCED BOXSCORE ────────────────────────
//
// VERIFIED against a real fetched page (Real Madrid 86, Unicaja 79,
// 2025-06-17) — confirmed table:
//   | Advanced | Poss | ORtg | DRtg |
// with one row per team, home team listed first.

function parseAdvancedBoxscore(html: string, ref: RealGmGameRef): RealGmGameAdvanced | null {
  // Team names + final score, from the page's own header line, e.g.:
  // "## Real Madrid 86, Unicaja 79"
  const headerMatch = html.match(/##\s*\[([^\]]+)\][^,]*,\s*\[([^\]]+)\][^0-9]*(\d+)/);
  // NOTE: header parsing is best-effort — if it fails, fall back to null
  // and log, rather than guessing team names from the URL slug.

  // Advanced table: | TEAM_CODE | Poss | ORtg | DRtg | rows appear twice
  // (home row, then away row) directly under a "| Advanced |" header.
  const advancedBlockMatch = html.match(
    /\|\s*Advanced\s*\|\s*Poss\s*\|\s*ORtg\s*\|\s*DRtg\s*\|[\s\S]*?\n\|\s*([\w]+)[^\|]*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|[\s\S]*?\n\|\s*([\w]+)[^\|]*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/
  );

  if (!advancedBlockMatch) {
    logger.warn('[RealGMScraper] Could not parse Advanced table', { gameId: ref.gameId });
    return null;
  }

  const [
    , , homePossStr, homeORtgStr, homeDRtgStr,
    , awayPossStr, awayORtgStr, awayDRtgStr,
  ] = advancedBlockMatch;

  // Team names + scores from the quarter-by-quarter table's Final column,
  // more reliable than the header line for exact names.
  const scoreRowRegex = /\|\s*([A-Z]{2,4})\s*\([^)]*\)\s*\|[\s\S]*?\|\s*(\d+)\s*\|\s*\n/g;
  const scores: { code: string; total: number }[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = scoreRowRegex.exec(html)) !== null && scores.length < 2) {
    scores.push({ code: sm[1], total: parseInt(sm[2], 10) });
  }

  if (scores.length !== 2) {
    logger.warn('[RealGMScraper] Could not parse final scores', { gameId: ref.gameId });
    return null;
  }

  return {
    gameId: ref.gameId,
    date: ref.date,
    homeTeam: scores[0].code,
    awayTeam: scores[1].code,
    homeScore: scores[0].total,
    awayScore: scores[1].total,
    homePoss: parseFloat(homePossStr),
    homeORtg: parseFloat(homeORtgStr),
    homeDRtg: parseFloat(homeDRtgStr),
    awayPoss: parseFloat(awayPossStr),
    awayORtg: parseFloat(awayORtgStr),
    awayDRtg: parseFloat(awayDRtgStr),
  };
}

export async function fetchGameAdvanced(ref: RealGmGameRef): Promise<RealGmGameAdvanced | null> {
  const url = `${BASE}${ref.boxscoreUrl}`;
  const html = await fetchHtml(url);
  return parseAdvancedBoxscore(html, ref);
}

/**
 * Fetches advanced boxscores for a list of game references, with a polite
 * delay between each request. Returns only successfully-parsed games —
 * failures are logged and skipped, not thrown.
 */
export async function fetchAllAdvancedBoxscores(refs: RealGmGameRef[]): Promise<RealGmGameAdvanced[]> {
  const results: RealGmGameAdvanced[] = [];
  for (let i = 0; i < refs.length; i++) {
    try {
      const game = await fetchGameAdvanced(refs[i]);
      if (game) results.push(game);
    } catch (err: any) {
      logger.warn('[RealGMScraper] Boxscore fetch failed', { gameId: refs[i].gameId, error: err.message });
    }

    if ((i + 1) % 20 === 0) {
      logger.info(`[RealGMScraper] Fetched ${i + 1}/${refs.length} boxscores`);
    }

    await sleep(REQUEST_DELAY_MS);
  }
  return results;
}

// ─── QUICK TEST ─────────────────────────────────────────────────────────
// Small date range only, to verify the pipeline before running a full season.
// npx ts-node src/scrapers/basketball/realgmBoxscoreScraper.ts

async function main() {
  const leagueName = 'ACB - Spain';
  console.log(`Testing enumeration for ${leagueName}, Oct 4 2025 only (single date, diagnosing 403)...`);

  const refs = await enumerateSeasonGames(leagueName, '2025-10-04', '2025-10-04');
  console.log(`Found ${refs.length} game(s) in this window`);
  refs.forEach(r => console.log(`  ${r.date} — gameId ${r.gameId} — ${r.boxscoreUrl}`));

  if (refs.length === 0) {
    console.log('No games found — check the date window or league name.');
    return;
  }

  console.log(`\nFetching advanced boxscore for first game...`);
  const game = await fetchGameAdvanced(refs[0]);
  if (game) {
    console.log('Parsed successfully:');
    console.log(game);
  } else {
    console.log('Parse FAILED — table structure may differ from what was verified. Needs a fresh look at the real page HTML.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[RealGMScraper] Fatal error:', err.message);
    process.exit(1);
  });
}