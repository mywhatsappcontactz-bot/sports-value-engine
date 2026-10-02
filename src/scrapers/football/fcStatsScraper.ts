// src/scrapers/football/fcStatsScraper.ts
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface FCTeamStats {
  teamName:      string;
  teamId:        string;
  seasonId:      string;
  slug:          string;
  gp:            number;
  recentResults: RecentResult[];
  comparisonUrl: string | null;
}

export interface RecentResult {
  opponent:     string;
  goalsFor:     number;
  goalsAgainst: number;
  result:       'W' | 'L' | 'D';
  venue:        'home' | 'away';
  date:         string;
}

export interface H2HStats {
  homeTeam:        string;
  awayTeam:        string;
  overUnder35:     number;
  btts:            number;
  homeWin:         number;
  draw:            number;
  awayWin:         number;
  recentMatches:   H2HMatch[];
}

export interface H2HMatch {
  date:        string;
  homeTeam:    string;
  awayTeam:    string;
  homeScore:   number;
  awayScore:   number;
}

export interface LeagueData {
  leagueKey: string;
  teams:     Map<string, FCTeamStats>;
  fetchedAt: number;
}

interface SerializedLeagueData {
  leagueKey: string;
  teams:     [string, FCTeamStats][];
  fetchedAt: number;
}

// ─── STANDINGS TYPES ───────────────────────────────────────────────────────
//
// Added alongside FCTeamStats rather than merged into it — standings rows
// (from table,X,Y,{1,2,3}.php) and team-detail rows (from the main table
// page's per-team block, which is what FCTeamStats already models) are
// parsed from different HTML structures on different fetches. Keeping them
// separate avoids conflating "team's own recent match list" with "team's
// row in a specific Total/Home/Away standings variant".

export interface StandingsRow {
  teamName: string;
  played:   number;
  won:      number;
  drawn:    number;
  lost:     number;
  goalsFor: number;
  goalsAgainst: number;
  points:   number;
}

export interface LeagueStandings {
  leagueName: string;
  variant:    'total' | 'home' | 'away';
  rows:       StandingsRow[]; // NOT pre-sorted — see computeRank below
  fetchedAt:  number;
}

export const FCSTATS_LEAGUE_MAP: Record<string, string> = {
  'Veikkausliiga - Finland':      'table,veikkausliiga-finland,44,1.php',
  'League of Ireland':            'table,premier-league-ireland,45,1.php',
  'Superettan - Sweden':          'table,superettan-sweden,78,1.php',
  'Brazil Série B':               'table,serie-b-brazil,11,1.php',
  'Eliteserien - Norway':         'table,eliteserien-norway,50,1.php',
  'Allsvenskan - Sweden':         'table,allsvenskan-sweden,36,1.php',
  'Serie A - Italy':              'table,serie-a-italy,39,1.php',
  'Super League - China':         'table,super-league-china,42,1.php',
  'Brazil Série A':               'table,serie-a-brazil,10,1.php',
  'K League 1':                   'table,k-league-1-south-korea,94,1.php',
  'Denmark Superliga':            'table,superliga-denmark,15,1.php',
  'Austrian Football Bundesliga': 'table,bundesliga-austria,8,1.php',
  'Premiership - Scotland':       'table,premiership-scotland,35,1.php',
  'Swiss Superleague':            'table,super-league-switzerland,56,1.php',
  'EPL':                          'table,premier-league-england,1,1.php',
  'Championship':                 'table,championship-england,2,1.php',
  'League 1':                     'table,league-one-england,3,1.php',
  'League 2':                     'table,league-two-england,4,1.php',
  'La Liga - Spain':              'table,la-liga-spain,19,1.php',
  'La Liga 2 - Spain':            'table,segunda-division-spain,20,1.php',
  'Ligue 1 - France':             'table,ligue-1-france,21,1.php',
  'Bundesliga - Germany':         'table,bundesliga-germany,24,1.php',
  'Dutch Eredivisie':             'table,eredivisie-netherlands,21,1.php',
};

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function leagueCachePath(leagueName: string): string {
  return path.join(CACHE_DIR, `fcstats-league-${safeFileName(leagueName)}.json`);
}

