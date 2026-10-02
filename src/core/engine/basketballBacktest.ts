// src/core/engine/basketballBacktest.ts
//
// Backtests modelBasketball's moneyline output against real historical
// WNBA results scraped from Basketball-Reference. No fitting — this just
// reports Raw Avg vs Actual Hit Rate per confidence band, same as the
// tennis script's "BEFORE" table.
//
// ASSUMPTIONS (flagged because the real aggregator logic wasn't visible
// to me — adjust these constants if your production stats builder differs):
//   - FORM_WINDOW: last N games count as "form" (10 assumed)
//   - fatigueDays = min(homeRestDays, awayRestDays) since each team's
//     previous game; homeFatigue = homeRestDays < awayRestDays
//
// Switch WNBA -> NBA later by changing LEAGUE below; URL builder and
// parsing logic are shared.
//
// Run with: npx ts-node src/core/engine/basketballBacktest.ts

import * as cheerio from 'cheerio';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const LEAGUE: 'wnba' | 'nba' = 'wnba';
const POOL_YEARS = [2021, 2022, 2023, 2024];
const FORM_WINDOW = 10; // ASSUMPTION — adjust to match your real stats aggregator
const MIN_PRIOR_GAMES = 5;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

interface HistGame {
  date: Date;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
}

interface TeamGameRecord {
  date: Date;
  opponent: string;
  result: 'W' | 'L';
  isHome: boolean;
  pointsFor: number;
  pointsAgainst: number;
}

interface RawResult {
  rawProb: number; // favorite-side probability
  hit: number;
  predictedHome: boolean; // true if the model favored the home team
}

function buildScheduleUrl(year: number): string {
  return LEAGUE === 'wnba'
    ? `https://www.basketball-reference.com/wnba/years/${year}_games.html`
    : `https://www.basketball-reference.com/leagues/NBA_${year}_games.html`;
}

const NBA_SEASON_MONTHS = ['october', 'november', 'december', 'january', 'february', 'march', 'april'];

function buildScheduleUrls(year: number): string[] {
  if (LEAGUE === 'wnba') {
    return [`https://www.basketball-reference.com/wnba/years/${year}_games.html`];
  }
  // NBA: unlike WNBA's single combined page, each month is a separate URL.
  // Confirmed via a too-small game count (54-102/season instead of ~1,230)
  // when only fetching the no-suffix page, which defaults to one month.
  return NBA_SEASON_MONTHS.map(
    month => `https://www.basketball-reference.com/leagues/NBA_${year}_games-${month}.html`
  );
}

async function fetchSeason(year: number): Promise<HistGame[]> {
  const urls = buildScheduleUrls(year);
  const games: HistGame[] = [];

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        // A 404 on a given NBA month (e.g. incomplete/future season) is
        // expected sometimes — skip it rather than failing the whole season.
        console.error(`    ✗ ${url} HTTP ${res.status} (skipped)`);
        continue;
      }
      const html = await res.text();
      const $ = cheerio.load(html);

      $('table#schedule tbody tr, table[id^="games"] tbody tr').each((_i: number, el: any) => {
        const $row = $(el);
        const dateStr = $row.find('th[data-stat="date_game"], td[data-stat="date_game"]').text().trim();
        const awayTeam = $row.find('td[data-stat="visitor_team_name"]').text().trim();
        const homeTeam = $row.find('td[data-stat="home_team_name"]').text().trim();
        const awayScoreStr = $row.find('td[data-stat="visitor_pts"]').text().trim();
        const homeScoreStr = $row.find('td[data-stat="home_pts"]').text().trim();

        if (!dateStr || !awayTeam || !homeTeam || !awayScoreStr || !homeScoreStr) return;

        const date = new Date(dateStr);
        const awayScore = parseInt(awayScoreStr, 10);
        const homeScore = parseInt(homeScoreStr, 10);
        if (isNaN(date.getTime()) || isNaN(awayScore) || isNaN(homeScore)) return;

        games.push({ date, homeTeam, awayTeam, homeScore, awayScore });
      });
    } catch (err: any) {
      console.error(`    ✗ ${url} FAILED: ${err.message}`);
    }
  }

  games.sort((a, b) => a.date.getTime() - b.date.getTime());
  console.log(`  ✓ ${year}: ${games.length} games`);
  return games;
}

