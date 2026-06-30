// src/scrapers/football/footballDataScraper.ts
//
// Downloads historical match CSVs from football-data.co.uk (/new/ path).
// Computes H2H locally — no per-match HTTP calls, no blocking, 24hr cache.
//
// CSV columns: Country,League,Season,Date,Time,Home,Away,HG,AG,Res,...
// URL pattern: https://www.football-data.co.uk/new/{CODE}.csv

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { H2HStats, H2HMatch } from './fcStatsScraper';

// ─── LEAGUE CONFIG ──────────────────────────────────────────────────────────

export const FDCO_LEAGUE_MAP: Record<string, string> = {
  'Allsvenskan - Sweden':    'SWE',
  'Superettan - Sweden':     'SWE2',
  'Eliteserien - Norway':    'NOR',
  'Veikkausliiga - Finland': 'FIN',
  'League of Ireland':       'IRL',
  'Super League - China':    'CHN',
};

const FDCO_BASE = 'https://www.football-data.co.uk/new';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');
const MAX_H2H_MATCHES = 10;

// ─── TYPES ───────────────────────────────────────────────────────────────────

interface FDCOMatch {
  season: string;
  date:   string;
  home:   string;
  away:   string;
  hg:     number;
  ag:     number;
  res:    'H' | 'D' | 'A';
}

interface FDCOLeagueCache {
  code:      string;
  matches:   FDCOMatch[];
  fetchedAt: number;
}

// ─── CACHE HELPERS ───────────────────────────────────────────────────────────

function fdcoCachePath(code: string): string {
  return path.join(CACHE_DIR, `fdco-${code.toLowerCase()}.json`);
}

function readFDCOCache(code: string): FDCOLeagueCache | null {
  try {
    const p = fdcoCachePath(code);
    if (!fs.existsSync(p)) return null;
    const entry: FDCOLeagueCache = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry;
  } catch {
    return null;
  }
}

function writeFDCOCache(code: string, data: FDCOLeagueCache): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(fdcoCachePath(code), JSON.stringify(data), 'utf-8');
  } catch (err: any) {
    logger.warn('[FDCO] Failed to write cache', { code, error: err.message });
  }
}

// ─── CSV PARSER ──────────────────────────────────────────────────────────────

function parseCSV(csv: string): FDCOMatch[] {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
  const idx = {
    season: headers.indexOf('season'),
    date:   headers.indexOf('date'),
    home:   headers.indexOf('home'),
    away:   headers.indexOf('away'),
    hg:     headers.indexOf('hg'),
    ag:     headers.indexOf('ag'),
    res:    headers.indexOf('res'),
  };

  const matches: FDCOMatch[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const res = cols[idx.res]?.trim();
    if (!res || !['H', 'D', 'A'].includes(res)) continue;

    const hg = parseInt(cols[idx.hg]);
    const ag = parseInt(cols[idx.ag]);
    if (isNaN(hg) || isNaN(ag)) continue;

    matches.push({
      season: cols[idx.season]?.trim() ?? '',
      date:   cols[idx.date]?.trim() ?? '',
      home:   cols[idx.home]?.trim() ?? '',
      away:   cols[idx.away]?.trim() ?? '',
      hg,
      ag,
      res: res as 'H' | 'D' | 'A',
    });
  }

  return matches;
}

// ─── TEAM NAME NORMALIZER + FUZZY MATCH ──────────────────────────────────────