function h2hCachePath(cacheKey: string): string {
  return path.join(CACHE_DIR, `fcstats-h2h-${safeFileName(cacheKey)}.json`);
}

// Separate cache namespace from the team-detail league cache above —
// standings are keyed by leagueName + variant, since Total/Home/Away are
// three distinct fetches.
function standingsCachePath(leagueName: string, variant: 'total' | 'home' | 'away'): string {
  return path.join(CACHE_DIR, `fcstats-standings-${safeFileName(leagueName)}-${variant}.json`);
}

function readLeagueCache(leagueName: string): LeagueData | null {
  try {
    const filePath = leagueCachePath(leagueName);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: SerializedLeagueData = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return {
      leagueKey: entry.leagueKey,
      teams: new Map(entry.teams),
      fetchedAt: entry.fetchedAt,
    };
  } catch (err: any) {
    logger.warn('[FCStats] Cache read failed', { leagueName, error: err.message });
    return null;
  }
}

function writeLeagueCache(leagueName: string, data: LeagueData): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: SerializedLeagueData = {
      leagueKey: data.leagueKey,
      teams: Array.from(data.teams.entries()),
      fetchedAt: data.fetchedAt,
    };
    fs.writeFileSync(leagueCachePath(leagueName), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[FCStats] Failed to write league cache', { leagueName, error: err.message });
  }
}

