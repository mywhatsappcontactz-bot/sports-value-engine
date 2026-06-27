// src/scrapers/tennis/tennisAbstractScraper.ts
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface TennisAbstractH2H {
  player1:      string;
  player2:      string;
  h2hWins:      { player1: number; player2: number };
  h2hTotal:     number;
  matches:      H2HMatch[];
  player1Stats: PlayerStats;
  player2Stats: PlayerStats;
}

export interface H2HMatch {
  date:       string;
  surface:    string;
  winner:     string;
  loser:      string;
  score:      string;
  tournament: string;
}

export interface PlayerStats {
  name:         string;
  careerWinPct: number;
  ytdWinPct:    number;
  surfaceBest:  string | null;
}

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — player stats move slowly
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function cacheKeyFor(player1: string, player2: string): string {
  // Order-independent so "A vs B" and "B vs A" share a cache entry
  const [a, b] = [player1, player2].sort();
  return `tennisabstract-h2h-${safeFileName(a)}-${safeFileName(b)}`;
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

function readCache(player1: string, player2: string): TennisAbstractH2H | null {
  try {
    const filePath = cachePath(cacheKeyFor(player1, player2));
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: { data: TennisAbstractH2H; fetchedAt: number } = JSON.parse(raw);

    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;

    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(player1: string, player2: string, data: TennisAbstractH2H): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const entry = { data, fetchedAt: Date.now() };
    fs.writeFileSync(cachePath(cacheKeyFor(player1, player2)), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[TennisAbstract] Failed to write cache', { player1, player2, error: err.message });
  }
}

// ─── URL BUILDER ─────────────────────────────────────────────────────────────

function toAbstractName(name: string): string {
  // "Taylor Fritz" → "TaylorFritz"
  return name.trim().split(/\s+/).map(w =>
    w.charAt(0).toUpperCase() + w.slice(1)
  ).join('');
}

function buildUrl(player1: string, player2: string): string {
  const p1 = toAbstractName(player1);
  const p2 = toAbstractName(player2);
  return `https://www.tennisabstract.com/cgi-bin/player.cgi?p=${p1}&f=ACareerqq&q=${p2}`;
}

// ─── PARSERS ─────────────────────────────────────────────────────────────────

function extractAllMatches(html: string): any[][] {
  const match = html.match(/var matchmx\s*=\s*(\[[\s\S]*?\]);\s*\n/);
  if (!match) return [];
  try {
    return JSON.parse(match[1]);
  } catch {
    return [];
  }
}

function extractPlayerStats(html: string, playerName: string): PlayerStats {
  const allMatches = extractAllMatches(html);

  const wins   = allMatches.filter(m => m[4] === 'W').length;
  const losses = allMatches.filter(m => m[4] === 'L').length;
  const total  = wins + losses;
  const careerWinPct = total > 0 ? wins / total : 0.5;

  const currentYear = new Date().getFullYear().toString();
  const ytdMatches = allMatches.filter(m => m[0]?.startsWith(currentYear));
  const ytdWins    = ytdMatches.filter(m => m[4] === 'W').length;
  const ytdTotal   = ytdMatches.length;
  const ytdWinPct  = ytdTotal > 0 ? ytdWins / ytdTotal : careerWinPct;

  const surfaceWins: Record<string, number> = {};
  allMatches.filter(m => m[4] === 'W').forEach(m => {
    const surf = m[2]?.toLowerCase();
    if (surf) surfaceWins[surf] = (surfaceWins[surf] || 0) + 1;
  });
  const surfaceBest = Object.keys(surfaceWins).length > 0
    ? Object.entries(surfaceWins).sort((a, b) => b[1] - a[1])[0][0]
    : null;

  return { name: playerName, careerWinPct, ytdWinPct, surfaceBest };
}

function parseH2HMatches(
  matchmx: any[][],
  player1: string,
  player2: string,
): { matches: H2HMatch[]; p1Wins: number; p2Wins: number } {
  const matches: H2HMatch[] = [];
  let p1Wins = 0;
  let p2Wins = 0;

  for (const row of matchmx) {
    const opponent = row[11] as string;
    if (!opponent) continue;

    const oppNorm = opponent.toLowerCase().replace(/\s+/g, '');
    const p2Norm  = player2.toLowerCase().replace(/\s+/g, '');
    if (!oppNorm.includes(p2Norm) && !p2Norm.includes(oppNorm)) continue;

    const date       = row[0] as string;
    const tournament = row[1] as string;
    const surface    = (row[2] as string)?.toLowerCase() || 'hard';
    const result     = row[4] as string;
    const score      = row[9] as string || '';

    const winner = result === 'W' ? player1 : player2;
    const loser  = result === 'W' ? player2 : player1;

    if (result === 'W') p1Wins++;
    else p2Wins++;

    matches.push({
      date:       `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`,
      surface,
      winner,
      loser,
      score,
      tournament,
    });
  }

  return { matches, p1Wins, p2Wins };
}

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function defaultFetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── MAIN SCRAPER ────────────────────────────────────────────────────────────

export async function scrapeTennisH2H(
  player1: string,
  player2: string,
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
): Promise<TennisAbstractH2H | null> {

  const cached = readCache(player1, player2);
  if (cached) {
    logger.info('[TennisAbstract] Cache hit (persistent)', { player1, player2 });
    return cached;
  }

  const url = buildUrl(player1, player2);

  try {
    logger.info('[TennisAbstract] Fetching H2H', { player1, player2, url });
    const html = await fetchHtml(url);

    const matchmx = extractAllMatches(html);
    if (!matchmx.length) {
      logger.warn('[TennisAbstract] No match data found', { player1, player2 });
      return null;
    }

    const { matches, p1Wins, p2Wins } = parseH2HMatches(matchmx, player1, player2);

    if (matches.length === 0) {
      logger.warn('[TennisAbstract] No H2H matches found', { player1, player2 });
    }

    const player1Stats = extractPlayerStats(html, player1);

    const url2 = buildUrl(player2, player1);
    let player2Stats: PlayerStats = { name: player2, careerWinPct: 0.5, ytdWinPct: 0.5, surfaceBest: null };
    try {
      const html2 = await fetchHtml(url2);
      player2Stats = extractPlayerStats(html2, player2);
    } catch {
      logger.warn('[TennisAbstract] Failed to fetch player2 stats', { player2 });
    }

    const result: TennisAbstractH2H = {
      player1,
      player2,
      h2hWins:  { player1: p1Wins, player2: p2Wins },
      h2hTotal: p1Wins + p2Wins,
      matches:  matches.slice(0, 6),
      player1Stats,
      player2Stats,
    };

    logger.info('[TennisAbstract] H2H fetched', {
      player1, player2,
      h2h: `${p1Wins}-${p2Wins}`,
      totalMatches: matches.length,
    });

    writeCache(player1, player2, result);
    return result;

  } catch (err: any) {
    logger.error('[TennisAbstract] Fetch failed', { player1, player2, error: err.message });
    return null;
  }
}