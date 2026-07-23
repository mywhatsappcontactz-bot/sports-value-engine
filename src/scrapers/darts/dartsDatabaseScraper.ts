// src/scrapers/darts/dartsDatabaseScraper.ts
//
// Primary darts data source — dartsdatabase.co.uk. Free, plain HTML,
// no Cloudflare/bot-blocking (confirmed by direct fetch). Covers ALL
// PDC events (majors + regular Pro Tour/Euro Tour), not just majors.
//
// CONFIRMED LIVE (fetched directly this session):
//   - Homepage (https://www.dartsdatabase.co.uk/) — nav structure,
//     "Today's Games" section, day navigation via ?day=-1/0/1
//   - player-profile-live.php?pid=X — career + current-year stats
//   - display-event.php?eid=X&tna=...&eda=... — per-match results
//     with 3-dart average per player (confirmed via a real
//     PDPA Players Championship 24 page, NOT just majors)
//
// NOT YET CONFIRMED (structure below is a best-effort guess pending
// a real fetch + verification, same as any new scraper — expect to
// need a debug/inspection pass similar to what we did for FCStats
// league IDs before trusting this in production):
//   - set-head-2-head.php?p1id=X&p1na=Name — URL confirmed to EXIST
//     (seen as a real link on the player profile page), but its
//     actual page content/HTML structure has not been fetched or
//     parsed yet.
//   - Fixtures/schedule page structure for a day with actual games
//     scheduled (homepage showed "No games scheduled for this day"
//     on the day we checked — need a live matchday to confirm markup).
//
// Given the above, treat this file as a first pass: run the debug
// pattern (view raw HTML around real matches) before trusting
// fetchH2H() or fetchFixtures() results in the actual pipeline.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

const BASE = 'https://www.dartsdatabase.co.uk';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface DartsPlayerStats {
  pid:            string;
  name:           string;
  careerAverage:  number;
  currentAverage: number;
  careerGamesWon: number;
  careerGamesPlayed: number;
  careerWinPct:   number;
  currentGamesWon: number;
  currentGamesPlayed: number;
  currentWinPct:  number;
  nineDarters:    number;
}

export interface DartsFixture {
  eventId:    string;
  eventName:  string;
  date:       string;
  player1:    string;
  player2:    string;
  round:      string | null;
}

export interface DartsMatchResult {
  player1:     string;
  player2:     string;
  player1Avg:  number | null;
  player2Avg:  number | null;
  player1Legs: number;
  player2Legs: number;
  round:       string | null;
}

export interface DartsEventResults {
  eventId:    string;
  eventName:  string;
  date:       string;
  matches:    DartsMatchResult[];
}

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
// Player career/current stats change slowly (once per completed match) —
// safe to cache for a day. Fixtures need to be fresh — short TTL.
// H2H history is effectively static between two specific players outside
// of new meetings — cache longer, same reasoning as FDCO's 3-day TTL.

const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');
const PLAYER_CACHE_TTL_MS  = 24 * 60 * 60 * 1000;      // 24 hours
const FIXTURE_CACHE_TTL_MS = 60 * 60 * 1000;           // 1 hour
const EVENT_CACHE_TTL_MS   = 24 * 60 * 60 * 1000;      // 24 hours (completed events don't change)

function cachePath(prefix: string, key: string): string {
  const safe = key.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return path.join(CACHE_DIR, `darts-${prefix}-${safe}.json`);
}

function readCache<T>(prefix: string, key: string, ttlMs: number): T | null {
  try {
    const p = cachePath(prefix, key);
    if (!fs.existsSync(p)) return null;
    const entry: { data: T; fetchedAt: number } = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - entry.fetchedAt >= ttlMs) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache<T>(prefix: string, key: string, data: T): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(prefix, key), JSON.stringify({ data, fetchedAt: Date.now() }), 'utf-8');
  } catch (err: any) {
    logger.warn('[DartsDB] Failed to write cache', { prefix, key, error: err.message });
  }
}

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── NAME MATCHING (same pattern as fcStatsScraper) ──────────────────────────
// Currently unused now that live search/H2H are gone — kept for when
// PLAYER_ID_MAP is built, to fuzzy-match odds/fixture player names
// (which may have slightly different formatting) against map keys.

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── PLAYER STATS ─────────────────────────────────────────────────────────────
// Confirmed structure from player-profile-live.php?pid=3097 (Gabriel Clemens):
//   "Games Won  ### from ### played" / "Winning Pct  ##.##%" / "Average  ##.##"
//   appears TWICE — once under "Career Statistics", once under
//   "Current Years Statistics". Parsing pulls both blocks in document order.