function readH2HCache(cacheKey: string): H2HStats | null {
  try {
    const filePath = h2hCachePath(cacheKey);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: { data: H2HStats; fetchedAt: number } = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeH2HCache(cacheKey: string, data: H2HStats): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry = { data, fetchedAt: Date.now() };
    fs.writeFileSync(h2hCachePath(cacheKey), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[FCStats] Failed to write H2H cache', { cacheKey, error: err.message });
  }
}

function readStandingsCache(leagueName: string, variant: 'total' | 'home' | 'away'): LeagueStandings | null {
  try {
    const filePath = standingsCachePath(leagueName, variant);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: LeagueStandings = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry;
  } catch (err: any) {
    logger.warn('[FCStats] Standings cache read failed', { leagueName, variant, error: err.message });
    return null;
  }
}

function writeStandingsCache(leagueName: string, variant: 'total' | 'home' | 'away', data: LeagueStandings): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(standingsCachePath(leagueName, variant), JSON.stringify(data), 'utf-8');
  } catch (err: any) {
    logger.warn('[FCStats] Failed to write standings cache', { leagueName, variant, error: err.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://fcstats.com';

const FCSTATS_COOKIE = process.env.FCSTATS_COOKIE;
const FCSTATS_UA = process.env.FCSTATS_UA;

if (!FCSTATS_COOKIE || !FCSTATS_UA) {
  logger.warn(
    '[FCStats] FCSTATS_COOKIE and/or FCSTATS_UA not set in .env — every ' +
      "request will fail. Solve fcstats.com's Turnstile checkbox manually " +
      'and set both before running a sync.'
  );
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}
// In fcStatsScraper.ts — replace the existing similarity() function

// Same generic-word stripping as soccerStatsCornersScraper.ts — prevents
// "Leeds United" and "Sheffield United" (or "Derry City"/"Manchester
// City") from scoring a false match purely on a shared generic suffix
// word. Confirmed necessary: "Leeds United" was matching "Sheffield
// United" at a passing score before this fix (see conversation).
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

function looksLikeChallengePage(html: string): boolean {
  const hasChallengeTitle =
    html.includes('<title>Just a moment...</title>') ||
    html.includes('id="challenge-running"') ||
    html.includes('id="challenge-error-title"') ||
    html.includes('Verify you are human');

  return hasChallengeTitle || html.length < 2000;
}

async function fetchHtml(url: string): Promise<string> {
  if (!FCSTATS_COOKIE || !FCSTATS_UA) {
    throw new Error(
      '[FCStats] FCSTATS_COOKIE / FCSTATS_UA missing from .env. Solve the ' +
        'Turnstile checkbox manually on fcstats.com and set both before retrying.'
    );
  }

  logger.info('[FCStats] Requesting with manual cookie session', { url });

  const res = await fetch(url, {
    headers: {
      Cookie: `cf_clearance=${FCSTATS_COOKIE}`,
      'User-Agent': FCSTATS_UA,
    },
  });

  if (!res.ok) {
    throw new Error(`[FCStats] HTTP error ${res.status} for ${url}`);
  }

  const html = await res.text();

  if (looksLikeChallengePage(html)) {
    logger.warn('[FCStats] Got a challenge page — cookie likely expired or IP mismatch', {
      url,
      htmlLength: html.length,
    });
    throw new Error(
      `[FCStats] Challenge page for ${url} — cookie has expired (they last ~30-45 min) or your IP ` +
        `changed since solving it. Grab a fresh cf_clearance cookie and re-run.`
    );
  }

  logger.info('[FCStats] Success', { url, htmlLength: html.length });

  return html;
}

// ─── LEAGUE TABLE PARSER (team detail list — unchanged) ──────────────────────

function parseLeagueTable(html: string): Map<string, FCTeamStats> {
  const teams = new Map<string, FCTeamStats>();

  const teamRegex = /href="club,statistics,([^,]+),(\d+),(\d+)\.php">([^<]+)<\/a><\/td>\s*<td>(\d+)<\/td>/g;
  let m;

  while ((m = teamRegex.exec(html)) !== null) {
    const [, slug, teamId, seasonId, teamName, gp] = m;

    const compRegex = new RegExp(
      `href="(comparison,[^"]*${teamId}[^"]*\\.php)"`,
      'i'
    );
    const compMatch = compRegex.exec(html);
    const comparisonUrl = compMatch ? `${BASE}/${compMatch[1]}` : null;

    const recentResults = parseRecentResults(html, teamId, teamName.trim());

    const stats: FCTeamStats = {
      teamName:      teamName.trim(),
      teamId,
      seasonId,
      slug,
      gp:            parseInt(gp),
      recentResults,
      comparisonUrl,
    };

    teams.set(normalize(teamName.trim()), stats);
  }

  logger.info(`[FCStats] Parsed ${teams.size} teams from league table`);
  return teams;
}

function parseRecentResults(html: string, teamId: string, teamName: string): RecentResult[] {
  const results: RecentResult[] = [];

  const matchRegex = new RegExp(
    `id="match_\\d+_opponent_${teamId}"[^>]*title="([^"]+)"`,
    'g'
  );

  let m;
  while ((m = matchRegex.exec(html)) !== null && results.length < 6) {
    const title = m[1];
    const scoreMatch = /^(.+?)\s+-\s+(.+?)\s+(\d+):(\d+)$/.exec(title);
    if (!scoreMatch) continue;

    const [, home, away, homeScore, awayScore] = scoreMatch;
    const isHome   = normalize(home).includes(normalize(teamName).split(' ')[0]);
    const gf       = isHome ? parseInt(homeScore) : parseInt(awayScore);
    const ga       = isHome ? parseInt(awayScore)  : parseInt(homeScore);
    const result: 'W' | 'L' | 'D' = gf > ga ? 'W' : gf < ga ? 'L' : 'D';

    results.push({
      opponent:     isHome ? away.trim() : home.trim(),
      goalsFor:     gf,
      goalsAgainst: ga,
      result,
      venue:        isHome ? 'home' : 'away',
      date:         new Date(Date.now() - results.length * 7 * 24 * 60 * 60 * 1000)
                      .toISOString().split('T')[0],
    });
  }

  return results;
}

// ─── STANDINGS PARSER (new) ───────────────────────────────────────────────
//
// Confirmed against real HTML (EPL, 2026-09-20): row shape is
// <td ...teamName...><a href="club,statistics,...">TeamName</a></td>
// <td>M</td><td>W</td><td>D</td><td>L</td><td>G+</td><td class="rightBorder">G-</td>
// <td class="rightBorder darkBackground">Pts</td>
// followed by a "Form" cell full of recent-match links — NOT captured here,
// since recentResults already covers that via parseRecentResults above.
//
// The G- and Pts cells carry extra CSS classes (rightBorder, darkBackground)
// that a plain <td> regex won't match — handled explicitly below rather than
// assuming every stat cell has the same tag shape.
function parseStandingsRows(html: string): StandingsRow[] {
  const rows: StandingsRow[] = [];

  const rowRegex =
    /<a href="club,statistics,[^"]+">([^<]+)<\/a><\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>\s*<td[^>]*>(\d+)<\/td>/g;

  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const [, teamName, played, won, drawn, lost, goalsFor, goalsAgainst, points] = m;
    rows.push({
      teamName: teamName.trim(),
      played: parseInt(played, 10),
      won: parseInt(won, 10),
      drawn: parseInt(drawn, 10),
      lost: parseInt(lost, 10),
      goalsFor: parseInt(goalsFor, 10),
      goalsAgainst: parseInt(goalsAgainst, 10),
      points: parseInt(points, 10),
    });
  }

  return rows;
}

// Derives a URL for the Home or Away variant of a standings page from the
// Total variant's URL — confirmed pattern (EPL): trailing ",1.php" becomes
// ",2.php" (Home) or ",3.php" (Away), everything else unchanged.
function deriveVariantPath(totalPath: string, variant: 'home' | 'away'): string {
  const suffix = variant === 'home' ? ',2.php' : ',3.php';
  return totalPath.replace(/,1\.php$/, suffix);
}

// ─── STANDINGS RANK (new) ─────────────────────────────────────────────────
//
// Standard football tie-break: points, then goal difference, then goals
// scored. This is a CHOICE, not confirmed against fcstats' own internal
// tie-break logic — if two teams are level on points, rank could differ
// by one position from fcstats' own displayed order in an edge case. Not
// verified against fcstats specifically; flagged here rather than assumed
// correct.
export function computeStandingsRank(rows: StandingsRow[]): Map<string, number> {
  const sorted = [...rows].sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const gdA = a.goalsFor - a.goalsAgainst;
    const gdB = b.goalsFor - b.goalsAgainst;
    if (gdB !== gdA) return gdB - gdA;
    return b.goalsFor - a.goalsFor;
  });

  const rankMap = new Map<string, number>();
  sorted.forEach((row, idx) => {
    rankMap.set(normalize(row.teamName), idx + 1); // 1-indexed, matches tablePositionStrength's convention
  });
  return rankMap;
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function fetchLeagueData(leagueName: string): Promise<LeagueData | null> {
  const cached = readLeagueCache(leagueName);
  if (cached) {
    logger.info('[FCStats] Cache hit (persistent)', { leagueName });
    return cached;
  }

  const leaguePath = FCSTATS_LEAGUE_MAP[leagueName];
  if (!leaguePath) {
    logger.warn('[FCStats] No league path for', { leagueName });
    return null;
  }

  try {
    const html  = await fetchHtml(`${BASE}/${leaguePath}`);
    const teams = parseLeagueTable(html);

    if (teams.size === 0) {
      logger.warn('[FCStats] No teams parsed', { leagueName });
      return null;
    }

    const result: LeagueData = {
      leagueKey: leaguePath,
      teams,
      fetchedAt: Date.now(),
    };
    writeLeagueCache(leagueName, result);
    return result;

  } catch (err: any) {
    logger.error('[FCStats] League fetch failed', { leagueName, error: err.message });
    return null;
  }
}

