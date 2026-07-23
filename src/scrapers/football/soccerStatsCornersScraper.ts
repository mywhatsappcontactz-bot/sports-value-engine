// src/scrapers/football/soccerStatsCornersScraper.ts
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface CornerTeamStats {
  teamName: string;
  gp: number;
  totalCornersFor: number;
  totalCornersAgainst: number;
  homeCornersFor: number;
  homeCornersAgainst: number;
  awayCornersFor: number;
  awayCornersAgainst: number;
}

export interface CornerLeagueData {
  leagueKey: string;
  teams: Map<string, CornerTeamStats>; // normalized team name → stats
  fetchedAt: number;
}

interface SerializedCornerLeagueData {
  leagueKey: string;
  teams: [string, CornerTeamStats][];
  fetchedAt: number;
}

// ─── LEAGUE MAP (soccerstats.com codes) ─────────────────────────────────────
// CONFIRMED via direct fetch + real data returned: england, spain, germany.
// CONFIRMED via consistent nav pattern (seen identically across 3 fetches):
// spain2, italy — not independently fetched, but the {country}/{country}2
// pairing held 3/3 times observed.
// UNCONFIRMED — commented out below. Verify against soccerstats.com/leagues.asp
// before use; these leagues may not exist on this site or use different codes.
export const SOCCERSTATS_LEAGUE_MAP: Record<string, string> = {
  'EPL': 'england',
  'Championship': 'england2',
  'League 1': 'england3',
  'League 2': 'england4',
  'La Liga - Spain': 'spain',
  'La Liga 2 - Spain': 'spain2',
  'Bundesliga - Germany': 'germany',
  '2. Bundesliga - Germany': 'germany2',
  'Serie A - Italy': 'italy',
  'Turkey': 'turkey',
  'Netherlands - Eredivisie': 'netherlands',
  'Scotland - Premiership': 'scotland',
  // 'Belgium': 'belgium', // confirmed code correct but 0 corners data — season not yet started
  // UNCONFIRMED — verify before use:
  // 'Veikkausliiga - Finland': 'finland',   // seen in nav, not independently fetched
  // 'Eliteserien - Norway': 'norway',       // seen in nav, not independently fetched
  // 'K League 1': 'southkorea',             // seen in nav, not independently fetched
  // 'Super League - China': '???',          // NOT in soccerstats.com nav — likely unsupported
};

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function cornersCachePath(leagueName: string): string {
  return path.join(CACHE_DIR, `soccerstats-corners-${safeFileName(leagueName)}.json`);
}

function readCornersCache(leagueName: string): CornerLeagueData | null {
  try {
    const filePath = cornersCachePath(leagueName);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: SerializedCornerLeagueData = JSON.parse(raw);

    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;

    return {
      leagueKey: entry.leagueKey,
      teams: new Map(entry.teams),
      fetchedAt: entry.fetchedAt,
    };
  } catch (err: any) {
    logger.warn('[SoccerStatsCorners] Cache read failed', { leagueName, error: err.message });
    return null;
  }
}

function writeCornersCache(leagueName: string, data: CornerLeagueData): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const entry: SerializedCornerLeagueData = {
      leagueKey: data.leagueKey,
      teams: Array.from(data.teams.entries()),
      fetchedAt: data.fetchedAt,
    };

    fs.writeFileSync(cornersCachePath(leagueName), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[SoccerStatsCorners] Failed to write cache', { leagueName, error: err.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://www.soccerstats.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// Words too generic to count as a real match signal on their own — "Derry
// City" and "Manchester City" sharing only "city" was scoring 0.3+ and
// passing as a match. Stripped before comparison so overlap has to come
// from an actual distinguishing part of the name.
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

  if (ta.size === 0 || tb.size === 0) return 0; // nothing left to compare — no real signal

  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── PARSER ──────────────────────────────────────────────────────────────────
// The page contains three sequential tables — Total, Home, Away — each with
// rows shaped: <a href='teamstats.asp?...'>{TeamName}</a> ... GP ... For ... Against ... Total
// We split the raw HTML into three blocks by locating each section's header
// text, then run the same per-row regex against each block.

interface RawRow {
  teamName: string;
  gp: number;
  cornersFor: number;
  cornersAgainst: number;
}

function parseRows(block: string): RawRow[] {
  const rows: RawRow[] = [];

  // Confirmed against real markup (see corners-raw.html):
  // <a href='teamstats.asp?league=england&stats=u324-arsenal' target='_top'>Arsenal</a>&nbsp;</td>
  // <td align='center'><font color='green'>38</font></td>
  // <td align='center'><font color='blue'>
  // 5.68</font></td>
  // <td align='center'><font color='
  // #C70039'>
  // 3.32</font></td>
  // Numbers can be split onto their own line after the <font> tag opens,
  // and the color hex itself can wrap onto a new line — [\s\S]*? handles both.
  const rowRegex =
    /<a href='teamstats\.asp\?league=\w+&stats=[^']+' target='_top'>([^<]+)<\/a>[\s\S]*?<font color='green'>(\d+)<\/font>[\s\S]*?<font color='blue'>\s*([\d.]+)<\/font>[\s\S]*?<font color='\s*#C70039'>\s*([\d.]+)<\/font>/g;

  let m;
  while ((m = rowRegex.exec(block)) !== null) {
    const [, teamName, gp, cornersFor, cornersAgainst] = m;
    rows.push({
      teamName: teamName.trim(),
      gp: parseInt(gp, 10),
      cornersFor: parseFloat(cornersFor),
      cornersAgainst: parseFloat(cornersAgainst),
    });
  }

  return rows;
}

