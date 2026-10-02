// src/scrapers/football-nfl/nflScraper.ts
//
// Pulls NFL schedule/results via ESPN's public JSON API — confirmed live,
// no auth required, no Cloudflare protection (unlike Proballers/RealGM
// individual game pages tonight). This is real JSON, not HTML regex
// parsing, so there's no markup-drift risk the way the football/basketball
// scrapers had.
//
// CONFIRMED WORKING (direct fetch, this session):
//   https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard
// Returns real 2026 season data — confirmed real preseason game (Panthers
// 33, Cardinals 30, Aug 6 2026) with full event/competitor/score structure.
//
// PATTERN CONFIRMED BUT NOT DIRECTLY RE-FETCHED (extensive independent
// documentation — GitHub gists, dev blogs — all agree on this exact
// shape, high confidence):
//   https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event={gameId}
// This is the boxscore/game-detail endpoint. main() below fetches it for
// a real completed game and prints the raw team stats so we can confirm
// the exact field names before building any totals/spread model on them.
//
// SEASON STRUCTURE (confirmed from the real scoreboard response):
//   Preseason: Aug 6 - Sep 8, 2026 (seasontype=1)
//   Regular season: Sep 9, 2026 - Jan 13, 2027, weeks 1-18 (seasontype=2)
//   Postseason: Jan 13 - Feb 16, 2027 (seasontype=3)
//
// Run with: npx ts-node src/scrapers/football-nfl/nflScraper.ts

import { logger } from '../../core/utils/logger';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const REQUEST_DELAY_MS = 500; // polite delay — ESPN publishes no official rate limit, so don't hammer it

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after 20s for ${url}`);
    throw new Error(`${err.message} | url: ${url}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── TYPES ──────────────────────────────────────────────────────────────

export interface NflGame {
  gameId: string;
  date: string;          // ISO yyyy-mm-dd
  homeTeam: string;       // abbreviation, e.g. "ARI"
  awayTeam: string;
  homeScore: number | null; // null if not yet played
  awayScore: number | null;
  completed: boolean;
  seasonType: number;     // 1=preseason, 2=regular, 3=postseason
  week: number;
}

// ─── PARSE (real JSON, no regex needed) ──────────────────────────────────

