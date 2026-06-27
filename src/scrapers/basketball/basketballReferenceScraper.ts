// src/scrapers/basketball/basketballReferenceScraper.ts
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface WNBATeamStats {
  teamName:    string;
  teamCode:    string;
  games:       number;
  pointsFor:   number;     // total season points scored
  pointsAgainst: number;   // total season points allowed
  ppgFor:      number;     // points per game scored
  ppgAgainst:  number;     // points per game allowed
}

// ─── TEAM CODE MAP ─────────────────────────────────────────────────────────
// Maps team names (as they appear in The Odds API) to Basketball-Reference codes
export const WNBA_TEAM_CODES: Record<string, string> = {
  'Minnesota Lynx':      'MIN',
  'Las Vegas Aces':      'LVA',
  'Atlanta Dream':       'ATL',
  'New York Liberty':    'NYL',
  'Connecticut Sun':     'CON',
  'Chicago Sky':         'CHI',
  'Washington Mystics':  'WAS',
  'Los Angeles Sparks':  'LAS',
  'Indiana Fever':       'IND',
  'Phoenix Mercury':     'PHO',
  'Seattle Storm':       'SEA',
  'Dallas Wings':        'DAL',
  'Golden State Valkyries': 'GSV',
  'Toronto Tempo':       'TOR',
};

const SEASON = '2026';

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — team scoring stats update after each game
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function cachePath(teamCode: string): string {
  return path.join(CACHE_DIR, `bball-ref-${safeFileName(teamCode)}-${SEASON}.json`);
}

function readCache(teamCode: string): WNBATeamStats | null {
  try {
    const filePath = cachePath(teamCode);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: { data: WNBATeamStats; fetchedAt: number } = JSON.parse(raw);

    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;

    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(teamCode: string, data: WNBATeamStats): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const entry = { data, fetchedAt: Date.now() };
    fs.writeFileSync(cachePath(teamCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[BballRef] Failed to write cache', { teamCode, error: err.message });
  }
}

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function defaultFetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── PARSER ──────────────────────────────────────────────────────────────────

function parseTeamPage(html: string, teamName: string, teamCode: string): WNBATeamStats | null {
  // "Team" row — confirmed structure:
  // <tr ><th ... data-stat="type" >Team</th><td data-stat="g">16</td>...<td data-stat="pts">1477</td></tr>
  const teamRowMatch = html.match(
    /data-stat="type"\s*>Team<\/th>([\s\S]{0,2000}?)<\/tr>/
  );
  if (!teamRowMatch) {
    logger.warn('[BballRef] Could not find Team row', { teamName });
    return null;
  }

  const teamRow = teamRowMatch[1];
  const gamesMatch = teamRow.match(/data-stat="g"\s*>(\d+)</);
  const ptsMatch = teamRow.match(/data-stat="pts"\s*>(\d+)</);

  if (!gamesMatch || !ptsMatch) {
    logger.warn('[BballRef] Could not extract games/pts from Team row', { teamName });
    return null;
  }

  const games = parseInt(gamesMatch[1], 10);
  const pointsFor = parseInt(ptsMatch[1], 10);

  // "Opp/G" row has the pre-calculated per-game opponent points — simpler than dividing manually
  const oppPerGameMatch = html.match(
    /data-stat="type"\s*>Opp\/G<\/th>[\s\S]{0,2000}?data-stat="opp_pts_per_g"\s*>([\d.]+)</
  );
  // Fallback: "Opponent" row total points if Opp/G isn't found
  const oppTotalMatch = html.match(
    /data-stat="type"\s*>Opponent<\/th>([\s\S]{0,2000}?)<\/tr>/
  );

  let ppgAgainst: number;
  let pointsAgainst: number;

  if (oppPerGameMatch) {
    ppgAgainst = parseFloat(oppPerGameMatch[1]);
    pointsAgainst = Math.round(ppgAgainst * games);
  } else if (oppTotalMatch) {
    const oppPtsMatch = oppTotalMatch[1].match(/data-stat="opp_pts"\s*>(\d+)</);
    pointsAgainst = oppPtsMatch ? parseInt(oppPtsMatch[1], 10) : 0;
    ppgAgainst = games > 0 ? pointsAgainst / games : 0;
  } else {
    logger.warn('[BballRef] Could not find opponent points data', { teamName });
    return null;
  }

  const ppgFor = games > 0 ? pointsFor / games : 0;

  return {
    teamName,
    teamCode,
    games,
    pointsFor,
    pointsAgainst,
    ppgFor: parseFloat(ppgFor.toFixed(2)),
    ppgAgainst: parseFloat(ppgAgainst.toFixed(2)),
  };
}

// ─── MAIN SCRAPER ────────────────────────────────────────────────────────────

export async function scrapeWNBATeamStats(
  teamName: string,
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
): Promise<WNBATeamStats | null> {

  const teamCode = WNBA_TEAM_CODES[teamName];
  if (!teamCode) {
    logger.warn('[BballRef] Unknown team — no code mapping', { teamName });
    return null;
  }

  const cached = readCache(teamCode);
  if (cached) {
    logger.info('[BballRef] Cache hit (persistent)', { teamName });
    return cached;
  }

  const url = `https://www.basketball-reference.com/wnba/teams/${teamCode}/${SEASON}.html`;

  try {
    logger.info('[BballRef] Fetching team stats', { teamName, url });
    const html = await fetchHtml(url);

    const stats = parseTeamPage(html, teamName, teamCode);
    if (!stats) return null;

    logger.info('[BballRef] Team stats fetched', {
      teamName,
      ppgFor: stats.ppgFor,
      ppgAgainst: stats.ppgAgainst,
      games: stats.games,
    });

    writeCache(teamCode, stats);
    return stats;

  } catch (err: any) {
    logger.error('[BballRef] Fetch failed', { teamName, error: err.message });
    return null;
  }
}