// src/scrapers/baseball/mlbScraper.ts
//
// Fetches MLB team schedule/results data from the public MLB Stats API
// (statsapi.mlb.com — no API key required, same undocumented-but-stable
// public JSON API pattern used elsewhere in sports data tooling). Builds
// FormRecord[] (recent form) and H2HRecord[] (head-to-head) matching the
// existing Stats schema exactly, so this plugs into modelBaseball via the
// same Stats shape every other sport already uses — no schema changes.
//
// IMPORTANT — UNVERIFIED AGAINST LIVE DATA:
// Unlike soccerStatsCornersScraper.ts (whose markup was confirmed against
// a real fetched page) or the WNBA scraper (built against a documented
// API shape), this file's endpoint paths and response shape are based on
// the MLB Stats API's known/stable public structure but have NOT been
// independently fetched and verified during this session (statsapi.mlb.com
// isn't reachable from this environment). Test against a real team/date
// range before trusting this in production — check the actual JSON shape
// matches what parseScheduleResponse expects, particularly the
// `dates[].games[]` nesting and field names.
//
// Run a manual smoke test with: npx ts-node -e "
//   import('./src/scrapers/baseball/mlbScraper').then(m =>
//     m.fetchTeamList().then(teams => console.log([...teams.entries()].slice(0,5)))
//   )
// "

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { FormRecord, H2HRecord } from '../../core/database/schema';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface MlbTeam {
  id: number;
  name: string; // e.g. "New York Yankees"
}

interface MlbGame {
  date: string; // ISO date, YYYY-MM-DD
  gamePk: number;
  homeTeamId: number;
  homeTeamName: string;
  awayTeamId: number;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  status: string; // e.g. "Final"
}

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────

const TEAM_LIST_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // team IDs/names basically never change — weekly refresh is plenty
const SCHEDULE_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — schedules/results update daily, refresh more often than the 24h pattern used for season-aggregate stats elsewhere
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function readCache<T>(cacheKey: string, ttlMs: number): T | null {
  try {
    const filePath = path.join(CACHE_DIR, `mlb-${safeFileName(cacheKey)}.json`);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry = JSON.parse(raw);

    if (Date.now() - entry.fetchedAt >= ttlMs) return null;
    return entry.data as T;
  } catch (err: any) {
    logger.warn('[MlbScraper] Cache read failed', { cacheKey, error: err.message });
    return null;
  }
}

