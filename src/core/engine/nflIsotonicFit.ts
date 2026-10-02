// src/core/engine/nflIsotonicFit.ts
//
// Fits isotonic regression to correct NFL +3.5 HANDICAP calibration
// (NOT plain moneyline — see conversation for why handicap was chosen:
// backtested 76.2% hit rate vs moneyline's 63.9%, and handicap converts
// narrow-margin randomness into wins rather than being exposed to it).
// Uses the exact same PAVA algorithm as proballersIsotonicFit.ts /
// basketballIsotonicFit.ts, applied to nflModel.ts's real
// computeTeamStrengthFactor() formula (NOT reimplemented — imported
// directly, same one-source-of-truth discipline used all night).
//
// IMPORTANT DIFFERENCE FROM nflBacktest.ts: that script only reports
// hit-rate at whatever confidence a game happened to produce — fine for
// reporting, useless for calibration fitting, which needs the FULL
// probability range (including the 50-55% band) to build an accurate
// curve. This script keeps every prediction with enough prior data,
// regardless of confidence.
//
// Run with: npx ts-node src/core/engine/nflIsotonicFit.ts

import { fetchFullSeason, NflGame } from '../../scrapers/football-nfl/nflScraper';
import {
  buildHistoryFromGames,
  computeLeagueAverages,
  computeTeamStrengthFactor,
  TeamGameRecord,
  LeagueAverages,
  MIN_PRIOR_GAMES,
  FORM_LOOKBACK,
  AMPLIFICATION_FACTOR,
} from './nflModel';

const MIN_RELIABLE_WEIGHT = 20; // same threshold proven on tennis/WNBA/Proballers fits
const SEASONS: { year: number; seasonType: 1 | 2 | 3 }[] = [
  { year: 2024, seasonType: 2 },
  { year: 2025, seasonType: 2 },
];

// ─── TYPES ──────────────────────────────────────────────────────────────

interface RawPrediction {
  rawProb: number; // favorite-side probability
  hit: number;
}

// ─── GENERATE RAW PREDICTIONS (NO confidence filter — full range kept) ───
//
// Mirrors nflBacktest.ts's chronological no-lookahead walk exactly, but
// records EVERY prediction with enough prior data, not just ones that
// would clear a live confidence threshold.

function generateRawPredictions(
  allGames: NflGame[],
  fullHistory: Map<string, TeamGameRecord[]>,
  leagueAvg: LeagueAverages,
): RawPrediction[] {
  const predictions: RawPrediction[] = [];
  const completed = allGames.filter(g => g.completed).sort((a, b) => a.date.localeCompare(b.date));

  for (const game of completed) {
    const priorOnlyHistory = new Map<string, TeamGameRecord[]>();
    for (const [team, records] of fullHistory) {
      priorOnlyHistory.set(team, records.filter(r => r.date < game.date));
    }

    const homeRecords = (priorOnlyHistory.get(game.homeTeam) ?? []).slice(-FORM_LOOKBACK);
    const awayRecords = (priorOnlyHistory.get(game.awayTeam) ?? []).slice(-FORM_LOOKBACK);

    if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) continue;

    const homeStrength = computeTeamStrengthFactor(homeRecords, leagueAvg);
    const awayStrength = computeTeamStrengthFactor(awayRecords, leagueAvg);
    const total = homeStrength + awayStrength || 1;
    const strengthRatio = homeStrength / total;

    const deviation = strengthRatio - 0.5;
    let homeWinProb = 0.5 + deviation * AMPLIFICATION_FACTOR;
    homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb));

    const rawProb = Math.max(homeWinProb, 1 - homeWinProb);
    const predictedHome = homeWinProb >= 0.5;

    // FIXED: fitting target changed from pure moneyline win/loss to
    // +3.5 handicap cover — matches the actual decision to serve
    // handicap picks (see conversation), not plain moneyline. The
    // picked side "hits" if it wins outright OR loses by 3 or fewer,
    // same spreadHit logic as nflBacktest.ts's handicap grading.
    const homeScore = game.homeScore ?? 0;
    const awayScore = game.awayScore ?? 0;
    const pickedMargin = predictedHome ? (homeScore - awayScore) : (awayScore - homeScore);
    const hit = pickedMargin >= -3 ? 1 : 0;

    predictions.push({ rawProb, hit });
  }

  return predictions;
}

