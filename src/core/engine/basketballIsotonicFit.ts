// src/core/engine/basketballIsotonicFit.ts
//
// Fits isotonic regression to correct basketball model overconfidence,
// using the same pooled 2021-2024 WNBA data (936 predictions, confirmed
// working) as basketballBacktest.ts — this file reuses that exact data
// pipeline (fetch/parse/stats-reconstruction) verbatim, then adds PAVA
// fitting on top, same approach as tennisIsotonicFit.ts.
//
// PREREQUISITE: run this only after the home-court advantage fix has been
// applied to modelBasketball() in probabilityModel.ts (HOME_COURT_ADVANTAGE
// term) — fitting calibration on top of the old biased formula would just
// curve-fit the bias instead of fixing it. Confirmed fixed via
// basketballBacktest.ts's home/away split before this was written.
//
// Switch WNBA -> NBA later by changing LEAGUE below.
//
// Run with: npx ts-node src/core/engine/basketballIsotonicFit.ts

import * as cheerio from 'cheerio';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const LEAGUE: 'wnba' | 'nba' = 'wnba';
const POOL_YEARS = [2021, 2022, 2023, 2024];
const FORM_WINDOW = 10; // ASSUMPTION — adjust to match your real stats aggregator
const MIN_PRIOR_GAMES = 5;
const MIN_RELIABLE_WEIGHT = 20; // blocks with fewer pooled samples than this are treated as noise (same threshold proven on tennis)

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

interface RawPrediction {
  rawProb: number; // favorite-side probability
  hit: number;
}

function buildScheduleUrl(year: number): string {
  return LEAGUE === 'wnba'
    ? `https://www.basketball-reference.com/wnba/years/${year}_games.html`
    : `https://www.basketball-reference.com/leagues/NBA_${year}_games.html`;
}

async function fetchSeason(year: number): Promise<HistGame[]> {
  try {
    const res = await fetch(buildScheduleUrl(year), { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);

    const games: HistGame[] = [];
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

    games.sort((a, b) => a.date.getTime() - b.date.getTime());
    console.log(`  ✓ ${year}: ${games.length} games`);
    return games;
  } catch (err: any) {
    console.error(`  ✗ ${year} FAILED: ${err.message}`);
    return [];
  }
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

function generateRawPredictions(allGames: HistGame[], testYears: number[]): RawPrediction[] {
  const predictions: RawPrediction[] = [];
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
      referee: {},
      situational: { fatigueDays },
      additionalContext: { homeFatigue },
      confidenceFactors: {
        dataCompleteness: 1,
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

    const rawProb = Math.max(homeProb, 1 - homeProb);
    const predictedHome = homeProb >= 0.5;
    const actualHome = game.homeScore > game.awayScore;
    const hit = predictedHome === actualHome ? 1 : 0;

    predictions.push({ rawProb, hit });
  }

  return predictions;
}

// ─── ISOTONIC REGRESSION (Pool Adjacent Violators Algorithm) ───────────
// Identical approach to tennisIsotonicFit.ts, including the reliable-
// cutoff tail-capping fix (excludes low-weight singleton blocks from
// interpolation instead of letting noise drag the calibrated average up).

interface IsotonicPoint {
  x: number;
  y: number;
  weight: number;
}

function fitIsotonicRegression(predictions: RawPrediction[]): IsotonicPoint[] {
  const sorted = [...predictions].sort((a, b) => a.rawProb - b.rawProb);
  let blocks: IsotonicPoint[] = sorted.map(p => ({ x: p.rawProb, y: p.hit, weight: 1 }));

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].y > blocks[i + 1].y) {
        const totalWeight = blocks[i].weight + blocks[i + 1].weight;
        const mergedY = (blocks[i].y * blocks[i].weight + blocks[i + 1].y * blocks[i + 1].weight) / totalWeight;
        const mergedX = (blocks[i].x * blocks[i].weight + blocks[i + 1].x * blocks[i + 1].weight) / totalWeight;
        blocks.splice(i, 2, { x: mergedX, y: mergedY, weight: totalWeight });
        merged = true;
        break;
      }
    }
  }

  return blocks;
}

