// src/scrapers/soccerStatsScraper.ts
//
// A polite, best-effort scraper for soccerstats.com league/team statistics.
// No stealth automation, no fingerprint evasion — plain HTTP GET with normal
// browser headers and conservative request spacing. If this site changes its
// HTML structure or blocks requests in the future, this scraper will start
// returning empty results — treat it as optional supplementary data, never
// as a hard dependency. The engine must keep working with odds-only analysis
// if this returns nothing.

import { logger } from '../core/utils/logger';

// ─── TYPES ──────────────────────────────────────────────────────────────────

export interface TeamLeagueStats {
  teamName: string;
  gamesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  points: number;
  // Derived
  goalsForAvg: number;
  goalsAgainstAvg: number;
}

export interface LeagueSnapshot {
  leagueKey: string;
  teams: Map<string, TeamLeagueStats>; // key: normalized team name
  fetchedAt: number;
}

export const SOCCERSTATS_LEAGUE_MAP: Record<string, string> = {
  'Veikkausliiga - Finland':  'finland',
  'League of Ireland':        'ireland',
  'Superettan - Sweden':      'sweden2',
  'Allsvenskan - Sweden':     'sweden',
  'Eliteserien - Norway':     'norway',
  'La Liga 2 - Spain':        'spain2',
  'Brazil Série B':           'brazil2',
  'Brazil Série A':           'brazil',
};

// ─── CACHE ──────────────────────────────────────────────────────────────────

const cache = new Map<string, LeagueSnapshot>();
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours — league tables change slowly

function isCacheValid(entry: LeagueSnapshot): boolean {
  return Date.now() - entry.fetchedAt < CACHE_TTL_MS;
}

// ─── NAME NORMALIZATION ───────────────────────────────────────────────────────

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ');
}

function similarity(a: string, b: string): number {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 ? intersection / union : 0;
}

// ─── PARSER ─────────────────────────────────────────────────────────────────
//
// Parses the main league table, which appears as a sequence of rows like:
//   1   17 9 4 4 30 18 +12 31
//   [team name extracted from row context]
// soccerstats.com renders this without strict semantic markup (no <th>/<thead>
// reliably), so we parse the numeric "GP W D L GF GA GD Pts" pattern row by row
// and pair it with the nearest preceding team name.

function parseLeagueTable(html: string): Map<string, TeamLeagueStats> {
  const teams = new Map<string, TeamLeagueStats>();

  // Strip script/style blocks to avoid false matches inside JS
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  // Match table rows: a cell containing a team-like name followed by 8 numeric
  // stat cells (GP W D L GF GA GD Pts). soccerstats wraps team links in
  // <a class="ng" href="..."> typically, or plain text in <td>.
  // We use a row-based regex tolerant of attribute variations.
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(cleaned)) !== null) {
    const row = rowMatch[1];

    // Extract all <td> cell text content
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells: string[] = [];
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      const text = cellMatch[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
      cells.push(text);
    }

    if (cells.length < 9) continue;

    // Look for a row shape: [rank?, name, GP, W, D, L, GF, GA, GD, Pts]
    // or [name, GP, W, D, L, GF, GA, GD, Pts] — try both offsets.
    for (const offset of [0, 1]) {
      const nameIdx = offset;
      const statsStart = offset + 1;
      if (cells.length < statsStart + 8) continue;

      const name = cells[nameIdx];
      if (!name || name.length < 2 || /^\d+$/.test(name)) continue;

      const nums = cells.slice(statsStart, statsStart + 8).map(c => parseFloat(c.replace('+', '')));
      if (nums.some(n => isNaN(n))) continue;

      const [gp, w, d, l, gf, ga, gd, pts] = nums;

      // Sanity checks — a real league table row
      if (gp < 1 || gp > 60) continue;
      if (w + d + l !== gp) continue;
      if (Math.abs((gf - ga) - gd) > 0.5) continue; // GD should equal GF - GA

      const key = normalizeTeamName(name);
      if (teams.has(key)) continue; // avoid duplicate parsing from nested tables

      teams.set(key, {
        teamName: name,
        gamesPlayed: gp,
        wins: w,
        draws: d,
        losses: l,
        goalsFor: gf,
        goalsAgainst: ga,
        points: pts,
        goalsForAvg: parseFloat((gf / gp).toFixed(3)),
        goalsAgainstAvg: parseFloat((ga / gp).toFixed(3)),
      });

      break; // matched this row, don't try the other offset
    }
  }

  return teams;
}

// ─── MAIN FETCH ─────────────────────────────────────────────────────────────

export async function fetchLeagueStats(leagueName: string): Promise<LeagueSnapshot | null> {
  const leagueKey = SOCCERSTATS_LEAGUE_MAP[leagueName];
  if (!leagueKey) {
    logger.debug('[SoccerStats] No league mapping', { leagueName });
    return null;
  }

  const cached = cache.get(leagueKey);
  if (cached && isCacheValid(cached)) {
    logger.debug('[SoccerStats] Cache hit', { leagueKey });
    return cached;
  }

  const url = `https://www.soccerstats.com/latest.asp?league=${leagueKey}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    if (!res.ok) {
      logger.warn('[SoccerStats] Non-200 response', { leagueKey, status: res.status });
      return null;
    }

    const html = await res.text();
    const teams = parseLeagueTable(html);

    if (teams.size === 0) {
      logger.warn('[SoccerStats] No teams parsed — site structure may have changed', { leagueKey });
      return null;
    }

    const snapshot: LeagueSnapshot = { leagueKey, teams, fetchedAt: Date.now() };
    cache.set(leagueKey, snapshot);

    logger.info('[SoccerStats] Fetched league table', { leagueKey, teamCount: teams.size });
    return snapshot;

  } catch (err: any) {
    logger.warn('[SoccerStats] Fetch failed — falling back to odds-only', {
      leagueKey, error: err.message,
    });
    return null;
  }
}

// ─── TEAM LOOKUP (fuzzy) ──────────────────────────────────────────────────────

export function findTeamStats(
  snapshot: LeagueSnapshot,
  teamName: string,
): TeamLeagueStats | null {
  const key = normalizeTeamName(teamName);

  if (snapshot.teams.has(key)) {
    return snapshot.teams.get(key)!;
  }

  let best: TeamLeagueStats | null = null;
  let bestScore = 0;

  for (const stats of snapshot.teams.values()) {
    const score = similarity(teamName, stats.teamName);
    if (score > bestScore) {
      bestScore = score;
      best = stats;
    }
  }

  return bestScore >= 0.5 ? best : null;
}