// ─── ISOTONIC REGRESSION (Pool Adjacent Violators Algorithm) ───────────
// Verbatim from proballersIsotonicFit.ts / basketballIsotonicFit.ts.

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
    { label: '50-55%', min: 0.50, max: 0.55 },
    { label: '55-60%', min: 0.55, max: 0.60 },
    { label: '60-65%', min: 0.60, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-80%', min: 0.70, max: 0.80 },
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

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Fetching NFL seasons: ${SEASONS.map(s => `${s.year}`).join(', ')}...\n`);

  const gamesNested = await Promise.all(SEASONS.map(s => fetchFullSeason(s.year, s.seasonType)));
  const allGames = gamesNested.flat().sort((a, b) => a.date.localeCompare(b.date));
  console.log(`Total games: ${allGames.length}, completed: ${allGames.filter(g => g.completed).length}`);

  console.log('\nFetching all boxscores ONCE (several minutes)...');
  const fullHistory = await buildHistoryFromGames(allGames);
  const leagueAvg = computeLeagueAverages(fullHistory);
  console.log(`\nLeague averages: yardsPerPlay=${leagueAvg.avgYardsPerPlay.toFixed(2)}, turnovers=${leagueAvg.avgTurnovers.toFixed(2)}`);

  console.log('\nGenerating raw predictions (full range, no confidence filter)...');
  const predictions = generateRawPredictions(allGames, fullHistory, leagueAvg);
  console.log(`Total predictions for fitting: ${predictions.length}`);

  const blocks = fitIsotonicRegression(predictions);
  const startIdx = findReliableStart(blocks);
  const cutoffIdx = findReliableCutoff(blocks);
  console.log(`\nFitted isotonic regression: ${blocks.length} monotonic blocks`);
  console.log(`Reliable range: blocks ${startIdx}-${cutoffIdx} (low: x=${blocks[startIdx].x.toFixed(4)}, y=${blocks[startIdx].y.toFixed(4)}, weight=${blocks[startIdx].weight} | high: x=${blocks[cutoffIdx].x.toFixed(4)}, y=${blocks[cutoffIdx].y.toFixed(4)}, weight=${blocks[cutoffIdx].weight})`);

  console.log('\n=== BEFORE/AFTER CALIBRATION CHECK (both tails capped) ===');
  evaluateCalibration(predictions, blocks, startIdx, cutoffIdx);

  console.log('\n=== Calibration lookup table (for embedding in probabilityModel.ts as NFL_HANDICAP_ISOTONIC_BLOCKS) ===');
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);
  const step = Math.max(1, Math.floor(reliableBlocks.length / 30));
  for (let i = 0; i < reliableBlocks.length; i += step) {
    console.log(`  { x: ${reliableBlocks[i].x.toFixed(4)}, y: ${reliableBlocks[i].y.toFixed(4)} }, // weight: ${reliableBlocks[i].weight}`);
  }
  console.log(`  // Any rawProb <= ${reliableBlocks[0].x.toFixed(4)} should be floored at y: ${reliableBlocks[0].y.toFixed(4)}`);
  console.log(`  // Any rawProb >= ${reliableBlocks[reliableBlocks.length - 1].x.toFixed(4)} should be capped at y: ${reliableBlocks[reliableBlocks.length - 1].y.toFixed(4)}`);
}

main().catch(err => {
  console.error('[NflIsotonicFit] Fatal error:', err.message);
  process.exit(1);
});