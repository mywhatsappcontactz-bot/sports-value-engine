import 'dotenv/config';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { RawStats } from './mockClient';
import { LEAGUE_ID_MAP } from './teamMapper';

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const BASE_URL = 'https://v3.football.api-sports.io';
const SEASON = 2024;
const RATE_LIMIT_MS = 6500;

// ─── API HELPER ──────────────────────────────────────────────────────────────

async function apiFetch<T>(endpoint: string): Promise<T> {
  const key = process.env.API_SPORTS_KEY!;
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { 'x-apisports-key': key },
  });

  if (!res.ok) {
    throw new Error(`API-Sports ${endpoint} failed: ${res.status}`);
  }

  const data = await res.json() as any;

  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API-Sports error: ${JSON.stringify(data.errors)}`);
  }

  return data.response as T;
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── TEAM LOOKUP ─────────────────────────────────────────────────────────────

function getTeamId(sport: string, teamName: string): number | null {
  const db = getDb();
  const normalized = teamName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const row = db.prepare(
    'SELECT apiSportsTeamId FROM team_mappings WHERE sport = ? AND teamNameNormalized = ?'
  ).get(sport, normalized) as { apiSportsTeamId: number } | undefined;
  return row?.apiSportsTeamId ?? null;
}

// ─── PARSERS ─────────────────────────────────────────────────────────────────

function parseForm(fixtures: any[], teamId: number, limit = 6): RawStats['homeForm'] {
  return fixtures
    .slice(-limit)
    .map((f: any) => {
      const isHome    = f.teams.home.id === teamId;
      const teamGoals = isHome ? f.goals.home : f.goals.away;
      const oppGoals  = isHome ? f.goals.away : f.goals.home;
      const opponent  = isHome ? f.teams.away.name : f.teams.home.name;
      const venue     = isHome ? 'home' as const : 'away' as const;

      let result: 'W' | 'L' | 'D' = 'D';
      if (teamGoals > oppGoals) result = 'W';
      else if (teamGoals < oppGoals) result = 'L';

      return {
        date: f.fixture.date.split('T')[0],
        opponent,
        result,
        goalsFor:     teamGoals ?? 0,
        goalsAgainst: oppGoals  ?? 0,
        venue,
      };
    });
}

function parseH2H(fixtures: any[]): RawStats['h2h'] {
  return fixtures.slice(-5).map((f: any) => ({
    date:      f.fixture.date.split('T')[0],
    homeTeam:  f.teams.home.name,
    awayTeam:  f.teams.away.name,
    homeScore: f.goals.home ?? 0,
    awayScore: f.goals.away ?? 0,
  }));
}

// ─── STATS CLIENT ────────────────────────────────────────────────────────────

export class StatsClient {

  async fetchStats(
    externalMatchId: string,
    sport: string,
    homeTeam: string,
    awayTeam: string,
    leagueName: string,
  ): Promise<RawStats | null> {

    const leagueId = LEAGUE_ID_MAP[leagueName];
    if (!leagueId) {
      logger.warn('[StatsClient] No league ID', { leagueName });
      return null;
    }

    const homeId = getTeamId(sport, homeTeam);
    const awayId = getTeamId(sport, awayTeam);

    if (!homeId || !awayId) {
      logger.warn('[StatsClient] Missing team IDs', { homeTeam, awayTeam, homeId, awayId });
      return null;
    }

    try {
      // Request 1: H2H
      const h2hFixtures = await apiFetch<any[]>(
        `/fixtures/headtohead?h2h=${homeId}-${awayId}&season=${SEASON}&status=FT`
      );
      await delay(RATE_LIMIT_MS);

      // Request 2: Home team fixtures this season
      const homeFixtures = await apiFetch<any[]>(
        `/fixtures?team=${homeId}&season=${SEASON}&status=FT`
      );
      await delay(RATE_LIMIT_MS);

      // Request 3: Away team fixtures this season
      const awayFixtures = await apiFetch<any[]>(
        `/fixtures?team=${awayId}&season=${SEASON}&status=FT`
      );
      await delay(RATE_LIMIT_MS);

      // Request 4: Home team statistics
      const homeStats = await apiFetch<any>(
        `/teams/statistics?team=${homeId}&league=${leagueId}&season=${SEASON}`
      );
      await delay(RATE_LIMIT_MS);

      // Request 5: Away team statistics
      const awayStats = await apiFetch<any>(
        `/teams/statistics?team=${awayId}&league=${leagueId}&season=${SEASON}`
      );
      await delay(RATE_LIMIT_MS);

      // Goals averages from statistics endpoint
      const homeGoalsAvg = parseFloat(
        (homeStats as any)?.goals?.for?.average?.total ?? '0'
      );
      const awayGoalsAvg = parseFloat(
        (awayStats as any)?.goals?.for?.average?.total ?? '0'
      );

      // Data completeness
      const hasH2H   = h2hFixtures.length >= 3;
      const hasForm  = homeFixtures.length >= 3 && awayFixtures.length >= 3;
      const hasGoals = homeGoalsAvg > 0 && awayGoalsAvg > 0;
      const completeness = [hasH2H, hasForm, hasGoals].filter(Boolean).length / 3;

      const rawStats: RawStats = {
        externalMatchId,
        sport,
        homeGoalsAvg,
        awayGoalsAvg,
        h2h:      parseH2H(h2hFixtures),
        homeForm: parseForm(homeFixtures, homeId),
        awayForm: parseForm(awayFixtures, awayId),
        referee: {
          name:            '',
          avgYellowCards:  0,
          avgRedCards:     0,
          avgFouls:        0,
        },
        situational: {
          weather:     'unknown',
          temperature: 15,
          fatigueDays: 5,
          surfaceType: 'grass',
        },
        confidenceFactors: {
          dataCompleteness: parseFloat(completeness.toFixed(2)),
        },
        additionalContext: {
          homeTeamId: homeId,
          awayTeamId: awayId,
          leagueId,
        },
      };

      logger.info('[StatsClient] Stats fetched', {
        match:         `${homeTeam} vs ${awayTeam}`,
        homeGoalsAvg,
        awayGoalsAvg,
        h2hCount:      rawStats.h2h.length,
        homeFormCount: rawStats.homeForm.length,
        awayFormCount: rawStats.awayForm.length,
        completeness:  rawStats.confidenceFactors.dataCompleteness,
      });

      return rawStats;

    } catch (err: any) {
      logger.error('[StatsClient] Fetch failed', {
        match: `${homeTeam} vs ${awayTeam}`,
        error: err.message,
      });
      return null;
    }
  }
}

export const statsClient = new StatsClient();