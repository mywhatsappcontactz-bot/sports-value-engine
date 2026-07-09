// src/scrapers/football/footballDataScraper.ts
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { H2HStats, H2HMatch } from './fcStatsScraper';

type FDCOSource =
  | { type: 'new'; code: string }
  | { type: 'season'; code: string; seasons: string[] };

export const FDCO_LEAGUE_MAP: Record<string, FDCOSource> = {
  'Allsvenskan - Sweden':         { type: 'new', code: 'SWE' },
  'Superettan - Sweden':          { type: 'new', code: 'SWE2' },
  'Eliteserien - Norway':         { type: 'new', code: 'NOR' },
  'Veikkausliiga - Finland':      { type: 'new', code: 'FIN' },
  'Austrian Football Bundesliga': { type: 'new', code: 'AUT' },
  'Denmark Superliga':            { type: 'new', code: 'DNK' },
  'Ligue 1 - France':             { type: 'new', code: 'FRA' },
  'EPL':                          { type: 'season', code: 'E0',  seasons: ['2526', '2425', '2324'] },
  'La Liga - Spain':              { type: 'season', code: 'SP1', seasons: ['2526', '2425', '2324'] },
  'La Liga 2 - Spain':            { type: 'season', code: 'SP2', seasons: ['2526', '2425', '2324'] },
  'Bundesliga - Germany':         { type: 'season', code: 'D1',  seasons: ['2526', '2425', '2324'] },
  'Dutch Eredivisie':             { type: 'season', code: 'N1',  seasons: ['2526', '2425', '2324'] },
  'Championship':                 { type: 'season', code: 'E1',  seasons: ['2526', '2425', '2324'] },
  'League 1':                     { type: 'season', code: 'E2',  seasons: ['2526', '2425', '2324'] },
  'League 2':                     { type: 'season', code: 'E3',  seasons: ['2526', '2425', '2324'] },
};

interface FDCOMatch {
  date: string;
  home: string;
  away: string;
  hg:   number;
  ag:   number;
  res:  'H' | 'D' | 'A';
}

interface FDCOLeagueCache {
  code:      string;
  matches:   FDCOMatch[];
  fetchedAt: number;
}

const FDCO_BASE_NEW    = 'https://www.football-data.co.uk/new';
const FDCO_BASE_SEASON = 'https://www.football-data.co.uk/mmz4281';
const CACHE_TTL_MS     = 3 * 24 * 60 * 60 * 1000; // 3 days -- H2H history barely changes day to day
const CACHE_DIR        = path.join(__dirname, '../../../.cache/stats');
const MAX_H2H_MATCHES  = 10;

function fdcoCachePath(cacheKey: string): string {
  return path.join(CACHE_DIR, `fdco-${cacheKey.toLowerCase().replace(/[^a-z0-9]/g, '_')}.json`);
}

function readFDCOCache(cacheKey: string): FDCOLeagueCache | null {
  try {
    const p = fdcoCachePath(cacheKey);
    if (!fs.existsSync(p)) return null;
    const entry: FDCOLeagueCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeFDCOCache(cacheKey: string, data: FDCOLeagueCache): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(fdcoCachePath(cacheKey), JSON.stringify(data), 'utf-8');
  } catch (err: any) {
    logger.warn('[FDCO] Failed to write cache', { cacheKey, error: err.message });
  }
}

function parseNewCSV(csv: string): FDCOMatch[] {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {
    date: headers.indexOf('date'),
    home: headers.indexOf('home'),
    away: headers.indexOf('away'),
    hg:   headers.indexOf('hg'),
    ag:   headers.indexOf('ag'),
    res:  headers.indexOf('res'),
  };
  const matches: FDCOMatch[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const res  = cols[idx.res]?.trim();
    if (!res || !['H', 'D', 'A'].includes(res)) continue;
    const hg = parseInt(cols[idx.hg]);
    const ag = parseInt(cols[idx.ag]);
    if (isNaN(hg) || isNaN(ag)) continue;
    matches.push({ date: cols[idx.date]?.trim() ?? '', home: cols[idx.home]?.trim() ?? '', away: cols[idx.away]?.trim() ?? '', hg, ag, res: res as 'H' | 'D' | 'A' });
  }
  return matches;
}

function parseSeasonCSV(csv: string): FDCOMatch[] {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {
    date: headers.indexOf('date'),
    home: headers.indexOf('hometeam'),
    away: headers.indexOf('awayteam'),
    hg:   headers.indexOf('fthg'),
    ag:   headers.indexOf('ftag'),
    res:  headers.indexOf('ftr'),
  };
  const matches: FDCOMatch[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const res  = cols[idx.res]?.trim();
    if (!res || !['H', 'D', 'A'].includes(res)) continue;
    const hg = parseInt(cols[idx.hg]);
    const ag = parseInt(cols[idx.ag]);
    if (isNaN(hg) || isNaN(ag)) continue;
    matches.push({ date: cols[idx.date]?.trim() ?? '', home: cols[idx.home]?.trim() ?? '', away: cols[idx.away]?.trim() ?? '', hg, ag, res: res as 'H' | 'D' | 'A' });
  }
  return matches;
}