/**
 * Fetches the Total, Home, or Away standings variant for a league and
 * returns raw rows (unsorted — call computeStandingsRank separately for
 * rank, since callers may want raw points/GD too, not just rank).
 *
 * Returns null if the league isn't in FCSTATS_LEAGUE_MAP, or if the fetch/
 * parse fails.
 */
export async function fetchLeagueStandings(
  leagueName: string,
  variant: 'total' | 'home' | 'away' = 'total'
): Promise<LeagueStandings | null> {
  const cached = readStandingsCache(leagueName, variant);
  if (cached) {
    logger.info('[FCStats] Standings cache hit (persistent)', { leagueName, variant });
    return cached;
  }

  const totalPath = FCSTATS_LEAGUE_MAP[leagueName];
  if (!totalPath) {
    logger.warn('[FCStats] No league path for standings', { leagueName });
    return null;
  }

  const path_ = variant === 'total' ? totalPath : deriveVariantPath(totalPath, variant);

  try {
    const html = await fetchHtml(`${BASE}/${path_}`);
    const rows = parseStandingsRows(html);

    if (rows.length === 0) {
      logger.warn('[FCStats] No standings rows parsed', { leagueName, variant });
      return null;
    }

    const result: LeagueStandings = {
      leagueName,
      variant,
      rows,
      fetchedAt: Date.now(),
    };
    writeStandingsCache(leagueName, variant, result);
    return result;
  } catch (err: any) {
    logger.error('[FCStats] Standings fetch failed', { leagueName, variant, error: err.message });
    return null;
  }
}

