// src/data-bridge/apiClients/sportsClient.ts
import { RawStats } from '../mockClient';
import { logger } from '../../core/utils/logger';

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const BASE_URLS: Record<string, string> = {
  football:   'https://v3.football.api-sports.io',
  basketball: 'https://v1.basketball.api-sports.io',
  hockey:     'https://v1.hockey.api-sports.io',
  tennis:     'https://v1.tennis.api-sports.io',
};

// High-liquidity league IDs per sport
const LEAGUE_IDS: Record<string, number[]> = {
  football:   [39, 140, 78, 135, 61],  // EPL, LaLiga, Bundesliga, Serie A, Ligue 1
  basketball: [12, 13],                 // NBA, NBA Playoffs
  hockey:     [57, 58],                 // NHL, NHL Playoffs
  tennis:     [1, 2, 3],               // ATP Tour events
};

const CURRENT_SEASON: Record<string, string> = {
  football:   '2024',
  basketball: '2024-2025',
  hockey:     '2024-2025',
  tennis:     '2025',
};

// ─── CACHE TTL (milliseconds) ─────────────────────────────────────────────────

const TTL = {
  fixtures: 24 * 60 * 60 * 1000,   // 1 day
  h2h:       7 * 24 * 60 * 60 * 1000, // 7 days
  form:      3 * 24 * 60 * 60 * 1000, // 3 days
  referee:   24 * 60 * 60 * 1000,   // 1 day
};

interface CacheEntry<T> { data: T; fetchedAt: number; ttl: number; }
const statsCache = new Map<string, CacheEntry<any>>();

function fromCache<T>(key: string): T | null {
  const entry = statsCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > entry.ttl) { statsCache.delete(key); return null; }
  return entry.data as T;
}

function toCache<T>(key: string, data: T, ttl: number): void {
  statsCache.set(key, { data, fetchedAt: Date.now(), ttl });
}

// ─── API HELPER ───────────────────────────────────────────────────────────────

