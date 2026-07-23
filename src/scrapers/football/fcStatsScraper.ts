// src/scrapers/football/fcStatsScraper.ts
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
  overUnder35:     number;  // % of matches with over 3.5 goals
  btts:            number;  // % both teams scored
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

// Note: teams stored as plain array for JSON serialization,
// converted to/from Map at the cache boundary.
export interface LeagueData {
  leagueKey: string;
  teams:     Map<string, FCTeamStats>; // normalized team name → stats
  fetchedAt: number;
}

interface SerializedLeagueData {
  leagueKey: string;
  teams:     [string, FCTeamStats][];
  fetchedAt: number;
}
export const FCSTATS_LEAGUE_MAP: Record<string, string> = {
  // ── Currently active ────────────────────────────────────────────
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

  // ── Starting mid/late July 2026 ─────────────────────────────────
  'Denmark Superliga':            'table,superliga-denmark,15,1.php',

  
  'Austrian Football Bundesliga': 'table,bundesliga-austria,8,1.php',

  // ── Starting late July 2026 ─────────────────────────────────────
  'Premiership - Scotland':       'table,premiership-scotland,35,1.php',
  'Swiss Superleague':            'table,super-league-switzerland,56,1.php',

  // ── Starting early August 2026 ──────────────────────────────────
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

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://fcstats.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

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
  return intersection / union;
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── LEAGUE TABLE PARSER ─────────────────────────────────────────────────────

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

// ─── H2H PARSER ──────────────────────────────────────────────────────────────

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

// ─── TEAM ALIAS MAP (OddsAPI name → FCStats normalized name) ──────────────
const TEAM_ALIASES: Record<string, string> = {
  // Finland
  'sjk seinjoki':              'seinjoen jalkapallokerho',
  'ifk mariehamn':             'mariehamn',
  'fc inter turku':            'inter turku',
  'fc lahti':                  'lahti',
  'if gnistan':                'gnistan',
  'ilves tampere':             'tampereen ilves',
  'kups kuopio':               'kups kuopio',
  // Ireland
  'shelbourne dublin':         'shelbourne',
  'waterford fc':              'waterford united',
  'bohemians':                 'bohemian fc',
  // China
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