async function fetchCSV(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' } });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

function normTeam(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(if|fk|bk|sk|ff|aif|afc|fc|bff|ik|hk|il|sc|ac|ss|as|cf|cd|rc|rcd|ud|sd|cp|ssd|us|sp)\b/g, '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamSimilarity(a: string, b: string): number {
  const na = normTeam(a);
  const nb = normTeam(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

function bestTeamMatch(name: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    const score = teamSimilarity(name, c);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 0.5 ? best : null;
}

function parseDate(ddmmyyyy: string): string {
  const parts = ddmmyyyy.split('/');
  if (parts.length !== 3) return ddmmyyyy;
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

async function fetchLeagueMatches(leagueName: string, source: FDCOSource): Promise<FDCOMatch[] | null> {
  const cached = readFDCOCache(leagueName);
  if (cached) {
    logger.info('[FDCO] Cache hit', { leagueName, matches: cached.matches.length });
    return cached.matches;
  }

  let matches: FDCOMatch[] = [];

  if (source.type === 'new') {
    const url = `${FDCO_BASE_NEW}/${source.code}.csv`;
    logger.info('[FDCO] Downloading multi-season CSV', { url });
    const csv = await fetchCSV(url);
    if (!csv) { logger.error('[FDCO] Download failed', { url }); return null; }
    matches = parseNewCSV(csv);
  } else {
    for (const season of source.seasons) {
      const url = `${FDCO_BASE_SEASON}/${season}/${source.code}.csv`;
      logger.info('[FDCO] Downloading season CSV', { url });
      const csv = await fetchCSV(url);
      if (!csv) { logger.warn('[FDCO] Season download failed', { url }); continue; }
      matches.push(...parseSeasonCSV(csv));
    }
  }

  if (matches.length === 0) { logger.error('[FDCO] No matches parsed', { leagueName }); return null; }

  logger.info('[FDCO] CSV parsed', { leagueName, matches: matches.length });
  writeFDCOCache(leagueName, { code: leagueName, matches, fetchedAt: Date.now() });
  return matches;
}

export function computeH2H(allMatches: FDCOMatch[], homeTeam: string, awayTeam: string): H2HStats | null {
  const teamNames = [...new Set(allMatches.flatMap(m => [m.home, m.away]))];
  const csvHome   = bestTeamMatch(homeTeam, teamNames);
  const csvAway   = bestTeamMatch(awayTeam, teamNames);

  if (!csvHome || !csvAway) {
    logger.warn('[FDCO] Could not match team names', { homeTeam, awayTeam, csvHome, csvAway });
    return null;
  }

  logger.info('[FDCO] Team name match', { homeTeam, csvHome, awayTeam, csvAway });

  const h2hMatches = allMatches
    .filter(m =>
      (normTeam(m.home) === normTeam(csvHome) && normTeam(m.away) === normTeam(csvAway)) ||
      (normTeam(m.home) === normTeam(csvAway) && normTeam(m.away) === normTeam(csvHome))
    )
    .sort((a, b) => parseDate(b.date).localeCompare(parseDate(a.date)))
    .slice(0, MAX_H2H_MATCHES);

  if (h2hMatches.length === 0) {
    logger.warn('[FDCO] No H2H matches found', { csvHome, csvAway });
    return null;
  }

  const recentMatches: H2HMatch[] = h2hMatches.map(m => ({
    date: parseDate(m.date), homeTeam: m.home, awayTeam: m.away, homeScore: m.hg, awayScore: m.ag,
  }));

  const n           = h2hMatches.length;
  const over35Count = h2hMatches.filter(m => m.hg + m.ag > 3.5).length;
  const bttsCount   = h2hMatches.filter(m => m.hg > 0 && m.ag > 0).length;
  let homeWins = 0, draws = 0, awayWins = 0;

  for (const m of h2hMatches) {
    const isHomeTeamHome = normTeam(m.home) === normTeam(csvHome);
    if (m.res === 'D') { draws++; continue; }
    if ((m.res === 'H' && isHomeTeamHome) || (m.res === 'A' && !isHomeTeamHome)) homeWins++;
    else awayWins++;
  }

  return {
    homeTeam, awayTeam,
    overUnder35: Math.round((over35Count / n) * 100),
    btts:        Math.round((bttsCount / n) * 100),
    homeWin:     Math.round((homeWins / n) * 100),
    draw:        Math.round((draws / n) * 100),
    awayWin:     Math.round((awayWins / n) * 100),
    recentMatches,
  };
}

export async function fetchFDCOH2H(homeTeam: string, awayTeam: string, leagueName: string): Promise<H2HStats | null> {
  const source = FDCO_LEAGUE_MAP[leagueName];
  if (!source) {
    logger.warn('[FDCO] No CSV source for league', { leagueName });
    return null;
  }
  const matches = await fetchLeagueMatches(leagueName, source);
  if (!matches) return null;
  return computeH2H(matches, homeTeam, awayTeam);
}