async function apiFetch<T>(sport: string, endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey = process.env.API_SPORTS_KEY;
  if (!apiKey) throw new Error('API_SPORTS_KEY not set in environment');

  const baseUrl = BASE_URLS[sport];
  if (!baseUrl) throw new Error(`No base URL for sport: ${sport}`);

  const url = new URL(`${baseUrl}${endpoint}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    headers: {
      'x-apisports-key': apiKey,
      'x-rapidapi-key': apiKey,
    },
  });

  if (!res.ok) throw new Error(`API-Sports ${endpoint} failed: ${res.status}`);
  const json = await res.json() as any;
  if (json.errors && Object.keys(json.errors).length > 0) {
    throw new Error(`API-Sports error: ${JSON.stringify(json.errors)}`);
  }
  return json.response as T;
}

// ─── FOOTBALL CLIENT ──────────────────────────────────────────────────────────

async function fetchFootballStats(
  homeTeamId: number,
  awayTeamId: number,
  fixtureId: number,
  externalMatchId: string,
): Promise<RawStats> {
  const season = CURRENT_SEASON.football;

  // H2H — cache 7 days
  const h2hKey = `h2h:football:${Math.min(homeTeamId, awayTeamId)}-${Math.max(homeTeamId, awayTeamId)}`;
  let h2hRaw = fromCache<any[]>(h2hKey);
  if (!h2hRaw) {
    h2hRaw = await apiFetch<any[]>('football', '/fixtures/headtohead', {
      h2h: `${homeTeamId}-${awayTeamId}`,
      last: '6',
    });
    toCache(h2hKey, h2hRaw, TTL.h2h);
  }

  // Home team form — cache 3 days
  const homeFormKey = `form:football:${homeTeamId}:home`;
  let homeFormRaw = fromCache<any[]>(homeFormKey);
  if (!homeFormRaw) {
    homeFormRaw = await apiFetch<any[]>('football', '/fixtures', {
      team: String(homeTeamId), season, last: '8', status: 'FT',
    });
    toCache(homeFormKey, homeFormRaw, TTL.form);
  }

  // Away team form — cache 3 days
  const awayFormKey = `form:football:${awayTeamId}:away`;
  let awayFormRaw = fromCache<any[]>(awayFormKey);
  if (!awayFormRaw) {
    awayFormRaw = await apiFetch<any[]>('football', '/fixtures', {
      team: String(awayTeamId), season, last: '8', status: 'FT',
    });
    toCache(awayFormKey, awayFormRaw, TTL.form);
  }

  // Referee — from fixture details, cache 1 day
  const refKey = `referee:football:${fixtureId}`;
  let fixtureDetail = fromCache<any>(refKey);
  if (!fixtureDetail) {
    const details = await apiFetch<any[]>('football', '/fixtures', { id: String(fixtureId) });
    fixtureDetail = details?.[0] || null;
    if (fixtureDetail) toCache(refKey, fixtureDetail, TTL.referee);
  }

  // Parse H2H
  const h2h = (h2hRaw || []).map((f: any) => ({
    date: f.fixture?.date?.slice(0, 10) || '',
    homeTeam: f.teams?.home?.name || '',
    awayTeam: f.teams?.away?.name || '',
    homeScore: f.goals?.home ?? 0,
    awayScore: f.goals?.away ?? 0,
  }));

  // Parse form helper
  const parseForm = (fixtures: any[], teamId: number) =>
    (fixtures || []).map((f: any) => {
      const isHome = f.teams?.home?.id === teamId;
      const teamGoals = isHome ? f.goals?.home : f.goals?.away;
      const oppGoals = isHome ? f.goals?.away : f.goals?.home;
      const result = teamGoals > oppGoals ? 'W' : teamGoals < oppGoals ? 'L' : 'D';
      return {
        date: f.fixture?.date?.slice(0, 10) || '',
        opponent: isHome ? f.teams?.away?.name : f.teams?.home?.name,
        result: result as 'W' | 'L' | 'D',
        goalsFor: teamGoals ?? 0,
        goalsAgainst: oppGoals ?? 0,
        venue: (isHome ? 'home' : 'away') as 'home' | 'away',
      };
    });

  const homeForm = parseForm(homeFormRaw || [], homeTeamId);
  const awayForm = parseForm(awayFormRaw || [], awayTeamId);

  // Referee stats
  const refName = fixtureDetail?.fixture?.referee || '';
  const referee = { name: refName, avgYellowCards: 3.5, avgRedCards: 0.1, avgFouls: 24 };

  // Weather/situational
  const venue = fixtureDetail?.fixture?.venue?.name || '';
  const situational = {
    weather: 'clear',
    temperature: 15,
    fatigueDays: 7,
    surfaceType: 'grass',
  };

  const completeness = Math.min(
    0.95,
    0.4 +
    (h2h.length >= 3 ? 0.2 : h2h.length * 0.067) +
    (homeForm.length >= 5 ? 0.2 : homeForm.length * 0.04) +
    (awayForm.length >= 5 ? 0.15 : awayForm.length * 0.03)
  );

  return {
    externalMatchId,
    sport: 'football',
    confidenceFactors: { dataCompleteness: completeness },
    h2h,
    homeForm,
    awayForm,
    referee,
    situational,
    additionalContext: { homeGoalsAvg: 1.35, awayGoalsAvg: 1.10 },
  };
}

// ─── BASKETBALL CLIENT ────────────────────────────────────────────────────────

async function fetchBasketballStats(
  homeTeamId: number,
  awayTeamId: number,
  externalMatchId: string,
): Promise<RawStats> {
  const season = CURRENT_SEASON.basketball;

  const h2hKey = `h2h:basketball:${Math.min(homeTeamId, awayTeamId)}-${Math.max(homeTeamId, awayTeamId)}`;
  let h2hRaw = fromCache<any[]>(h2hKey);
  if (!h2hRaw) {
    h2hRaw = await apiFetch<any[]>('basketball', '/games', {
      h2h: `${homeTeamId}-${awayTeamId}`, last: '6',
    });
    toCache(h2hKey, h2hRaw, TTL.h2h);
  }

  const homeFormKey = `form:basketball:${homeTeamId}`;
  let homeFormRaw = fromCache<any[]>(homeFormKey);
  if (!homeFormRaw) {
    homeFormRaw = await apiFetch<any[]>('basketball', '/games', {
      team: String(homeTeamId), season, last: '8',
    });
    toCache(homeFormKey, homeFormRaw, TTL.form);
  }

  const awayFormKey = `form:basketball:${awayTeamId}`;
  let awayFormRaw = fromCache<any[]>(awayFormKey);
  if (!awayFormRaw) {
    awayFormRaw = await apiFetch<any[]>('basketball', '/games', {
      team: String(awayTeamId), season, last: '8',
    });
    toCache(awayFormKey, awayFormRaw, TTL.form);
  }

  const parseGame = (games: any[], teamId: number) =>
    (games || []).map((g: any) => {
      const isHome = g.teams?.home?.id === teamId;
      const pts = isHome ? g.scores?.home?.total : g.scores?.away?.total;
      const opp = isHome ? g.scores?.away?.total : g.scores?.home?.total;
      const result = pts > opp ? 'W' : pts < opp ? 'L' : 'D';
      return {
        date: g.date?.slice(0, 10) || '',
        opponent: isHome ? g.teams?.away?.name : g.teams?.home?.name,
        result: result as 'W' | 'L' | 'D',
        goalsFor: pts ?? 0,
        goalsAgainst: opp ?? 0,
        venue: (isHome ? 'home' : 'away') as 'home' | 'away',
      };
    });

  const h2h = (h2hRaw || []).map((g: any) => ({
    date: g.date?.slice(0, 10) || '',
    homeTeam: g.teams?.home?.name || '',
    awayTeam: g.teams?.away?.name || '',
    homeScore: g.scores?.home?.total ?? 0,
    awayScore: g.scores?.away?.total ?? 0,
  }));

  const homeForm = parseGame(homeFormRaw || [], homeTeamId);
  const awayForm = parseGame(awayFormRaw || [], awayTeamId);

  const completeness = Math.min(0.95,
    0.4 +
    (h2h.length >= 3 ? 0.2 : h2h.length * 0.067) +
    (homeForm.length >= 5 ? 0.2 : homeForm.length * 0.04) +
    (awayForm.length >= 5 ? 0.15 : awayForm.length * 0.03)
  );

  return {
    externalMatchId,
    sport: 'basketball',
    confidenceFactors: { dataCompleteness: completeness },
    h2h,
    homeForm,
    awayForm,
    referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 42 },
    situational: { weather: 'indoor', temperature: 20, fatigueDays: 3 },
    additionalContext: { pace: 100 },
  };
}

// ─── HOCKEY CLIENT ────────────────────────────────────────────────────────────

async function fetchHockeyStats(
  homeTeamId: number,
  awayTeamId: number,
  externalMatchId: string,
): Promise<RawStats> {
  const season = CURRENT_SEASON.hockey;

  const h2hKey = `h2h:hockey:${Math.min(homeTeamId, awayTeamId)}-${Math.max(homeTeamId, awayTeamId)}`;
  let h2hRaw = fromCache<any[]>(h2hKey);
  if (!h2hRaw) {
    h2hRaw = await apiFetch<any[]>('hockey', '/games', {
      h2h: `${homeTeamId}-${awayTeamId}`, last: '6',
    });
    toCache(h2hKey, h2hRaw, TTL.h2h);
  }

  const homeFormKey = `form:hockey:${homeTeamId}`;
  let homeFormRaw = fromCache<any[]>(homeFormKey);
  if (!homeFormRaw) {
    homeFormRaw = await apiFetch<any[]>('hockey', '/games', {
      team: String(homeTeamId), season, last: '8',
    });
    toCache(homeFormKey, homeFormRaw, TTL.form);
  }

  const awayFormKey = `form:hockey:${awayTeamId}`;
  let awayFormRaw = fromCache<any[]>(awayFormKey);
  if (!awayFormRaw) {
    awayFormRaw = await apiFetch<any[]>('hockey', '/games', {
      team: String(awayTeamId), season, last: '8',
    });
    toCache(awayFormKey, awayFormRaw, TTL.form);
  }

  const parseGame = (games: any[], teamId: number) =>
    (games || []).map((g: any) => {
      const isHome = g.teams?.home?.id === teamId;
      const pts = isHome ? g.scores?.home : g.scores?.away;
      const opp = isHome ? g.scores?.away : g.scores?.home;
      const result = pts > opp ? 'W' : pts < opp ? 'L' : 'D';
      return {
        date: g.date?.slice(0, 10) || '',
        opponent: isHome ? g.teams?.away?.name : g.teams?.home?.name,
        result: result as 'W' | 'L' | 'D',
        goalsFor: pts ?? 0,
        goalsAgainst: opp ?? 0,
        venue: (isHome ? 'home' : 'away') as 'home' | 'away',
      };
    });

  const h2h = (h2hRaw || []).map((g: any) => ({
    date: g.date?.slice(0, 10) || '',
    homeTeam: g.teams?.home?.name || '',
    awayTeam: g.teams?.away?.name || '',
    homeScore: g.scores?.home ?? 0,
    awayScore: g.scores?.away ?? 0,
  }));

  const homeForm = parseGame(homeFormRaw || [], homeTeamId);
  const awayForm = parseGame(awayFormRaw || [], awayTeamId);

  const completeness = Math.min(0.95,
    0.4 +
    (h2h.length >= 3 ? 0.2 : h2h.length * 0.067) +
    (homeForm.length >= 5 ? 0.2 : homeForm.length * 0.04) +
    (awayForm.length >= 5 ? 0.15 : awayForm.length * 0.03)
  );

  return {
    externalMatchId,
    sport: 'hockey',
    confidenceFactors: { dataCompleteness: completeness },
    h2h,
    homeForm,
    awayForm,
    referee: { name: '', avgYellowCards: 14, avgRedCards: 0, avgFouls: 0 },
    situational: { weather: 'indoor', temperature: 18, fatigueDays: 4 },
    additionalContext: {},
  };
}

// ─── TENNIS CLIENT ────────────────────────────────────────────────────────────

async function fetchTennisStats(
  player1Id: number,
  player2Id: number,
  externalMatchId: string,
  surface: string = 'hard',
): Promise<RawStats> {
  const h2hKey = `h2h:tennis:${Math.min(player1Id, player2Id)}-${Math.max(player1Id, player2Id)}`;
  let h2hRaw = fromCache<any[]>(h2hKey);
  if (!h2hRaw) {
    h2hRaw = await apiFetch<any[]>('tennis', '/h2h', {
      h2h: `${player1Id}-${player2Id}`,
    });
    toCache(h2hKey, h2hRaw, TTL.h2h);
  }

  const p1FormKey = `form:tennis:${player1Id}`;
  let p1FormRaw = fromCache<any[]>(p1FormKey);
  if (!p1FormRaw) {
    p1FormRaw = await apiFetch<any[]>('tennis', '/games', {
      player: String(player1Id), last: '8',
    });
    toCache(p1FormKey, p1FormRaw, TTL.form);
  }

  const p2FormKey = `form:tennis:${player2Id}`;
  let p2FormRaw = fromCache<any[]>(p2FormKey);
  if (!p2FormRaw) {
    p2FormRaw = await apiFetch<any[]>('tennis', '/games', {
      player: String(player2Id), last: '8',
    });
    toCache(p2FormKey, p2FormRaw, TTL.form);
  }

  const h2h = (h2hRaw || []).map((g: any) => ({
    date: g.date?.slice(0, 10) || '',
    homeTeam: g.players?.home?.name || '',
    awayTeam: g.players?.away?.name || '',
    homeScore: g.scores?.home?.sets ?? 0,
    awayScore: g.scores?.away?.sets ?? 0,
  }));

  const parsePlayerForm = (games: any[], playerId: number) =>
    (games || []).map((g: any) => {
      const isHome = g.players?.home?.id === playerId;
      const myScore = isHome ? g.scores?.home?.sets : g.scores?.away?.sets;
      const oppScore = isHome ? g.scores?.away?.sets : g.scores?.home?.sets;
      const result = myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'D';
      return {
        date: g.date?.slice(0, 10) || '',
        opponent: isHome ? g.players?.away?.name : g.players?.home?.name,
        result: result as 'W' | 'L' | 'D',
        venue: 'home' as 'home' | 'away',
      };
    });

  const homeForm = parsePlayerForm(p1FormRaw || [], player1Id);
  const awayForm = parsePlayerForm(p2FormRaw || [], player2Id);

  const completeness = Math.min(0.90,
    0.4 +
    (h2h.length >= 3 ? 0.2 : h2h.length * 0.067) +
    (homeForm.length >= 5 ? 0.2 : homeForm.length * 0.04) +
    (awayForm.length >= 5 ? 0.15 : awayForm.length * 0.03)
  );

  return {
    externalMatchId,
    sport: 'tennis',
    confidenceFactors: { dataCompleteness: completeness },
    h2h,
    homeForm,
    awayForm,
    referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
    situational: { weather: 'clear', temperature: 22, fatigueDays: 3, surfaceType: surface },
    additionalContext: {
      surfaceType: surface,
      homeSurfaceSpecialist: surface,
      awaySurfaceSpecialist: 'hard',
      homeServeDominant: false,
      awayServeDominant: false,
    },
  };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export class SportsClient {
  async fetchStats(
    sport: string,
    homeTeamId: number,
    awayTeamId: number,
    externalMatchId: string,
    fixtureId?: number,
    surface?: string,
  ): Promise<RawStats> {
    switch (sport) {
      case 'football':
        return fetchFootballStats(homeTeamId, awayTeamId, fixtureId || 0, externalMatchId);
      case 'basketball':
        return fetchBasketballStats(homeTeamId, awayTeamId, externalMatchId);
      case 'hockey':
        return fetchHockeyStats(homeTeamId, awayTeamId, externalMatchId);
      case 'tennis':
        return fetchTennisStats(homeTeamId, awayTeamId, externalMatchId, surface);
      default:
        throw new Error(`Unknown sport: ${sport}`);
    }
  }

  clearCache() {
    statsCache.clear();
  }
}

export const sportsClient = new SportsClient();