function buildTeamHistoryMap(games: HistGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(team: string, rec: TeamGameRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }
  for (const g of games) {
    push(g.homeTeam, {
      date: g.date,
      opponent: g.awayTeam,
      result: g.homeScore > g.awayScore ? 'W' : 'L',
      isHome: true,
      pointsFor: g.homeScore,
      pointsAgainst: g.awayScore,
    });
    push(g.awayTeam, {
      date: g.date,
      opponent: g.homeTeam,
      result: g.awayScore > g.homeScore ? 'W' : 'L',
      isHome: false,
      pointsFor: g.awayScore,
      pointsAgainst: g.homeScore,
    });
  }
  return map;
}

function toFormRecords(recent: TeamGameRecord[]): FormRecord[] {
  return recent.map(r => ({
    date: r.date.toISOString(),
    opponent: r.opponent,
    result: r.result,
    goalsFor: r.pointsFor,
    goalsAgainst: r.pointsAgainst,
    venue: r.isHome ? 'home' : 'away',
  }));
}

// H2HRecord (confirmed against schema.ts) requires date/homeTeam/awayTeam/
// winner, not just scores. Each prior meeting is normalized to the CURRENT
// match's home/away perspective — e.g. if these two teams met before with
// today's away team playing at home, scores/teams are flipped so homeTeam
// in the record always matches today's homeTeam. This matters because
// h2hWinRate() checks `r.winner === perspective` directly against today's
// 'home'/'away' labels, not against which team physically hosted historically.
function toH2HRecords(homeTeam: string, awayTeam: string, priorGames: HistGame[]): H2HRecord[] {
  return priorGames
    .filter(g => (g.homeTeam === homeTeam && g.awayTeam === awayTeam) || (g.homeTeam === awayTeam && g.awayTeam === homeTeam))
    .map(g => {
      const flip = g.homeTeam !== homeTeam;
      const normHomeScore = flip ? g.awayScore : g.homeScore;
      const normAwayScore = flip ? g.homeScore : g.awayScore;
      const winner: 'home' | 'away' | 'draw' =
        normHomeScore > normAwayScore ? 'home' : normAwayScore > normHomeScore ? 'away' : 'draw';
      return {
        date: g.date.toISOString(),
        homeTeam,
        awayTeam,
        homeScore: normHomeScore,
        awayScore: normAwayScore,
        winner,
      };
    });
}

function daysSinceLastGame(history: TeamGameRecord[], asOf: Date): number | undefined {
  if (!history.length) return undefined;
  const last = history[history.length - 1];
  return Math.floor((asOf.getTime() - last.date.getTime()) / (1000 * 60 * 60 * 24));
}