function writeCache<T>(cacheKey: string, data: T): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const filePath = path.join(CACHE_DIR, `mlb-${safeFileName(cacheKey)}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ data, fetchedAt: Date.now() }), 'utf-8');
  } catch (err: any) {
    logger.warn('[MlbScraper] Failed to write cache', { cacheKey, error: err.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_SPORT_ID = 1; // MLB itself, as opposed to minor league affiliates

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchJson(url: string, retries: number = 2): Promise<any> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } catch (err: any) {
      const isLastAttempt = attempt === retries;
      if (isLastAttempt) throw err;

      // "fetch failed" / "terminated" here are almost always transient —
      // rate-limiting or a dropped connection, not a real data problem.
      // Backing off and retrying fixes the overwhelming majority of these
      // rather than losing the fixture entirely. Exponential-ish backoff:
      // 1s, then 2s.
      const backoffMs = 1000 * (attempt + 1);
      logger.warn(`[MlbScraper] Fetch failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${backoffMs}ms`, {
        url, error: err.message,
      });
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw new Error('unreachable'); // satisfies TS control-flow analysis
}

// ─── TEAM LIST ───────────────────────────────────────────────────────────────

export async function fetchTeamList(): Promise<Map<string, MlbTeam>> {
  const cached = readCache<[string, MlbTeam][]>('team-list', TEAM_LIST_CACHE_TTL_MS);
  if (cached) return new Map(cached);

  const url = `${BASE}/teams?sportId=${MLB_SPORT_ID}`;
  const data = await fetchJson(url);

  const teams = new Map<string, MlbTeam>();
  for (const t of data.teams ?? []) {
    if (!t.id || !t.name) continue;
    teams.set(normalize(t.name), { id: t.id, name: t.name });
  }

  if (teams.size === 0) {
    throw new Error('[MlbScraper] Fetched team list but parsed zero teams — response shape may have changed, check parseTeamList against a real response');
  }

  writeCache('team-list', [...teams.entries()]);
  logger.info(`[MlbScraper] Fetched ${teams.size} MLB teams`);
  return teams;
}

export function findTeam(teams: Map<string, MlbTeam>, teamName: string): MlbTeam | null {
  const key = normalize(teamName);
  if (teams.has(key)) return teams.get(key)!;

  // Fuzzy fallback — MLB team names in your internal data ("Yankees")
  // won't always match the API's full names ("New York Yankees") exactly.
  let best: MlbTeam | null = null;
  let bestScore = 0;
  for (const [k, team] of teams) {
    if (k.includes(key) || key.includes(k)) {
      const score = Math.min(key.length, k.length) / Math.max(key.length, k.length);
      if (score > bestScore) {
        bestScore = score;
        best = team;
      }
    }
  }
  return bestScore >= 0.3 ? best : null;
}

// ─── SCHEDULE / RESULTS ────────────────────────────────────────────────────

// Fetches a team's completed games within a date range. Used as the base
// for both recent-form and head-to-head — both are just different
// filters/slices over the same underlying schedule data.
async function fetchTeamSchedule(teamId: number, startDate: string, endDate: string): Promise<MlbGame[]> {
  const cacheKey = `schedule-${teamId}-${startDate}-${endDate}`;
  const cached = readCache<MlbGame[]>(cacheKey, SCHEDULE_CACHE_TTL_MS);
  if (cached) return cached;

  const url = `${BASE}/schedule?sportId=${MLB_SPORT_ID}&teamId=${teamId}&startDate=${startDate}&endDate=${endDate}&hydrate=team,linescore`;
  const data = await fetchJson(url);

  const games: MlbGame[] = [];
  for (const dateEntry of data.dates ?? []) {
    for (const g of dateEntry.games ?? []) {
      const status = g.status?.detailedState ?? g.status?.abstractGameState ?? '';
      if (status !== 'Final') continue; // skip postponed/in-progress/scheduled

      const homeScore = g.teams?.home?.score;
      const awayScore = g.teams?.away?.score;
      if (homeScore == null || awayScore == null) continue;

      games.push({
        date: dateEntry.date,
        gamePk: g.gamePk,
        homeTeamId: g.teams?.home?.team?.id,
        homeTeamName: g.teams?.home?.team?.name,
        awayTeamId: g.teams?.away?.team?.id,
        awayTeamName: g.teams?.away?.team?.name,
        homeScore,
        awayScore,
        status,
      });
    }
  }

  games.sort((a, b) => a.date.localeCompare(b.date));
  writeCache(cacheKey, games);
  return games;
}

function defaultDateRange(): { startDate: string; endDate: string } {
  // MLB regular season runs late March/April through September/October.
  // Default to a wide enough window to capture the current season without
  // needing the caller to know exact boundaries. Adjust if you need
  // playoff data too (postseason uses a different gameType filter this
  // endpoint doesn't currently request).
  const now = new Date();
  const year = now.getMonth() >= 1 ? now.getFullYear() : now.getFullYear() - 1; // Feb onward = current year's season
  return { startDate: `${year}-02-01`, endDate: now.toISOString().slice(0, 10) };
}

// ─── UPCOMING FIXTURES ────────────────────────────────────────────────────

export interface MlbFixture {
  date: string; // YYYY-MM-DD
  homeTeam: string;
  awayTeam: string;
}

// Fetches SCHEDULED (not yet played) games across all MLB teams within a
// forward-looking window — this is the "what games are coming up" half of
// the pipeline, distinct from fetchTeamSchedule above (which only returns
// completed games for a single team, used for form/h2h). Mirrors the role
// fetchNBAFixtures/fetchWNBAFixtures play for basketballFixturesSync.ts.
export async function fetchMlbFixtures(daysAhead: number = 7): Promise<MlbFixture[]> {
  const startDate = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const cacheKey = `fixtures-${startDate}-${endDate}`;
  const cached = readCache<MlbFixture[]>(cacheKey, SCHEDULE_CACHE_TTL_MS);
  if (cached) return cached;

  const url = `${BASE}/schedule?sportId=${MLB_SPORT_ID}&startDate=${startDate}&endDate=${endDate}`;
  const data = await fetchJson(url);

  const fixtures: MlbFixture[] = [];
  for (const dateEntry of data.dates ?? []) {
    for (const g of dateEntry.games ?? []) {
      // Only include games not yet played — "Scheduled"/"Pre-Game" are
      // the pre-game states this API uses; anything already "Final" or
      // in-progress shouldn't be treated as an upcoming fixture needing
      // fresh stats attached.
      const status = g.status?.detailedState ?? g.status?.abstractGameState ?? '';
      if (status === 'Final' || status === 'In Progress') continue;

      const homeTeam = g.teams?.home?.team?.name;
      const awayTeam = g.teams?.away?.team?.name;
      if (!homeTeam || !awayTeam) continue;

      fixtures.push({ date: dateEntry.date, homeTeam, awayTeam });
    }
  }

  writeCache(cacheKey, fixtures);
  logger.info(`[MlbScraper] Fetched ${fixtures.length} upcoming MLB fixtures (next ${daysAhead}d)`);
  return fixtures;
}

// ─── PUBLIC API — FORM ───────────────────────────────────────────────────────

// Builds FormRecord[] the same shape modelBaseball's computeBaseballLambdas
// expects (via weightedGoalsAvg reading goalsFor/goalsAgainst — runs, in
// this context). Ordered oldest-to-newest to match the recency-weighting
// convention (index 0 = most recent after reversal) used elsewhere.
export async function getRecentForm(
  teamId: number,
  windowGames: number = 10,
  dateRange?: { startDate: string; endDate: string }
): Promise<FormRecord[]> {
  const { startDate, endDate } = dateRange ?? defaultDateRange();
  const games = await fetchTeamSchedule(teamId, startDate, endDate);

  const recent = games.slice(-windowGames);

  return recent.map((g): FormRecord => {
    const isHome = g.homeTeamId === teamId;
    const runsFor = isHome ? g.homeScore : g.awayScore;
    const runsAgainst = isHome ? g.awayScore : g.homeScore;
    const opponent = isHome ? g.awayTeamName : g.homeTeamName;

    return {
      date: g.date,
      opponent,
      result: runsFor > runsAgainst ? 'W' : 'L',
      goalsFor: runsFor, // reusing the goalsFor field name for runs — same
      goalsAgainst: runsAgainst, // pattern modelHockey uses for goals, no schema change needed
      venue: isHome ? 'home' : 'away',
    };
  });
}

// ─── PUBLIC API — HEAD TO HEAD ───────────────────────────────────────────────

export async function getHeadToHead(
  homeTeamId: number,
  homeTeamName: string,
  awayTeamId: number,
  awayTeamName: string,
  maxRecords: number = 10,
  dateRange?: { startDate: string; endDate: string }
): Promise<H2HRecord[]> {
  const { startDate, endDate } = dateRange ?? defaultDateRange();

  // MLB's schedule endpoint doesn't support a direct two-team H2H filter
  // — fetch the home team's full schedule and filter for games against
  // the away team specifically, same approach the corners/NBA fits used
  // for h2h construction from single-team game logs.
  const homeTeamGames = await fetchTeamSchedule(homeTeamId, startDate, endDate);

  const matchups = homeTeamGames.filter(
    g => g.homeTeamId === awayTeamId || g.awayTeamId === awayTeamId
  );

  const records: H2HRecord[] = matchups.slice(-maxRecords).map((g): H2HRecord => {
    const winner: 'home' | 'away' | 'draw' =
      g.homeScore > g.awayScore ? 'home' : g.awayScore > g.homeScore ? 'away' : 'draw';

    return {
      date: g.date,
      homeTeam: g.homeTeamName,
      awayTeam: g.awayTeamName,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
      winner,
    };
  });

  return records;
}

// ─── CONVENIENCE: BUILD EVERYTHING FOR A MATCHUP ────────────────────────────

export interface MlbMatchStats {
  h2h: H2HRecord[];
  homeForm: FormRecord[];
  awayForm: FormRecord[];
}

// One-stop function mirroring the shape most callers will actually want —
// analogous to what aggregateCornersForMatch does for football corners.
// Does NOT write to the database itself; caller decides how/where to
// persist, consistent with how other sports' sync jobs (see the
// [DEBUG BBALL-SYNC] logging pattern already in use for WNBA) work.
export async function fetchMlbMatchStats(
  homeTeamName: string,
  awayTeamName: string,
  formWindow: number = 10,
  h2hWindow: number = 10
): Promise<MlbMatchStats | null> {
  const teams = await fetchTeamList();
  const homeTeam = findTeam(teams, homeTeamName);
  const awayTeam = findTeam(teams, awayTeamName);

  if (!homeTeam || !awayTeam) {
    logger.warn('[MlbScraper] Could not match team(s)', {
      homeTeamName, awayTeamName,
      homeMatched: !!homeTeam, awayMatched: !!awayTeam,
    });
    return null;
  }

  const [homeForm, awayForm, h2h] = await Promise.all([
    getRecentForm(homeTeam.id, formWindow),
    getRecentForm(awayTeam.id, formWindow),
    getHeadToHead(homeTeam.id, homeTeam.name, awayTeam.id, awayTeam.name, h2hWindow),
  ]);

  return { h2h, homeForm, awayForm };
}