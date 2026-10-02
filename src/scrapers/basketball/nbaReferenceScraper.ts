// src/scrapers/basketball/nbaReferenceScraper.ts
//
// NBA counterpart to basketballReferenceScraper.ts (which, despite its
// generic name, is WNBA-only — see WNBA_TEAM_CODES / scrapeWNBATeamStats
// there). Same Basketball-Reference page structure and parsing approach,
// pointed at the /nba/ section instead of /wnba/.
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface NBATeamStats {
  teamName:      string;
  teamCode:      string;
  games:         number;
  pointsFor:     number;     // total season points scored
  pointsAgainst: number;     // total season points allowed
  ppgFor:        number;     // points per game scored
  ppgAgainst:    number;     // points per game allowed
  pace?:         number;     // real possessions-based pace (Team Ratings table) — not always present, e.g. early season
}

// ─── TEAM CODE MAP ─────────────────────────────────────────────────────────
// Maps team names (as they appear in The Odds API) to Basketball-Reference
// codes. NBA team names/codes are stable year to year (unlike WNBA, which
// has had recent expansion/relocation — Golden State Valkyries, Toronto
// Tempo, etc. — so this list should need far less maintenance).
export const NBA_TEAM_CODES: Record<string, string> = {
  'Atlanta Hawks':          'ATL',
  'Boston Celtics':         'BOS',
  'Brooklyn Nets':          'BRK',
  'Charlotte Hornets':      'CHO',
  'Chicago Bulls':          'CHI',
  'Cleveland Cavaliers':    'CLE',
  'Dallas Mavericks':       'DAL',
  'Denver Nuggets':         'DEN',
  'Detroit Pistons':        'DET',
  'Golden State Warriors':  'GSW',
  'Houston Rockets':        'HOU',
  'Indiana Pacers':         'IND',
  'LA Clippers':            'LAC',
  'Los Angeles Clippers':   'LAC',
  'Los Angeles Lakers':     'LAL',
  'Memphis Grizzlies':      'MEM',
  'Miami Heat':             'MIA',
  'Milwaukee Bucks':        'MIL',
  'Minnesota Timberwolves': 'MIN',
  'New Orleans Pelicans':   'NOP',
  'New York Knicks':        'NYK',
  'Oklahoma City Thunder':  'OKC',
  'Orlando Magic':          'ORL',
  'Philadelphia 76ers':     'PHI',
  'Phoenix Suns':           'PHO',
  'Portland Trail Blazers': 'POR',
  'Sacramento Kings':       'SAC',
  'San Antonio Spurs':      'SAS',
  'Toronto Raptors':        'TOR',
  'Utah Jazz':              'UTA',
  'Washington Wizards':     'WAS',
};

// NBA season notation on Basketball-Reference uses the year the season
// ENDS in (e.g. the 2025-26 season is "2026") — same convention already
// used by SEASON in basketballReferenceScraper.ts.
const SEASON = '2026';

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────

const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — team scoring stats update after each game
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function cachePath(teamCode: string): string {
  return path.join(CACHE_DIR, `nba-ref-${safeFileName(teamCode)}-${SEASON}.json`);
}

function readCache(teamCode: string): NBATeamStats | null {
  try {
    const filePath = cachePath(teamCode);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: { data: NBATeamStats; fetchedAt: number } = JSON.parse(raw);

    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;

    return entry.data;
  } catch {
    return null;
  }
}