export async function fetchH2H(
  homeTeam: string,
  awayTeam: string,
  leagueData: LeagueData,
): Promise<H2HStats | null> {

  const cacheKey = `${normalize(homeTeam)}_vs_${normalize(awayTeam)}`;
  const cached   = readH2HCache(cacheKey);
  if (cached) {
    logger.info('[FCStats] H2H cache hit (persistent)', { homeTeam, awayTeam });
    return cached;
  }

  let compUrl: string | null = null;

  for (const [, stats] of leagueData.teams) {
    if (similarity(stats.teamName, homeTeam) >= 0.5 && stats.comparisonUrl) {
      compUrl = stats.comparisonUrl;
      break;
    }
  }

  if (!compUrl) {
    logger.warn('[FCStats] No comparison URL found', { homeTeam, awayTeam });
    return null;
  }

  try {
    logger.info('[FCStats] Fetching H2H', { homeTeam, awayTeam, url: compUrl });
    const html   = await fetchHtml(compUrl);
    const result = parseH2HPage(html, homeTeam, awayTeam);
    writeH2HCache(cacheKey, result);
    return result;

  } catch (err: any) {
    logger.error('[FCStats] H2H fetch failed', { homeTeam, awayTeam, error: err.message });
    return null;
  }
}

function parseH2HPage(html: string, homeTeam: string, awayTeam: string): H2HStats {
  const recentMatches: H2HMatch[] = [];

  const matchRegex = /title="([^"]+\s+-\s+[^"]+\s+\d+:\d+)"/g;
  let m;
  let count = 0;

  while ((m = matchRegex.exec(html)) !== null && count < 5) {
    const title = m[1];
    const scoreMatch = /^(.+?)\s+-\s+(.+?)\s+(\d+):(\d+)$/.exec(title);
    if (!scoreMatch) continue;

    const [, home, away, hs, as_] = scoreMatch;
    recentMatches.push({
      date:      new Date(Date.now() - count * 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
      homeTeam:  home.trim(),
      awayTeam:  away.trim(),
      homeScore: parseInt(hs),
      awayScore: parseInt(as_),
    });
    count++;
  }

  const over35Regex = /3[.,]5[^%]*?(\d+)%/;
  const over35Match = over35Regex.exec(html);
  const over35 = over35Match ? parseInt(over35Match[1]) : 30;

  const bttsRegex = /BTTS[^%]*?(\d+)%/i;
  const bttsMatch = bttsRegex.exec(html);
  const btts = bttsMatch ? parseInt(bttsMatch[1]) : 50;

  const homeWinRegex = /home\s*win[^%]*?(\d+)%/i;
  const drawRegex    = /draw[^%]*?(\d+)%/i;
  const awayWinRegex = /away\s*win[^%]*?(\d+)%/i;

  const homeWin = parseInt(homeWinRegex.exec(html)?.[1] ?? '33');
  const draw    = parseInt(drawRegex.exec(html)?.[1]    ?? '33');
  const awayWin = parseInt(awayWinRegex.exec(html)?.[1] ?? '33');

  return {
    homeTeam,
    awayTeam,
    overUnder35: over35,
    btts,
    homeWin,
    draw,
    awayWin,
    recentMatches,
  };
}

// ─── TEAM ALIAS MAP (OddsAPI name → FCStats normalized name) ──────────────
const TEAM_ALIASES: Record<string, string> = {
  'sjk seinjoki':              'seinjoen jalkapallokerho',
  'ifk mariehamn':             'mariehamn',
  'fc inter turku':            'inter turku',
  'fc lahti':                  'lahti',
  'if gnistan':                'gnistan',
  'ilves tampere':             'tampereen ilves',
  'kups kuopio':               'kups kuopio',
  'shelbourne dublin':         'shelbourne',
  'waterford fc':              'waterford united',
  'bohemians':                 'bohemian fc',
  'beijing fc':                'beijing guoan',
  'shandong luneng taishan fc':'shandong taishan',
  'shanghai sipg fc':          'shanghai port',
  'henan fc':                  'henan songshan longmen',
  'shenzhen peng city fc':     'shenzhen xinpengcheng',
  'tianjin jinmen tiger fc':   'tianjin tigers',
  'chongqing tonglianglong fc':'chongqing tonglianglong',
  'qingdao west coast fc':     'qingdao west coast',
  'qingdao hainiu fc':         'qingdao hainiu',
  'zhejiang':                  'zhejiang professional',
  'shanghai shenhua fc':       'shanghai shenhua',
  'chengdu rongcheng fc':      'chengdu rongcheng',
  'liaoning tieren fc':        'liaoning tieren',
  'wolves': 'wolverhampton wanderers',
};

export function findTeam(leagueData: LeagueData, teamName: string): FCTeamStats | null {
  const key = normalize(teamName);
  const aliasKey = TEAM_ALIASES[key] ?? key;
  if (leagueData.teams.has(aliasKey)) return leagueData.teams.get(aliasKey)!;
  if (aliasKey !== key && leagueData.teams.has(key)) return leagueData.teams.get(key)!;

  let best: FCTeamStats | null = null;
  let bestScore = 0;

  for (const [k, stats] of leagueData.teams) {
    const score = similarity(key, k);
    if (score > bestScore) {
      bestScore = score;
      best = stats;
    }
  }

  return bestScore >= 0.3 ? best : null;
}

// Same fuzzy-match approach as findTeam above, for standings rows
// specifically (StandingsRow has no teamId/slug to key off of directly).
export function findStandingsRow(rows: StandingsRow[], teamName: string): StandingsRow | null {
  const key = normalize(teamName);
  const aliasKey = TEAM_ALIASES[key] ?? key;

  for (const row of rows) {
    if (normalize(row.teamName) === aliasKey || normalize(row.teamName) === key) return row;
  }

  let best: StandingsRow | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const score = similarity(key, normalize(row.teamName));
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return bestScore >= 0.3 ? best : null;
} 