export async function fetchPlayerStats(pid: string): Promise<DartsPlayerStats | null> {
  const cached = readCache<DartsPlayerStats>('player', pid, PLAYER_CACHE_TTL_MS);
  if (cached) {
    logger.info('[DartsDB] Player cache hit', { pid });
    return cached;
  }

  try {
    const html = await fetchHtml(`${BASE}/player-profile-live.php?pid=${pid}`);

    const nameMatch = /<title>([^|<]+?) Player Profile<\/title>/i.exec(html);
    const name = nameMatch ? nameMatch[1].trim() : `Player ${pid}`;

    // Pulls "Games Won ### from ### played", "Winning Pct ##.##%", "Average ##.##"
    // — appears once for Career, once for Current Year, in that document order.
    const gamesWonBlocks = [...html.matchAll(/Games Won[\s\S]{0,60}?(\d+)\s*from\s*(\d+)\s*played/gi)];
    const winPctBlocks   = [...html.matchAll(/Winning Pct[\s\S]{0,60}?([\d.]+)%/gi)];
    const avgBlocks      = [...html.matchAll(/Average[\s\S]{0,60}?([\d.]+)/gi)];
    const nineDartMatch  = /9 Darters[\s\S]{0,60}?(\d+)/i.exec(html);

    if (gamesWonBlocks.length < 2 || avgBlocks.length < 2) {
      logger.warn('[DartsDB] Could not parse expected career+current stat blocks', { pid, name });
      return null;
    }

    const stats: DartsPlayerStats = {
      pid,
      name,
      careerGamesWon:     parseInt(gamesWonBlocks[0][1], 10),
      careerGamesPlayed:  parseInt(gamesWonBlocks[0][2], 10),
      careerWinPct:       parseFloat(winPctBlocks[0]?.[1] ?? '0'),
      careerAverage:      parseFloat(avgBlocks[0][1]),
      currentGamesWon:    parseInt(gamesWonBlocks[1][1], 10),
      currentGamesPlayed: parseInt(gamesWonBlocks[1][2], 10),
      currentWinPct:      parseFloat(winPctBlocks[1]?.[1] ?? '0'),
      currentAverage:     parseFloat(avgBlocks[1][1]),
      nineDarters:        nineDartMatch ? parseInt(nineDartMatch[1], 10) : 0,
    };

    writeCache('player', pid, stats);
    return stats;

  } catch (err: any) {
    logger.error('[DartsDB] Player fetch failed', { pid, error: err.message });
    return null;
  }
}

// ─── H2H — NOT SOURCED FROM THIS SITE ────────────────────────────────────────
// dartsdatabase.co.uk's own H2H search (set-head-2-head.php) was tested
// three separate times (different field names, different encodings) and
// consistently returned an unrelated static block (World Cup of Darts
// doubles-team pairings) regardless of the search input. This isn't a
// parsing bug on our end — the endpoint itself doesn't appear to filter
// by the posted player name in practice.
//
// INSTEAD: build H2H yourself from accumulated fetchEventResults() data.
// Every scan stores match results (player names, scores, dates) via
// upsertStats-style persistence, same pattern as football's FDCO/FCStats
// H2H (computed from stored match history, not a live third-party lookup).
// Once enough events have been scraped over time, a simple query — "find
// all stored matches where both of these player names appear" — gives
// you real H2H without depending on this site's broken search feature.
// This is arguably more robust: it's self-building and never depends on
// dartsdatabase.co.uk staying correct.
//
// See src/core/engine/ (wherever football's H2H-from-history logic lives)
// for the equivalent pattern to replicate here once darts match storage
// is wired into the database.

// ─── EVENT RESULTS ────────────────────────────────────────────────────────────
// Confirmed structure from a real display-event.php page (PDPA Players
// Championship 24, 07/07/2026): rows of
//   "PlayerA (avg)   N V M   PlayerB (avg)"
// e.g. "Mickey Mansell (91.61)  6 V 4  Mike de Decker (91.68)"
// No round labels were visible in the pasted sample (flat "Last 128"
// heading covers a whole round) — round is derived from section headers
// like "Last 128", "Last 64" etc. if present, else null.

