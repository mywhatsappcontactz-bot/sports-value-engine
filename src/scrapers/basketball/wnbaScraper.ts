// src/scrapers/basketball/wnbaScraper.ts
// Fetches WNBA H2H + team form data from stats.wnba.com/stats/leaguegamelog
// No auth required — needs specific headers to bypass bot check

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BASE_URL  = 'https://stats.wnba.com/stats/leaguegamelog';
const CACHE_DIR = path.join(process.cwd(), '.cache', 'wnba');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SEASONS   = ['2022', '2023', '2024', '2025', '2026'];

const HEADERS = {
  'Host':               'stats.wnba.com',
  'User-Agent':         'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':             'application/json, text/plain, */*',
  'Accept-Language':    'en-US,en;q=0.5',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token':  'true',
  'Origin':             'https://stats.wnba.com',
  'Referer':            'https://www.wnba.com/',
  'Connection':         'keep-alive',
};

// ─── ABBREVIATION MAP ─────────────────────────────────────────────────────────

const ABBREV_TO_NAME: Record<string, string> = {
  'ATL': 'Atlanta Dream',
  'CHI': 'Chicago Sky',
  'CON': 'Connecticut Sun',
  'DAL': 'Dallas Wings',
  'GSV': 'Golden State Valkyries',
  'IND': 'Indiana Fever',
  'LVA': 'Las Vegas Aces',
  'LA':  'Los Angeles Sparks',
  'MIN': 'Minnesota Lynx',
  'NYL': 'New York Liberty',
  'PHO': 'Phoenix Mercury',
  'POR': 'Portland Fire',
  'SEA': 'Seattle Storm',
  'TOR': 'Toronto Tempo',
  'WAS': 'Washington Mystics',
};

// ─── TYPES ────────────────────────────────────────────────────────────────────

interface GameRecord {
  date:     string;
  home:     string; // full team name
  away:     string;
  homePts:  number;
  awayPts:  number;
}

export interface WNBAFormGame {
  date:         string;
  opponent:     string;
  result:       'W' | 'L';
  goalsFor:     number; // points scored (named goalsFor for validator compatibility)
  goalsAgainst: number;
  venue:        'home' | 'away';
}

export interface WNBAh2hStats {
  homeTeam:      string;
  awayTeam:      string;
  overUnder35:   number; // % of games with total > 155pts
  btts:          number; // always 0 — not meaningful for basketball
  homeWin:       number;
  draw:          number; // always 0 in basketball
  awayWin:       number;
  pace:          number; // avg possessions proxy = avg total points
  recentMatches: { date: string; homeTeam: string; awayTeam: string; homeScore: number; awayScore: number }[];
  homeForm:      WNBAFormGame[];
  awayForm:      WNBAFormGame[];
}

// ─── CACHE ────────────────────────────────────────────────────────────────────

function cachePath(season: string): string {
  return path.join(CACHE_DIR, `wnba-gamelog-${season}.json`);
}

function readCache(season: string): GameRecord[] | null {
  try {
    const fp = cachePath(season);
    if (!fs.existsSync(fp)) return null;
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    if (Date.now() - raw.fetchedAt >= CACHE_TTL_MS) return null;
    return raw.games;
  } catch { return null; }
}

function writeCache(season: string, games: GameRecord[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(season), JSON.stringify({ fetchedAt: Date.now(), games }), 'utf-8');
  } catch (e: any) {
    logger.warn('[WNBA] Cache write failed', { season, error: e.message });
  }
}

// ─── FETCHER ──────────────────────────────────────────────────────────────────