function normTeam(name: string): string {
  return name
    .toLowerCase()
    // remove common suffixes
    .replace(/\b(if|fk|bk|sk|ff|aif|afc|fc|bff|ik|hk|il)\b/g, '')
    // strip accents
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
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// ─── DATE PARSER (DD/MM/YYYY → ISO) ─────────────────────────────────────────

function parseDate(ddmmyyyy: string): string {
  const parts = ddmmyyyy.split('/');
  if (parts.length !== 3) return ddmmyyyy;
  const [dd, mm, yyyy] = parts;
  return `${yyyy}-${mm.padStart(2,'0')}-${dd.padStart(2,'0')}`;
}

// ─── PUBLIC API ──────────────────────────────────────────────────────────────

/**
 * Downloads and caches CSV for a league code.
 * Returns parsed matches or null on failure.
 */
async function fetchLeagueCSV(code: string): Promise<FDCOMatch[] | null> {
  const cached = readFDCOCache(code);
  if (cached) {
    logger.info('[FDCO] Cache hit', { code, matches: cached.matches.length });
    return cached.matches;
  }

  const url = `${FDCO_BASE}/${code}.csv`;
  try {
    logger.info('[FDCO] Downloading CSV', { url });
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const csv = await res.text();
    if (!csv.includes('Home') && !csv.includes('home')) {
      throw new Error('Response is not a valid CSV');
    }
    const matches = parseCSV(csv);
    logger.info('[FDCO] CSV parsed', { code, matches: matches.length });
    writeFDCOCache(code, { code, matches, fetchedAt: Date.now() });
    return matches;
  } catch (err: any) {
    logger.error('[FDCO] CSV download failed', { code, error: err.message });
    return null;
  }
}

/**
 * Computes H2H stats for two teams from a pre-loaded match list.
 * Returns H2HStats in the same shape as fcStatsScraper.fetchH2H().
 */
export function computeH2H(
  allMatches: FDCOMatch[],
  homeTeam: string,
  awayTeam: string,
): H2HStats | null {
  // Get unique team names from CSV for fuzzy matching
  const teamNames = [...new Set(allMatches.flatMap(m => [m.home, m.away]))];

  const csvHome = bestTeamMatch(homeTeam, teamNames);
  const csvAway = bestTeamMatch(awayTeam, teamNames);

  if (!csvHome || !csvAway) {
    logger.warn('[FDCO] Could not match team names', {
      homeTeam, awayTeam, csvHome, csvAway,
    });
    return null;
  }

  logger.info('[FDCO] Team name match', {
    homeTeam, csvHome, awayTeam, csvAway,
  });

  // Filter H2H matches — both directions, sorted newest first
  const h2hMatches = allMatches
    .filter(m =>
      (normTeam(m.home) === normTeam(csvHome) && normTeam(m.away) === normTeam(csvAway)) ||
      (normTeam(m.home) === normTeam(csvAway) && normTeam(m.away) === normTeam(csvHome))
    )
    .sort((a, b) => {
      // Sort by date descending (DD/MM/YYYY → compare as YYYY/MM/DD)
      const da = parseDate(a.date);
      const db = parseDate(b.date);
      return db.localeCompare(da);
    })
    .slice(0, MAX_H2H_MATCHES);

  if (h2hMatches.length === 0) {
    logger.warn('[FDCO] No H2H matches found', { csvHome, csvAway });
    return null;
  }

  const recentMatches: H2HMatch[] = h2hMatches.map(m => ({
    date:      parseDate(m.date),
    homeTeam:  m.home,
    awayTeam:  m.away,
    homeScore: m.hg,
    awayScore: m.ag,
  }));

  // Compute aggregates
  const totalGoals = h2hMatches.map(m => m.hg + m.ag);
  const over25Count = totalGoals.filter(g => g > 2.5).length;
  const over35Count = totalGoals.filter(g => g > 3.5).length;
  const bttsCount   = h2hMatches.filter(m => m.hg > 0 && m.ag > 0).length;
  const n = h2hMatches.length;

  // Count outcomes from homeTeam perspective
  let homeWins = 0, draws = 0, awayWins = 0;
  for (const m of h2hMatches) {
    const isHomeTeamHome = normTeam(m.home) === normTeam(csvHome);
    if (m.res === 'D') { draws++; continue; }
    if ((m.res === 'H' && isHomeTeamHome) || (m.res === 'A' && !isHomeTeamHome)) homeWins++;
    else awayWins++;
  }

  return {
    homeTeam:      homeTeam,
    awayTeam:      awayTeam,
    overUnder35:   Math.round((over35Count / n) * 100),
    btts:          Math.round((bttsCount / n) * 100),
    homeWin:       Math.round((homeWins / n) * 100),
    draw:          Math.round((draws / n) * 100),
    awayWin:       Math.round((awayWins / n) * 100),
    recentMatches,
  };
}

/**
 * Main entry point — drop-in replacement for fcStatsScraper.fetchH2H().
 * Call this with the league name (same key as FCSTATS_LEAGUE_MAP).
 */
export async function fetchFDCOH2H(
  homeTeam: string,
  awayTeam: string,
  leagueName: string,
): Promise<H2HStats | null> {
  const code = FDCO_LEAGUE_MAP[leagueName];
  if (!code) {
    logger.warn('[FDCO] No CSV code for league', { leagueName });
    return null;
  }

  const matches = await fetchLeagueCSV(code);
  if (!matches) return null;

  return computeH2H(matches, homeTeam, awayTeam);
}