function generateBacktestResults(allGames: HistGame[], testYears: number[]): RawResult[] {
  const results: RawResult[] = [];
  const testGames = allGames.filter(g => testYears.includes(g.date.getFullYear()));

  for (const game of testGames) {
    const priorGames = allGames.filter(g => g.date.getTime() < game.date.getTime());
    const historyMap = buildTeamHistoryMap(priorGames);

    const homeHistory = historyMap.get(game.homeTeam) ?? [];
    const awayHistory = historyMap.get(game.awayTeam) ?? [];
    if (homeHistory.length < MIN_PRIOR_GAMES || awayHistory.length < MIN_PRIOR_GAMES) continue;

    const homeRecent = homeHistory.slice(-FORM_WINDOW);
    const awayRecent = awayHistory.slice(-FORM_WINDOW);

    const homeRest = daysSinceLastGame(homeHistory, game.date);
    const awayRest = daysSinceLastGame(awayHistory, game.date);
    const fatigueDays = homeRest !== undefined && awayRest !== undefined ? Math.min(homeRest, awayRest) : undefined;
    const homeFatigue = homeRest !== undefined && awayRest !== undefined ? homeRest < awayRest : undefined;

    const h2hRecords = toH2HRecords(game.homeTeam, game.awayTeam, priorGames);
    const matchId = `${game.homeTeam}-${game.awayTeam}-${game.date.toISOString()}`;

    const stats: Stats = {
      id: `stats-${matchId}`,
      matchId,
      sport: 'basketball',
      h2h: h2hRecords,
      homeForm: toFormRecords(homeRecent),
      awayForm: toFormRecords(awayRecent),
      referee: {}, // no historical referee data available from Basketball-Reference
      situational: { fatigueDays },
      additionalContext: { homeFatigue },
      confidenceFactors: {
        // Real sample sizes from this backtest — not placeholders.
        dataCompleteness: 1, // both teams met MIN_PRIOR_GAMES, form/h2h fully populated
        h2hSampleSize: h2hRecords.length,
        formSampleSize: Math.min(homeRecent.length, awayRecent.length),
      },
    };

    const input: ModelInput = {
      match: {
        id: matchId,
        sport: 'basketball',
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        startTime: game.date.toISOString(),
      },
      stats,
      odds: [],
    };

    const probs = getProbabilities(input);
    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const rawProb = Math.max(homeProb, 1 - homeProb); // favorite-side confidence
    const predictedHome = homeProb >= 0.5;
    const actualHome = game.homeScore > game.awayScore;
    const hit = predictedHome === actualHome ? 1 : 0;

    results.push({ rawProb, hit, predictedHome });
  }

  return results;
}

function evaluateBands(results: RawResult[]) {
  console.log('\nBand       | Raw Avg | Actual Hit Rate | Games');
  console.log('----------------------------------------------------');
  const bandDefs = [
    { label: '50-65%', min: 0.50, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80%+',   min: 0.80, max: 1.01 },
  ];
  for (const band of bandDefs) {
    const items = results.filter(r => r.rawProb >= band.min && r.rawProb < band.max);
    if (!items.length) continue;
    const rawAvg = items.reduce((s, r) => s + r.rawProb, 0) / items.length;
    const hitRate = items.reduce((s, r) => s + r.hit, 0) / items.length;
    console.log(`${band.label.padEnd(10)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(hitRate * 100).toFixed(1).padStart(15)}% | ${items.length}`);
  }
}

function evaluateHomeAwaySplit(results: RawResult[]) {
  console.log('\nSplit          | Predictions | Raw Avg | Actual Hit Rate');
  console.log('-------------------------------------------------------------');
  const groups: { label: string; items: RawResult[] }[] = [
    { label: 'Home favored', items: results.filter(r => r.predictedHome) },
    { label: 'Away favored', items: results.filter(r => !r.predictedHome) },
  ];
  for (const g of groups) {
    if (!g.items.length) continue;
    const rawAvg = g.items.reduce((s, r) => s + r.rawProb, 0) / g.items.length;
    const hitRate = g.items.reduce((s, r) => s + r.hit, 0) / g.items.length;
    console.log(`${g.label.padEnd(15)}| ${String(g.items.length).padStart(11)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(hitRate * 100).toFixed(1).padStart(15)}%`);
  }
}

async function main() {
  console.log(`Backtesting basketball model (${LEAGUE.toUpperCase()}, ${POOL_YEARS.join(', ')})...\n`);

  const allGamesNested = await Promise.all(POOL_YEARS.map(y => fetchSeason(y)));
  const allGames = allGamesNested.flat().sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`\nGenerating backtest predictions...`);
  const results = generateBacktestResults(allGames, POOL_YEARS);
  console.log(`Total predictions: ${results.length}`);

  console.log('\n=== MONEYLINE BACKTEST (no calibration applied) ===');
  evaluateBands(results);

  console.log('\n=== HOME vs AWAY FAVORITE SPLIT ===');
  evaluateHomeAwaySplit(results);
}

main().catch(err => {
  console.error('[BasketballBacktest] Fatal error:', err.message);
  process.exit(1);
});