function parseScoreboardEvents(data: any): NflGame[] {
  const games: NflGame[] = [];
  const events = data?.events ?? [];

  for (const event of events) {
    const competition = event.competitions?.[0];
    if (!competition) continue;

    const competitors = competition.competitors ?? [];
    const home = competitors.find((c: any) => c.homeAway === 'home');
    const away = competitors.find((c: any) => c.homeAway === 'away');
    if (!home || !away) continue;

    const completed = competition.status?.type?.completed ?? false;
    const date = (event.date ?? '').split('T')[0];

    games.push({
      gameId: event.id,
      date,
      homeTeam: home.team?.abbreviation ?? home.team?.displayName ?? 'UNKNOWN',
      awayTeam: away.team?.abbreviation ?? away.team?.displayName ?? 'UNKNOWN',
      homeScore: completed ? parseInt(home.score, 10) : null,
      awayScore: completed ? parseInt(away.score, 10) : null,
      completed,
      seasonType: event.season?.type ?? data.season?.type ?? 0,
      week: event.week?.number ?? data.week?.number ?? 0,
    });
  }

  return games;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────

/**
 * Fetches one week's scoreboard. seasonType: 1=preseason, 2=regular, 3=postseason.
 * Omit both to get whatever week ESPN currently considers "current".
 */
export async function fetchWeekScoreboard(year?: number, seasonType?: number, week?: number): Promise<NflGame[]> {
  const params = new URLSearchParams();
  if (year) params.set('dates', String(year));
  if (seasonType) params.set('seasontype', String(seasonType));
  if (week) params.set('week', String(week));
  params.set('limit', '100');

  const url = `${BASE}/scoreboard?${params.toString()}`;
  const data = await fetchJson(url);
  await sleep(REQUEST_DELAY_MS);
  return parseScoreboardEvents(data);
}

/**
 * Fetches an entire season by walking every week of the given seasonType.
 * Regular season = 18 weeks, preseason = 4 "weeks" (incl. Hall of Fame).
 */
export async function fetchFullSeason(year: number, seasonType: 1 | 2 | 3): Promise<NflGame[]> {
  const weekCounts: Record<number, number> = { 1: 4, 2: 18, 3: 5 };
  const totalWeeks = weekCounts[seasonType];
  const allGames: NflGame[] = [];

  for (let week = 1; week <= totalWeeks; week++) {
    try {
      const games = await fetchWeekScoreboard(year, seasonType, week);
      logger.info(`[NflScraper] Season ${year} type ${seasonType} week ${week}: ${games.length} games`);
      allGames.push(...games);
    } catch (err: any) {
      logger.warn('[NflScraper] Week fetch failed', { year, seasonType, week, error: err.message });
    }
  }

  return allGames;
}

/**
 * Fetches the boxscore/summary for a single completed game — used both
 * for the verification test in main() and, later, for a real NFL totals
 * model once the field names are confirmed.
 */
export async function fetchGameSummary(gameId: string): Promise<any> {
  const url = `${BASE}/summary?event=${gameId}`;
  const data = await fetchJson(url);
  await sleep(REQUEST_DELAY_MS);
  return data;
}

// ─── DERIVED STATS (form / PPG / H2H — same pattern as proballersScraper.ts) ─

export interface TeamFormEntry {
  date: string;
  opponent: string;
  result: 'W' | 'L';
  pointsFor: number;
  pointsAgainst: number;
  venue: 'home' | 'away';
}

export function buildTeamForm(games: NflGame[], teamAbbr: string): TeamFormEntry[] {
  const entries: TeamFormEntry[] = [];
  for (const g of games) {
    if (!g.completed || g.homeScore === null || g.awayScore === null) continue;
    if (g.homeTeam === teamAbbr) {
      entries.push({
        date: g.date, opponent: g.awayTeam,
        result: g.homeScore > g.awayScore ? 'W' : 'L',
        pointsFor: g.homeScore, pointsAgainst: g.awayScore, venue: 'home',
      });
    } else if (g.awayTeam === teamAbbr) {
      entries.push({
        date: g.date, opponent: g.homeTeam,
        result: g.awayScore > g.homeScore ? 'W' : 'L',
        pointsFor: g.awayScore, pointsAgainst: g.homeScore, venue: 'away',
      });
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date)); // most recent first
}

export function averagePoints(form: TeamFormEntry[], key: 'pointsFor' | 'pointsAgainst', lastN = 10): number {
  const slice = form.slice(0, lastN);
  if (!slice.length) return 21; // rough NFL league-average points/game fallback
  return slice.reduce((s, e) => s + e[key], 0) / slice.length;
}

export function headToHead(games: NflGame[], teamA: string, teamB: string): NflGame[] {
  return games.filter(
    g => g.completed && ((g.homeTeam === teamA && g.awayTeam === teamB) || (g.homeTeam === teamB && g.awayTeam === teamA))
  );
}

// ─── QUICK TEST ─────────────────────────────────────────────────────────
// Run with: npx ts-node src/scrapers/football-nfl/nflScraper.ts

async function main() {
  console.log('Fetching current NFL scoreboard...');
  const current = await fetchWeekScoreboard();
  console.log(`\nGames found: ${current.length}`);
  current.forEach(g => {
    const scoreStr = g.completed ? `${g.homeScore}-${g.awayScore}` : 'not yet played';
    console.log(`  ${g.date} | ${g.homeTeam} vs ${g.awayTeam} | ${scoreStr} | gameId=${g.gameId} seasonType=${g.seasonType} week=${g.week}`);
  });

  console.log('\nFetching full 2026 preseason (4 weeks)...');
  const preseason = await fetchFullSeason(2026, 1);
  console.log(`Total preseason games: ${preseason.length}`);
  console.log(`Completed: ${preseason.filter(g => g.completed).length}`);

  if (preseason.length > 0) {
    const sampleTeam = preseason[0].homeTeam;
    const form = buildTeamForm(preseason, sampleTeam);
    console.log(`\nSample derived stats for "${sampleTeam}":`);
    console.log(`  Games found: ${form.length}`);
    if (form.length > 0) {
      console.log(`  Avg points for: ${averagePoints(form, 'pointsFor').toFixed(1)}`);
      console.log(`  Avg points against: ${averagePoints(form, 'pointsAgainst').toFixed(1)}`);
    }
  }

  // ── Boxscore verification test — confirms real field names before any
  // totals/spread model gets built on top of this endpoint.
  const completedGame = current.find(g => g.completed) ?? preseason.find(g => g.completed);
  if (completedGame) {
    console.log(`\nFetching boxscore for game ${completedGame.gameId} (${completedGame.homeTeam} vs ${completedGame.awayTeam})...`);
    try {
      const summary = await fetchGameSummary(completedGame.gameId);
      console.log('Boxscore team stats:');
      console.log(JSON.stringify(summary.boxscore?.teams, null, 2));
    } catch (err: any) {
      console.log(`Boxscore fetch failed: ${err.message}`);
    }
  } else {
    console.log('\nNo completed game found to test boxscore against.');
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[NflScraper] Fatal error:', err.message);
    process.exit(1);
  });
}