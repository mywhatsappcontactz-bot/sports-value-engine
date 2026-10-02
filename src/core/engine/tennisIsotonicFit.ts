// src/core/engine/tennisIsotonicFit.ts
//
// Fits isotonic regression to correct tennis model overconfidence, using
// the same pooled 2021-2024 data (9,310 predictions) as tennisPlattFit.ts.
//
// Run with: npx ts-node src/core/engine/tennisIsotonicFit.ts

import * as XLSX from 'xlsx';

const FORM_DECAY = 0.85;
const MIN_PRIOR_MATCHES = 8;
const MIN_SURFACE_MATCHES = 5;
const HISTORY_YEARS = [2018, 2019, 2020];
const POOL_TEST_YEARS = [2021, 2022, 2023, 2024];
const MIN_RELIABLE_WEIGHT = 20; // blocks with fewer pooled samples than this are treated as noise

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

interface TennisMatch {
  date: Date;
  winner: string;
  loser: string;
  surface: string;
}

interface PlayerMatchRecord {
  date: Date;
  opponent: string;
  result: 'W' | 'L';
  surface: string;
}

interface RawPrediction {
  rawProb: number;
  hit: number;
}

function excelDateToJSDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  return new Date(utcDays * 86400 * 1000);
}

async function fetchTennisYear(year: number): Promise<TennisMatch[]> {
  const url = `http://tennis-data.co.uk/${year}/${year}.xlsx`;
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows: any[] = XLSX.utils.sheet_to_json(sheet);

    const matches: TennisMatch[] = [];
    for (const row of rows) {
      if (!row.Winner || !row.Loser || typeof row.Date !== 'number') continue;
      matches.push({
        date: excelDateToJSDate(row.Date),
        winner: String(row.Winner).trim(),
        loser: String(row.Loser).trim(),
        surface: row.Surface ? String(row.Surface).trim() : 'Unknown',
      });
    }
    matches.sort((a, b) => a.date.getTime() - b.date.getTime());
    console.log(`  ✓ ${year}: ${matches.length} matches`);
    return matches;
  } catch (err: any) {
    console.error(`  ✗ ${year} FAILED: ${err.message}`);
    return [];
  }
}

function buildPlayerHistoryMap(matches: TennisMatch[]): Map<string, PlayerMatchRecord[]> {
  const map = new Map<string, PlayerMatchRecord[]>();
  function push(player: string, rec: PlayerMatchRecord) {
    if (!map.has(player)) map.set(player, []);
    map.get(player)!.push(rec);
  }
  for (const m of matches) {
    push(m.winner, { date: m.date, opponent: m.loser, result: 'W', surface: m.surface });
    push(m.loser, { date: m.date, opponent: m.winner, result: 'L', surface: m.surface });
  }
  return map;
}

function weightedWinRate(records: PlayerMatchRecord[]): number {
  if (!records.length) return 0.5;
  let weightSum = 0, winSum = 0;
  records.forEach((r, i) => {
    const w = Math.pow(FORM_DECAY, i);
    if (r.result === 'W') winSum += w;
    weightSum += w;
  });
  return winSum / weightSum;
}

function getRelevantForm(allHistory: PlayerMatchRecord[], surface: string): PlayerMatchRecord[] {
  const sorted = [...allHistory].sort((a, b) => b.date.getTime() - a.date.getTime());
  const surfaceMatches = sorted.filter(r => r.surface === surface);
  return surfaceMatches.length >= MIN_SURFACE_MATCHES ? surfaceMatches : sorted;
}

function generateRawPredictions(allMatches: TennisMatch[], testYears: number[]): RawPrediction[] {
  const predictions: RawPrediction[] = [];
  const testMatches = allMatches.filter(m => testYears.includes(m.date.getFullYear()));

  for (const match of testMatches) {
    const priorMatches = allMatches.filter(m => m.date.getTime() < match.date.getTime());
    const historyMap = buildPlayerHistoryMap(priorMatches);

    const winnerHistory = historyMap.get(match.winner) ?? [];
    const loserHistory = historyMap.get(match.loser) ?? [];
    if (winnerHistory.length < MIN_PRIOR_MATCHES || loserHistory.length < MIN_PRIOR_MATCHES) continue;

    const winnerForm = getRelevantForm(winnerHistory, match.surface);
    const loserForm = getRelevantForm(loserHistory, match.surface);

    const winnerStrength = weightedWinRate(winnerForm);
    const loserStrength = weightedWinRate(loserForm);
    const total = winnerStrength + loserStrength || 1;
    const probWinnerWins = winnerStrength / total;

    const rawProb = Math.max(probWinnerWins, 1 - probWinnerWins);
    const predictedCorrectly = probWinnerWins >= 0.5;

    predictions.push({ rawProb, hit: predictedCorrectly ? 1 : 0 });
  }

  return predictions;
}