async function fetchSeason(season: string): Promise<GameRecord[]> {
  const cached = readCache(season);
  if (cached) {
    logger.info('[WNBA] Cache hit', { season });
    return cached;
  }

  const url = `${BASE_URL}?Counter=0&Direction=DESC&LeagueID=10&PlayerOrTeam=T&Season=${season}&SeasonType=Regular+Season&Sorter=DATE`;
  logger.info('[WNBA] Fetching season', { season });

  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for season ${season}`);

  const data   = await res.json() as any;
  const rows: any[][] = data.resultSets[0].rowSet;
  const hdrs: string[] = data.resultSets[0].headers;

  const idx      = (col: string) => hdrs.indexOf(col);
  const iGAME_ID = idx('GAME_ID');
  const iMATCHUP = idx('MATCHUP');
  const iDATE    = idx('GAME_DATE');
  const iPTS     = idx('PTS');
  const iABBREV  = idx('TEAM_ABBREVIATION');

  // Build game map — each game appears twice (one row per team)
  const gameMap = new Map<string, any[][]>();
  for (const row of rows) {
    const gameId = row[iGAME_ID];
    if (!gameMap.has(gameId)) gameMap.set(gameId, []);
    gameMap.get(gameId)!.push(row);
  }

  const games: GameRecord[] = [];
  const seen = new Set<string>();

  for (const [gameId, teamRows] of gameMap) {
    if (teamRows.length !== 2 || seen.has(gameId)) continue;
    seen.add(gameId);

    const homeRow = teamRows.find(r => (r[iMATCHUP] as string).includes('vs.'));
    const awayRow = teamRows.find(r => (r[iMATCHUP] as string).includes('@'));
    if (!homeRow || !awayRow) continue;

    const homeName = ABBREV_TO_NAME[homeRow[iABBREV]] ?? homeRow[iABBREV];
    const awayName = ABBREV_TO_NAME[awayRow[iABBREV]] ?? awayRow[iABBREV];

    games.push({
      date:    homeRow[iDATE] as string,
      home:    homeName,
      away:    awayName,
      homePts: homeRow[iPTS] as number,
      awayPts: awayRow[iPTS] as number,
    });
  }

  logger.info('[WNBA] Season parsed', { season, games: games.length });
  writeCache(season, games);
  return games;
}

// ─── FORM BUILDER ─────────────────────────────────────────────────────────────

function buildForm(allGames: GameRecord[], teamName: string, limit = 10): WNBAFormGame[] {
  const norm = (s: string) => s.toLowerCase().trim();
  const tn   = norm(teamName);

  return allGames
    .filter(g => norm(g.home) === tn || norm(g.away) === tn)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit)
    .map(g => {
      const isHome = norm(g.home) === tn;
      const scored   = isHome ? g.homePts : g.awayPts;
      const conceded = isHome ? g.awayPts : g.homePts;
      return {
        date:         g.date,
        opponent:     isHome ? g.away : g.home,
        result:       scored > conceded ? 'W' : 'L',
        goalsFor:     scored,
        goalsAgainst: conceded,
        venue:        isHome ? 'home' : 'away',
      } as WNBAFormGame;
    });
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function fetchWNBAH2H(
  homeTeam: string,
  awayTeam: string,
): Promise<WNBAh2hStats | null> {

  const norm = (s: string) => s.toLowerCase().trim();
  const hn   = norm(homeTeam);
  const an   = norm(awayTeam);

  // Collect all seasons
  const allGames: GameRecord[] = [];
  for (const season of SEASONS) {
    try {
      const games = await fetchSeason(season);
      allGames.push(...games);
    } catch (e: any) {
      logger.warn('[WNBA] Season fetch failed', { season, error: e.message });
    }
  }

  if (!allGames.length) return null;

  // ── H2H ──────────────────────────────────────────────────────────────────
  const h2h = allGames
    .filter(g =>
      (norm(g.home) === hn && norm(g.away) === an) ||
      (norm(g.home) === an && norm(g.away) === hn)
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);

  if (!h2h.length) {
    logger.warn('[WNBA] No H2H records found', { homeTeam, awayTeam });
    return null;
  }

  // ── COMPUTE H2H STATS ────────────────────────────────────────────────────
  let homeWins = 0, awayWins = 0, over155 = 0;
  const recentMatches = [];

  for (const g of h2h) {
    const isHomeTeamHome = norm(g.home) === hn;
    const hScore = isHomeTeamHome ? g.homePts : g.awayPts;
    const aScore = isHomeTeamHome ? g.awayPts : g.homePts;

    if (hScore > aScore) homeWins++;
    else awayWins++;

    if (g.homePts + g.awayPts > 155) over155++;

    recentMatches.push({
      date:      g.date,
      homeTeam:  g.home,
      awayTeam:  g.away,
      homeScore: g.homePts,
      awayScore: g.awayPts,
    });
  }

  const total = h2h.length;

  // ── PACE — avg total points across all H2H games ─────────────────────────
  const avgTotal = h2h.reduce((s, g) => s + g.homePts + g.awayPts, 0) / total;
  const pace     = parseFloat(avgTotal.toFixed(1));

  // ── FORM ─────────────────────────────────────────────────────────────────
  const homeForm = buildForm(allGames, homeTeam);
  const awayForm = buildForm(allGames, awayTeam);

  return {
    homeTeam,
    awayTeam,
    overUnder35: Math.round((over155 / total) * 100),
    btts:        0,
    homeWin:     Math.round((homeWins / total) * 100),
    draw:        0,
    awayWin:     Math.round((awayWins / total) * 100),
    pace,
    recentMatches,
    homeForm,
    awayForm,
  };
}