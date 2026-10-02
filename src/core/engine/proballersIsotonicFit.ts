// src/core/engine/proballersIsotonicFit.ts
//
// Fits isotonic regression to correct moneyline overconfidence for the
// Proballers international basketball leagues (24 leagues, post-exclusion
// of Argentina/Puerto Rico/Australia — confirmed below 70% hit rate on
// real backtest data — and Philippines — confirmed broken, stuck on
// stale 2011-12 data with no working current-season URL found).
//
// Same architecture as nbaIsotonicFit.ts/basketballIsotonicFit.ts: PAVA
// isotonic regression with a reliable low/high cutoff to exclude
// low-weight noisy blocks from the fitted lookup table.
//
// Uses the EXACT same elo+home-court formula that will ship in
// probabilityModel.ts (matching HOME_COURT_ADVANTAGE = 0.075, confirmed
// via basketballBacktest1.ts to close the earlier Home/Away imbalance),
// so this fit calibrates the real raw signal, not an approximation of it.
//
// Run with: npx ts-node src/core/engine/proballersIsotonicFit.ts

import {
  fetchLeagueSchedule,
  ProballersGame,
  PROBALLERS_LEAGUE_MAP,
} from '../../scrapers/basketball/Proballersscraper';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const MIN_RELIABLE_WEIGHT = 30;

// Same season-suffix sweep as basketballBacktest1.ts — confirmed to
// return distinct real historical data per year.
const SEASONS: (number | undefined)[] = [undefined, 2024, 2023, 2022, 2021];

// Same home-court value confirmed via basketballBacktest1.ts (closed a
// real Home/Away imbalance: 30/70 split -> 43/57, overall hit rate
// 78.1% -> 82.9%) and matching probabilityModel.ts's NBA/WNBA constant.
const HOME_COURT_ADVANTAGE = 0.075;

// Leagues confirmed broken or below the quality bar via
// basketballBacktest1.ts (2026-08-17 run) — excluded from this fit the
// same way they're excluded from that backtest's grand total.
const EXCLUDED_LEAGUES = new Set<string>([
  'Philippines - PBA',        // stuck on stale 2011-12 data, no working URL found
  'Liga A - Argentina',       // 57.5% hit rate, n=40
  'BSN - Puerto Rico',        // 64.3% hit rate, n=28
  'NBL - Australia',          // 66.7% hit rate, n=12
]);

const FIT_LEAGUES = Object.keys(PROBALLERS_LEAGUE_MAP).filter(l => !EXCLUDED_LEAGUES.has(l));

function seasonLabel(season: number | undefined): string {
  return season ? `${season}-${(season + 1).toString().slice(-2)}` : 'current';
}

// ─── TYPES ──────────────────────────────────────────────────────────────

interface TeamGameRecord {
  date: string;
  opponent: string;
  won: boolean;
  pointsFor: number;
  pointsAgainst: number;
}

interface RawPrediction {
  rawProb: number; // favorite-side confidence
  hit: number;
}

// ─── FORM HELPERS (same logic as basketballBacktest1.ts) ─────────────────

function buildHistory(games: ProballersGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(team: string, rec: TeamGameRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }
  for (const g of games) {
    push(g.homeTeam, { date: g.date, opponent: g.awayTeam, won: g.homeScore > g.awayScore, pointsFor: g.homeScore, pointsAgainst: g.awayScore });
    push(g.awayTeam, { date: g.date, opponent: g.homeTeam, won: g.awayScore > g.homeScore, pointsFor: g.awayScore, pointsAgainst: g.homeScore });
  }
  return map;
}

// CHANGED (see conversation): flat average replaced with exponential
// decay (0.85^i, i = games back from most recent) — matches
// basketballDecayWinRate now live in probabilityModel.ts's
// modelBasketball. Callers must pass records sorted most-recent-first
// (already true at every call site in this file — see the
// .sort((a, b) => b.date.localeCompare(a.date)) right before
// predictMoneyline is called).
function formWinRate(records: TeamGameRecord[]): number {
  if (!records.length) return 0.5;
  let weightSum = 0, valueSum = 0;
  records.forEach((r, i) => {
    const w = Math.pow(0.85, i);
    valueSum += (r.won ? 1 : 0) * w;
    weightSum += w;
  });
  return valueSum / weightSum;
}

function h2hHomeWinRate(games: ProballersGame[], homeTeam: string, awayTeam: string): number {
  const meetings = games.filter(
    g => (g.homeTeam === homeTeam && g.awayTeam === awayTeam) || (g.homeTeam === awayTeam && g.awayTeam === homeTeam)
  );
  if (!meetings.length) return 0.5;
  const homeWins = meetings.filter(g =>
    (g.homeTeam === homeTeam && g.homeScore > g.awayScore) || (g.awayTeam === homeTeam && g.awayScore > g.homeScore)
  ).length;
  return homeWins / meetings.length;
}

// ─── MONEYLINE (matches the formula that will ship in probabilityModel.ts) ─

function eloStrengthRatio(homeWinRate: number, awayWinRate: number, h2hHWR: number): number {
  const homeStrength = homeWinRate * 0.6 + h2hHWR * 0.4;
  const awayStrength = awayWinRate * 0.6 + (1 - h2hHWR) * 0.4;
  const total = homeStrength + awayStrength || 1;
  return homeStrength / total;
}