function findReliableCutoff(blocks: IsotonicPoint[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return blocks.length - 1;
}

// Mirror of findReliableCutoff, but walking forward from the start. Any
// low-weight singleton/noise blocks at the bottom of the range (e.g. a
// single game near x=0.50 with y=0.0000) get excluded the same way the
// high-end tail is — floored at the first reliable block instead of
// letting noise drag near-coinflip predictions toward a wrong extreme.
function findReliableStart(blocks: IsotonicPoint[]): number {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return 0;
}

function isotonicPredict(blocks: IsotonicPoint[], rawProb: number, startIdx: number, cutoffIdx: number): number {
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);

  if (rawProb <= reliableBlocks[0].x) return reliableBlocks[0].y;
  if (rawProb >= reliableBlocks[reliableBlocks.length - 1].x) {
    return reliableBlocks[reliableBlocks.length - 1].y;
  }

  for (let i = 0; i < reliableBlocks.length - 1; i++) {
    if (rawProb >= reliableBlocks[i].x && rawProb <= reliableBlocks[i + 1].x) {
      const t = (rawProb - reliableBlocks[i].x) / (reliableBlocks[i + 1].x - reliableBlocks[i].x || 1);
      return reliableBlocks[i].y + t * (reliableBlocks[i + 1].y - reliableBlocks[i].y);
    }
  }
  return rawProb;
}

function evaluateCalibration(predictions: RawPrediction[], blocks: IsotonicPoint[], startIdx: number, cutoffIdx: number) {
  console.log('\nBand       | Raw Avg | Calibrated Avg | Actual Hit Rate | Games');
  console.log('------------------------------------------------------------------');
  const bandDefs = [
    { label: '50-65%', min: 0.50, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80%+',   min: 0.80, max: 1.01 },
  ];
  for (const band of bandDefs) {
    const items = predictions.filter(p => p.rawProb >= band.min && p.rawProb < band.max);
    if (!items.length) continue;
    const rawAvg = items.reduce((s, p) => s + p.rawProb, 0) / items.length;
    const calAvg = items.reduce((s, p) => s + isotonicPredict(blocks, p.rawProb, startIdx, cutoffIdx), 0) / items.length;
    const hitRate = items.reduce((s, p) => s + p.hit, 0) / items.length;
    console.log(`${band.label.padEnd(10)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(calAvg * 100).toFixed(1).padStart(14)}% | ${(hitRate * 100).toFixed(1).padStart(15)}% | ${items.length}`);
  }
}

async function main() {
  console.log(`Fitting isotonic regression for basketball model (${LEAGUE.toUpperCase()}, pooled ${POOL_YEARS.join(', ')})...\n`);

  const allGamesNested = await Promise.all(POOL_YEARS.map(y => fetchSeason(y)));
  const allGames = allGamesNested.flat().sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`\nGenerating raw predictions across pooled years ${POOL_YEARS.join(', ')}...`);
  const predictions = generateRawPredictions(allGames, POOL_YEARS);
  console.log(`Total predictions for fitting: ${predictions.length}`);

  const blocks = fitIsotonicRegression(predictions);
  const startIdx = findReliableStart(blocks);
  const cutoffIdx = findReliableCutoff(blocks);
  console.log(`\nFitted isotonic regression: ${blocks.length} monotonic blocks`);
  console.log(`Reliable range: blocks ${startIdx}-${cutoffIdx} (low: x=${blocks[startIdx].x.toFixed(4)}, y=${blocks[startIdx].y.toFixed(4)}, weight=${blocks[startIdx].weight} | high: x=${blocks[cutoffIdx].x.toFixed(4)}, y=${blocks[cutoffIdx].y.toFixed(4)}, weight=${blocks[cutoffIdx].weight}) — ${startIdx} low-end + ${blocks.length - 1 - cutoffIdx} high-end noisy blocks excluded from prediction`);

  console.log('\n=== BEFORE/AFTER CALIBRATION CHECK (both tails capped) ===');
  evaluateCalibration(predictions, blocks, startIdx, cutoffIdx);

  console.log('\n=== Calibration lookup table (for embedding in probabilityModel.ts) ===');
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);
  const step = Math.max(1, Math.floor(reliableBlocks.length / 30));
  for (let i = 0; i < reliableBlocks.length; i += step) {
    console.log(`  { x: ${reliableBlocks[i].x.toFixed(4)}, y: ${reliableBlocks[i].y.toFixed(4)} }, // weight: ${reliableBlocks[i].weight}`);
  }
  console.log(`  // Any rawProb <= ${reliableBlocks[0].x.toFixed(4)} should be floored at y: ${reliableBlocks[0].y.toFixed(4)} in probabilityModel.ts`);
  console.log(`  // Any rawProb >= ${reliableBlocks[reliableBlocks.length - 1].x.toFixed(4)} should be capped at y: ${reliableBlocks[reliableBlocks.length - 1].y.toFixed(4)} in probabilityModel.ts`);
}

main().catch(err => {
  console.error('[BasketballIsotonicFit] Fatal error:', err.message);
  process.exit(1);
});