// ─── ISOTONIC REGRESSION (Pool Adjacent Violators Algorithm) ───────────

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

// NEW: find the last block (by x) that has enough pooled samples to trust.
// Any block after this in the tail is noise (e.g. single-match blocks
// pinned at y: 1.0) and gets excluded from prediction — capped instead
// at the last reliable block's value.
function findReliableCutoff(blocks: IsotonicPoint[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return blocks.length - 1; // fallback: no trimming possible
}

function isotonicPredict(blocks: IsotonicPoint[], rawProb: number, cutoffIdx: number): number {
  const reliableBlocks = blocks.slice(0, cutoffIdx + 1);

  if (rawProb <= reliableBlocks[0].x) return reliableBlocks[0].y;
  if (rawProb >= reliableBlocks[reliableBlocks.length - 1].x) {
    return reliableBlocks[reliableBlocks.length - 1].y; // capped, no more interpolating into noise
  }

  for (let i = 0; i < reliableBlocks.length - 1; i++) {
    if (rawProb >= reliableBlocks[i].x && rawProb <= reliableBlocks[i + 1].x) {
      const t = (rawProb - reliableBlocks[i].x) / (reliableBlocks[i + 1].x - reliableBlocks[i].x || 1);
      return reliableBlocks[i].y + t * (reliableBlocks[i + 1].y - reliableBlocks[i].y);
    }
  }
  return rawProb;
}

function evaluateCalibration(predictions: RawPrediction[], blocks: IsotonicPoint[], cutoffIdx: number) {
  console.log('\nBand       | Raw Avg | Calibrated Avg | Actual Hit Rate | Tips');
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
    const calAvg = items.reduce((s, p) => s + isotonicPredict(blocks, p.rawProb, cutoffIdx), 0) / items.length;
    const hitRate = items.reduce((s, p) => s + p.hit, 0) / items.length;
    console.log(`${band.label.padEnd(10)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(calAvg * 100).toFixed(1).padStart(14)}% | ${(hitRate * 100).toFixed(1).padStart(15)}% | ${items.length}`);
  }
}

async function main() {
  console.log('Fitting isotonic regression for tennis model (pooled 2021-2024)...\n');

  const allYears = [...HISTORY_YEARS, ...POOL_TEST_YEARS];
  const allMatchesNested = await Promise.all(allYears.map(y => fetchTennisYear(y)));
  const allMatches = allMatchesNested.flat().sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`\nGenerating raw predictions across pooled test years ${POOL_TEST_YEARS.join(', ')}...`);
  const predictions = generateRawPredictions(allMatches, POOL_TEST_YEARS);
  console.log(`Total predictions for fitting: ${predictions.length}`);

  const blocks = fitIsotonicRegression(predictions);
  const cutoffIdx = findReliableCutoff(blocks);
  console.log(`\nFitted isotonic regression: ${blocks.length} monotonic blocks`);
  console.log(`Reliable cutoff: block ${cutoffIdx} (x: ${blocks[cutoffIdx].x.toFixed(4)}, y: ${blocks[cutoffIdx].y.toFixed(4)}, weight: ${blocks[cutoffIdx].weight}) — ${blocks.length - 1 - cutoffIdx} trailing noisy blocks excluded from prediction`);

  console.log('\n=== BEFORE/AFTER CALIBRATION CHECK (tail capped) ===');
  evaluateCalibration(predictions, blocks, cutoffIdx);

  console.log('\n=== Calibration lookup table (for embedding in probabilityModel.ts) ===');
  const reliableBlocks = blocks.slice(0, cutoffIdx + 1);
  const step = Math.max(1, Math.floor(reliableBlocks.length / 30));
  for (let i = 0; i < reliableBlocks.length; i += step) {
    console.log(`  { x: ${reliableBlocks[i].x.toFixed(4)}, y: ${reliableBlocks[i].y.toFixed(4)} }, // weight: ${reliableBlocks[i].weight}`);
  }
  console.log(`  // Any rawProb >= ${reliableBlocks[reliableBlocks.length - 1].x.toFixed(4)} should be capped at y: ${reliableBlocks[reliableBlocks.length - 1].y.toFixed(4)} in probabilityModel.ts`);
}

main().catch(err => {
  console.error('[IsotonicFit] Fatal error:', err.message);
  process.exit(1);
});