function splitIntoBlocks(html: string): { total: string; home: string; away: string } {
  // Confirmed real section markers (see corners-raw.html):
  // <h2 ...>Corners (home and away)</h2>
  // <h2 ...>Corners (home)</h2>
  // <h2 ...>Corners (away)</h2>
  const totalIdx = html.indexOf('Corners (home and away)');
  const homeIdx = html.indexOf('Corners (home)');
  const awayIdx = html.indexOf('Corners (away)');

  if (totalIdx === -1 || homeIdx === -1 || awayIdx === -1) {
    logger.warn('[SoccerStatsCorners] Could not locate all three section markers — parsing whole page as Total only');
    return { total: html, home: '', away: '' };
  }

  return {
    total: html.slice(totalIdx, homeIdx),
    home: html.slice(homeIdx, awayIdx),
    away: html.slice(awayIdx),
  };
}

function parseCornersPage(html: string): Map<string, CornerTeamStats> {
  const teams = new Map<string, CornerTeamStats>();
  const { total, home, away } = splitIntoBlocks(html);

  const totalRows = parseRows(total);
  const homeRows = parseRows(home);
  const awayRows = parseRows(away);

  for (const t of totalRows) {
    const key = normalize(t.teamName);
    const h = homeRows.find((r) => normalize(r.teamName) === key);
    const a = awayRows.find((r) => normalize(r.teamName) === key);

    teams.set(key, {
      teamName: t.teamName,
      gp: t.gp,
      totalCornersFor: t.cornersFor,
      totalCornersAgainst: t.cornersAgainst,
      homeCornersFor: h?.cornersFor ?? 0,
      homeCornersAgainst: h?.cornersAgainst ?? 0,
      awayCornersFor: a?.cornersFor ?? 0,
      awayCornersAgainst: a?.cornersAgainst ?? 0,
    });
  }

  logger.info(`[SoccerStatsCorners] Parsed ${teams.size} teams`, {
    total: totalRows.length,
    home: homeRows.length,
    away: awayRows.length,
  });

  return teams;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function fetchCornersData(leagueName: string): Promise<CornerLeagueData | null> {
  const cached = readCornersCache(leagueName);
  if (cached) {
    logger.info('[SoccerStatsCorners] Cache hit (persistent)', { leagueName });
    return cached;
  }

  const leagueCode = SOCCERSTATS_LEAGUE_MAP[leagueName];
  if (!leagueCode) {
    logger.warn('[SoccerStatsCorners] No league code for', { leagueName });
    return null;
  }

  try {
    const html = await fetchHtml(`${BASE}/table.asp?league=${leagueCode}&tid=cr`);
    const teams = parseCornersPage(html);

    if (teams.size === 0) {
      logger.warn('[SoccerStatsCorners] No teams parsed', { leagueName });
      return null;
    }

    const result: CornerLeagueData = {
      leagueKey: leagueCode,
      teams,
      fetchedAt: Date.now(),
    };
    writeCornersCache(leagueName, result);
    return result;
  } catch (err: any) {
    logger.error('[SoccerStatsCorners] Fetch failed', { leagueName, error: err.message });
    return null;
  }
}

export function findCornersTeam(leagueData: CornerLeagueData, teamName: string): CornerTeamStats | null {
  const key = normalize(teamName);
  if (leagueData.teams.has(key)) return leagueData.teams.get(key)!;

  let best: CornerTeamStats | null = null;
  let bestScore = 0;

  for (const [k, stats] of leagueData.teams) {
    const score = similarity(key, k);
    if (score > bestScore) {
      bestScore = score;
      best = stats;
    }
  }

  return bestScore >= 0.5 ? best : null;
}