function predictMoneyline(homeRecords: TeamGameRecord[], awayRecords: TeamGameRecord[], h2hHWR: number): number {
  const homeWR = formWinRate(homeRecords);
  const awayWR = formWinRate(awayRecords);
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);
  const homeWinProb = eloHome * 0.85 + 0.04 + HOME_COURT_ADVANTAGE;
  return Math.max(0.05, Math.min(0.95, homeWinProb));
}

// ─── RAW PREDICTION GENERATION ─────────────────────────────────────────

function generateRawPredictionsForLeague(games: ProballersGame[]): RawPrediction[] {
  const predictions: RawPrediction[] = [];
  const seen = new Set<number>();
  const deduped = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
  const sorted = deduped.sort((a, b) => a.date.localeCompare(b.date));

  for (const game of sorted) {
    const priorGames = sorted.filter(g => g.date < game.date);
    const history = buildHistory(priorGames);

    const homeRecords = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const awayRecords = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));

    if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) continue;

    const h2hHWR = h2hHomeWinRate(priorGames, game.homeTeam, game.awayTeam);
    const homeWinProb = predictMoneyline(homeRecords, awayRecords, h2hHWR);

    const rawProb = Math.max(homeWinProb, 1 - homeWinProb);
    const predictedHome = homeWinProb >= 0.5;
    const actualHome = game.homeScore > game.awayScore;
    const hit = predictedHome === actualHome ? 1 : 0;

    predictions.push({ rawProb, hit });
  }

  return predictions;
}

// ─── ISOTONIC REGRESSION (same PAVA + reliable-range pattern as
//     nbaIsotonicFit.ts / basketballIsotonicFit.ts) ─────────────────────

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

function findReliableStart(blocks: IsotonicPoint[]): number {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return 0;
}

function findReliableCutoff(blocks: IsotonicPoint[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return blocks.length - 1;
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
    { label: '80-90%', min: 0.80, max: 0.90 },
    { label: '90%+',   min: 0.90, max: 1.01 },
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

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fitting isotonic regression for Proballers international basketball (${FIT_LEAGUES.length} leagues, pooled)...\n`);

  const allPredictions: RawPrediction[] = [];

  for (const leagueName of FIT_LEAGUES) {
    console.log(`=== ${leagueName} ===`);
    let leagueGames: ProballersGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueSchedule(leagueName, season);
        console.log(`   Season ${seasonLabel(season)}: ${games.length} games`);
        leagueGames.push(...games);
      } catch (err: any) {
        console.error(`   Season ${seasonLabel(season)} FAILED: ${err.message}`);
      }
    }

    if (leagueGames.length === 0) {
      console.log(`   No data — skipping`);
      continue;
    }

    const predictions = generateRawPredictionsForLeague(leagueGames);
    console.log(`   ${predictions.length} qualifying predictions (all confidences, no floor applied here)`);
    allPredictions.push(...predictions);
  }

  console.log(`\nTotal pooled predictions for fitting: ${allPredictions.length}`);

  if (allPredictions.length === 0) {
    console.log('No predictions generated — aborting fit.');
    return;
  }

  const blocks = fitIsotonicRegression(allPredictions);
  const startIdx = findReliableStart(blocks);
  const cutoffIdx = findReliableCutoff(blocks);
  console.log(`\nFitted isotonic regression: ${blocks.length} monotonic blocks`);
  console.log(`Reliable range: blocks ${startIdx}-${cutoffIdx} (low: x=${blocks[startIdx].x.toFixed(4)}, y=${blocks[startIdx].y.toFixed(4)}, weight=${blocks[startIdx].weight} | high: x=${blocks[cutoffIdx].x.toFixed(4)}, y=${blocks[cutoffIdx].y.toFixed(4)}, weight=${blocks[cutoffIdx].weight}) — ${startIdx} low-end + ${blocks.length - 1 - cutoffIdx} high-end noisy blocks excluded`);

  console.log('\n=== BEFORE/AFTER CALIBRATION CHECK (all confidences — production only tips >=0.75, this shows the full curve) ===');
  evaluateCalibration(allPredictions, blocks, startIdx, cutoffIdx);

  console.log('\n=== Calibration lookup table (for probabilityModel.ts) ===');
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);
  const step = Math.max(1, Math.floor(reliableBlocks.length / 35));
  for (let i = 0; i < reliableBlocks.length; i += step) {
    console.log(`  { x: ${reliableBlocks[i].x.toFixed(4)}, y: ${reliableBlocks[i].y.toFixed(4)} }, // weight: ${reliableBlocks[i].weight}`);
  }
  console.log(`  // Below x=${reliableBlocks[0].x.toFixed(4)}: floor at y=${reliableBlocks[0].y.toFixed(4)}`);
  console.log(`  // Above x=${reliableBlocks[reliableBlocks.length - 1].x.toFixed(4)}: cap at y=${reliableBlocks[reliableBlocks.length - 1].y.toFixed(4)}`);
}

main().catch(err => {
  console.error('[ProballersIsotonicFit] Fatal error:', err.message);
  process.exit(1);
});