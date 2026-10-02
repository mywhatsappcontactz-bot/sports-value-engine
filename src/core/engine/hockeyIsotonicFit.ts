// src/core/engine/hockeyIsotonicFit.ts
//
// Fits isotonic regression to correct the moneyline overconfidence
// CONFIRMED via hockeyCalibrationCheck.ts (2026-09-05, 35,386 real
// predictions across all 14 leagues): well-calibrated at 50-60%
// confidence, but overstates itself by 4-9 percentage points in the
// 60-80% range specifically — exactly where MIN_TIP_CONFIDENCE=0.75
// lives, which is why the small real-odds ROI samples were all negative.
//
// Same architecture as proballersIsotonicFit.ts / nbaIsotonicFit.ts:
// PAVA isotonic regression with a reliable low/high weight cutoff to
// exclude noisy blocks.
//
// UNLIKE proballersIsotonicFit.ts: reuses buildHistory/h2hHomeWinRate/
// predictMoneyline DIRECTLY from hockeyBacktest1.ts (already exported)
// instead of re-deriving the formula a third time — guarantees this fit
// calibrates the EXACT formula that produced the calibration-check
// results, not a copy that could silently drift from it.
//
// FIT POPULATION: all 14 confirmed leagues, pooled, NO exclusions —
// unlike Proballers' fit (which excludes leagues confirmed broken or
// below a hit-rate bar). The miscalibration here is a property of the
// prediction FORMULA itself, confirmed to show up consistently across
// leagues in the calibration check — not a data-quality issue specific
// to any subset of leagues, so fitting against the same full population
// that revealed the problem is the honest match.
//
// Run with: npx ts-node src/core/engine/hockeyIsotonicFit.ts

import {
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';
import {
  buildHistory,
  h2hHomeWinRate,
  predictMoneyline,
  MIN_PRIOR_GAMES,
} from './hockeyBacktest1';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_RELIABLE_WEIGHT = 30;
const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];
const FIT_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);

// ─── TYPES ──────────────────────────────────────────────────────────────

interface RawPrediction {
  rawProb: number; // favorite-side confidence
  hit: number;
}

// ─── RAW PREDICTION GENERATION ─────────────────────────────────────────

function generateRawPredictionsForLeague(games: EPGame[]): RawPrediction[] {
  const predictions: RawPrediction[] = [];
  const seen = new Set<number>();
  const deduped = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
  const completedOnly = deduped.filter(g => g.isCompleted);
  const sorted = completedOnly.sort((a, b) => a.date.localeCompare(b.date));

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
    const actualHome = game.homeScore! > game.awayScore!;
    const hit = predictedHome === actualHome ? 1 : 0;

    predictions.push({ rawProb, hit });
  }

  return predictions;
}

// ─── ISOTONIC REGRESSION (same PAVA + reliable-range pattern as
//     proballersIsotonicFit.ts / nbaIsotonicFit.ts) ─────────────────────

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
    { label: '50-60%', min: 0.50, max: 0.60 },
    { label: '60-65%', min: 0.60, max: 0.65 },
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
  console.log(`Fitting isotonic regression for hockey (${FIT_LEAGUES.length} leagues, pooled, no exclusions)...\n`);

  const allPredictions: RawPrediction[] = [];

  for (const leagueName of FIT_LEAGUES) {
    console.log(`=== ${leagueName} ===`);
    let leagueGames: EPGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        console.log(`   Season ${season}: ${games.length} games`);
        leagueGames.push(...games);
      } catch (err: any) {
        console.error(`   Season ${season} FAILED: ${err.message}`);
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
  console.error('[HockeyIsotonicFit] Fatal error:', err.message);
  process.exit(1);
});