export async function fetchEventResults(eventId: string, eventName: string = '', date: string = ''): Promise<DartsEventResults | null> {
  const cached = readCache<DartsEventResults>('event', eventId, EVENT_CACHE_TTL_MS);
  if (cached) {
    logger.info('[DartsDB] Event cache hit', { eventId });
    return cached;
  }

  try {
    const url = `${BASE}/display-event.php?eid=${eventId}`;
    const html = await fetchHtml(url);

    // Matches: "Player Name (##.##)  N V M  Player Name (##.##)"
    const matchRegex = /([A-Za-zÀ-ÿ' .-]+?)\s*\(([\d.]+)\)\s*(\d+)\s*V\s*(\d+)\s*([A-Za-zÀ-ÿ' .-]+?)\s*\(([\d.]+)\)/g;

    const matches: DartsMatchResult[] = [];
    let m;
    let currentRound: string | null = null;

    // Split by round headers (e.g. "Last 128", "Last 64", "Quarter-Finals")
    // to tag matches with their round — best-effort, may need refinement
    // once tested against a bracket that includes later rounds.
    const roundHeaderRegex = /(Last \d+|Quarter-Finals?|Semi-Finals?|Final)/gi;

    while ((m = matchRegex.exec(html)) !== null) {
      const [, p1, avg1, s1, s2, p2, avg2] = m;

      // find the nearest preceding round header
      const precedingText = html.slice(0, m.index);
      const roundMatches = [...precedingText.matchAll(roundHeaderRegex)];
      currentRound = roundMatches.length ? roundMatches[roundMatches.length - 1][1] : null;

      matches.push({
        player1: p1.trim(),
        player2: p2.trim(),
        player1Avg: parseFloat(avg1),
        player2Avg: parseFloat(avg2),
        player1Legs: parseInt(s1, 10),
        player2Legs: parseInt(s2, 10),
        round: currentRound,
      });
    }

    if (matches.length === 0) {
      logger.warn('[DartsDB] No matches parsed from event page', { eventId });
      return null;
    }

    const result: DartsEventResults = {
      eventId,
      eventName,
      date,
      matches,
    };

    writeCache('event', eventId, result);
    return result;

  } catch (err: any) {
    logger.error('[DartsDB] Event fetch failed', { eventId, error: err.message });
    return null;
  }
}

// ─── FIXTURES ─────────────────────────────────────────────────────────────────
// UNVERIFIED STRUCTURE — homepage showed "Today's Games" section but the
// day we checked had "No games scheduled for this day", so the markup
// for an ACTUAL scheduled fixture has not been seen. dayOffset uses the
// confirmed ?day=-1/0/1 query param pattern from the homepage links.
//
// TODO before production use: fetch this on a day with real fixtures
// scheduled and rewrite the regex against actual markup.

export async function fetchFixtures(dayOffset: number = 0): Promise<DartsFixture[]> {
  const cacheKey = `day_${dayOffset}`;
  const cached = readCache<DartsFixture[]>('fixtures', cacheKey, FIXTURE_CACHE_TTL_MS);
  if (cached) {
    logger.info('[DartsDB] Fixtures cache hit', { dayOffset });
    return cached;
  }

  try {
    const url = `${BASE}/?day=${dayOffset}`;
    const html = await fetchHtml(url);

    if (html.includes('No games scheduled for this day')) {
      logger.info('[DartsDB] No fixtures scheduled', { dayOffset });
      writeCache('fixtures', cacheKey, []);
      return [];
    }

    // PLACEHOLDER PARSE — unverified against a real matchday. Best guess
    // based on the event-link pattern seen elsewhere on the site
    // (display-event.php?eid=X&tna=...&eda=...).
    const fixtureRegex = /display-event\.php\?eid=(\d+)&tna=([^&]+)&eda=(\d+)/g;

    const fixtures: DartsFixture[] = [];
    let m;
    while ((m = fixtureRegex.exec(html)) !== null) {
      const [, eid, tna, eda] = m;
      fixtures.push({
        eventId: eid,
        eventName: decodeURIComponent(tna.replace(/\+/g, ' ')),
        date: eda,
        player1: '', // not extractable from this pattern alone — needs real markup
        player2: '',
        round: null,
      });
    }

    if (fixtures.length === 0) {
      logger.warn('[DartsDB] Fixtures page had content but no matches parsed — parser needs adjustment', { dayOffset });
    }

    writeCache('fixtures', cacheKey, fixtures);
    return fixtures;

  } catch (err: any) {
    logger.error('[DartsDB] Fixtures fetch failed', { dayOffset, error: err.message });
    return [];
  }
}

// ─── PLAYER SEARCH — NOT VIABLE VIA PLAIN FETCH ──────────────────────────────
// player-searcher.php's results render into <div id="player-results"></div>
// via client-side JS/AJAX after page load — confirmed empty in the raw
// server response. A plain fetch() only gets the empty shell, never the
// actual matching players.
//
// PRACTICAL WORKAROUND: maintain a static PLAYER_ID_MAP (name → pid) for
// your known player pool — realistic for darts since the active PDC Tour
// Card holder pool is small (~100-150 players), unlike thousands of
// footballers across many leagues. Populate this map manually/incrementally
// as new player names appear in fixtures/event results — pid only needs
// to be looked up once per player, ever, since it's a permanent site ID.
//
// Example:
// export const PLAYER_ID_MAP: Record<string, string> = {
//   'gabriel clemens': '3097',
//   // add pids as you encounter new players in fixtures/events
// };
//
// If a name isn't in the map yet, fetchPlayerStats() simply can't run for
// that player until a pid is added — a manageable gap, not a blocker,
// since fetchEventResults() (fixtures/scores) doesn't need a pid at all.