function writeCache(teamCode: string, data: NBATeamStats): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const entry = { data, fetchedAt: Date.now() };
    fs.writeFileSync(cachePath(teamCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[NbaRef] Failed to write cache', { teamCode, error: err.message });
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
// Verified against a real fetch of basketball-reference.com/teams/LAL/2026.html
// (31 Jul 2026). NBA team pages use data-stat="player" for row labels — NOT
// data-stat="type" like the WNBA page — and the opponent-per-game row is
// labeled "Opponent/G", not "Opp/G". Confirmed real row/field examples from
// that fetch: Team row -> g=82, pts=9540; Opponent/G row -> opp_pts_per_g=114.6.
function parseTeamPage(html: string, teamName: string, teamCode: string): NBATeamStats | null {
  const teamRowMatch = html.match(
    /data-stat="player"\s*>Team<\/th>([\s\S]{0,2000}?)<\/tr>/
  );
  if (!teamRowMatch) {
    logger.warn('[NbaRef] Could not find Team row', { teamName });
    return null;
  }

  const teamRow = teamRowMatch[1];
  const gamesMatch = teamRow.match(/data-stat="g"\s*>(\d+)</);
  const ptsMatch = teamRow.match(/data-stat="pts"\s*>(\d+)</);

  if (!gamesMatch || !ptsMatch) {
    logger.warn('[NbaRef] Could not extract games/pts from Team row', { teamName });
    return null;
  }

  const games = parseInt(gamesMatch[1], 10);
  const pointsFor = parseInt(ptsMatch[1], 10);

  const oppPerGameMatch = html.match(
    /data-stat="player"\s*>Opponent\/G<\/th>([\s\S]{0,2000}?)<\/tr>/
  );
  const oppTotalMatch = html.match(
    /data-stat="player"\s*>Opponent<\/th>([\s\S]{0,2000}?)<\/tr>/
  );

  let ppgAgainst: number;
  let pointsAgainst: number;

  if (oppTotalMatch) {
    // Prefer the exact total — more precise than deriving from the
    // per-game figure, which is itself rounded to 1 decimal on the page
    // (e.g. 114.6 * 82 = 9397.2 → rounds to 9397, one off from the real
    // 9396 total).
    const oppPtsMatch = oppTotalMatch[1].match(/data-stat="opp_pts"\s*>(\d+)</);
    if (!oppPtsMatch) {
      logger.warn('[NbaRef] Found Opponent row but no opp_pts field', { teamName });
      return null;
    }
    pointsAgainst = parseInt(oppPtsMatch[1], 10);
    ppgAgainst = games > 0 ? pointsAgainst / games : 0;
  } else if (oppPerGameMatch) {
    const oppPerGamePts = oppPerGameMatch[1].match(/data-stat="opp_pts_per_g"\s*>([\d.]+)</);
    if (!oppPerGamePts) {
      logger.warn('[NbaRef] Found Opponent/G row but no opp_pts_per_g field', { teamName });
      return null;
    }
    ppgAgainst = parseFloat(oppPerGamePts[1]);
    pointsAgainst = Math.round(ppgAgainst * games);
  } else {
    logger.warn('[NbaRef] Could not find opponent points data', { teamName });
    return null;
  }

  const ppgFor = games > 0 ? pointsFor / games : 0;

  // Real pace, from the separate Team Ratings table (data-stat="player" >Team<
  // row again, but in the table that has data-stat="pace" — distinguished by
  // requiring the pace field itself to be present nearby). Optional: not
  // fatal if missing (e.g. very early season, or B-R changes this table).
  let pace: number | undefined;
  const paceTableMatch = html.match(
    /data-stat="player"\s*>Team<\/th>((?:(?!<\/tr>)[\s\S]){0,3000}?data-stat="pace"\s*>([\d.]+)<)/
  );
  if (paceTableMatch) {
    pace = parseFloat(paceTableMatch[2]);
  }

  return {
    teamName,
    teamCode,
    games,
    pointsFor,
    pointsAgainst,
    ppgFor: parseFloat(ppgFor.toFixed(2)),
    ppgAgainst: parseFloat(ppgAgainst.toFixed(2)),
    ...(pace !== undefined ? { pace } : {}),
  };
}

// ─── MAIN SCRAPER ────────────────────────────────────────────────────────────

export async function scrapeNBATeamStats(
  teamName: string,
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
): Promise<NBATeamStats | null> {

  const teamCode = NBA_TEAM_CODES[teamName];
  if (!teamCode) {
    logger.warn('[NbaRef] Unknown team — no code mapping', { teamName });
    return null;
  }

  const cached = readCache(teamCode);
  if (cached) {
    logger.info('[NbaRef] Cache hit (persistent)', { teamName });
    return cached;
  }

  const url = `https://www.basketball-reference.com/teams/${teamCode}/${SEASON}.html`;

  try {
    logger.info('[NbaRef] Fetching team stats', { teamName, url });
    const html = await fetchHtml(url);

    const stats = parseTeamPage(html, teamName, teamCode);
    if (!stats) return null;

    logger.info('[NbaRef] Team stats fetched', {
      teamName,
      ppgFor: stats.ppgFor,
      ppgAgainst: stats.ppgAgainst,
      games: stats.games,
    });

    writeCache(teamCode, stats);
    return stats;

  } catch (err: any) {
    logger.error('[NbaRef] Fetch failed', { teamName, error: err.message });
    return null;
  }
}