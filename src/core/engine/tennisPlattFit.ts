// src/core/engine/tennisPlattFit.ts
//
// Fits Platt scaling (2-parameter logistic regression) to correct tennis
// model overconfidence, using pooled 2021-2024 backtest data (~1,100
// predictions) rather than any single year — reduces overfitting risk
// in the sparse 80%+ confidence band that motivated this fix.
//
// Standard Platt scaling: calibrated_p = sigmoid(A * logit(raw_p) + B),
// fit by minimizing log-loss against actual hit/miss outcomes via
// gradient descent. Run with: npx ts-node src/core/engine/tennisPlattFit.ts

import * as XLSX from 'xlsx';

const FORM_DECAY = 0.85;
const MIN_PRIOR_MATCHES = 8;
const MIN_SURFACE_MATCHES = 5;
const HISTORY_YEARS = [2018, 2019, 2020];
const POOL_TEST_YEARS = [2021, 2022, 2023, 2024]; // pooled, not single-year

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
  rawProb: number; // raw model confidence in the predicted winner (>= 0.5)
  hit: number; // 1 or 0
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

// Generates RAW predictions with NO confidence filter — we need the full
// spread (including low and mid-confidence predictions) to fit a proper
// calibration curve, not just the ones that would've qualified as tips.
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
    const predictedCorrectly = probWinnerWins >= 0.5; // model picked the actual winner

    predictions.push({ rawProb, hit: predictedCorrectly ? 1 : 0 });
  }

  return predictions;
}

// ─── PLATT SCALING FIT (gradient descent on log-loss) ──────────────────

function logit(p: number): number {
  const clamped = Math.min(Math.max(p, 1e-6), 1 - 1e-6);
  return Math.log(clamped / (1 - clamped));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function fitPlattScaling(predictions: RawPrediction[], iterations = 2000, learningRate = 0.05): { A: number; B: number } {
  let A = 1.0;
  let B = 0.0;
  const n = predictions.length;
  const x = predictions.map(p => logit(p.rawProb));
  const y = predictions.map(p => p.hit);

  for (let iter = 0; iter < iterations; iter++) {
    let gradA = 0, gradB = 0;
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(A * x[i] + B);
      const err = pred - y[i];
      gradA += err * x[i];
      gradB += err;
    }
    gradA /= n;
    gradB /= n;
    A -= learningRate * gradA;
    B -= learningRate * gradB;
  }

  return { A, B };
}

function evaluateCalibration(predictions: RawPrediction[], A: number, B: number) {
  console.log('\nBand       | Raw Avg | Calibrated Avg | Actual Hit Rate | Tips');
  console.log('------------------------------------------------------------------');
  const bands = [
    { label: '50-65%', min: 0.50, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80%+',   min: 0.80, max: 1.01 },
  ];
  for (const band of bands) {
    const items = predictions.filter(p => p.rawProb >= band.min && p.rawProb < band.max);
    if (!items.length) continue;
    const rawAvg = items.reduce((s, p) => s + p.rawProb, 0) / items.length;
    const calAvg = items.reduce((s, p) => s + sigmoid(A * logit(p.rawProb) + B), 0) / items.length;
    const hitRate = items.reduce((s, p) => s + p.hit, 0) / items.length;
    console.log(`${band.label.padEnd(10)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(calAvg * 100).toFixed(1).padStart(14)}% | ${(hitRate * 100).toFixed(1).padStart(15)}% | ${items.length}`);
  }
}

async function main() {
  console.log('Fitting Platt scaling for tennis model (pooled 2021-2024)...\n');

  const allYears = [...HISTORY_YEARS, ...POOL_TEST_YEARS];
  const allMatchesNested = await Promise.all(allYears.map(y => fetchTennisYear(y)));
  const allMatches = allMatchesNested.flat().sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`\nGenerating raw predictions across pooled test years ${POOL_TEST_YEARS.join(', ')}...`);
  const predictions = generateRawPredictions(allMatches, POOL_TEST_YEARS);
  console.log(`Total predictions for fitting: ${predictions.length}`);

  const { A, B } = fitPlattScaling(predictions);
  console.log(`\nFitted Platt scaling parameters: A = ${A.toFixed(4)}, B = ${B.toFixed(4)}`);

  console.log('\n=== BEFORE/AFTER CALIBRATION CHECK ===');
  evaluateCalibration(predictions, A, B);

  console.log('\n=== Use these values in probabilityModel.ts ===');
  console.log(`const TENNIS_PLATT_A = ${A.toFixed(6)};`);
  console.log(`const TENNIS_PLATT_B = ${B.toFixed(6)};`);
}

main().catch(err => {
  console.error('[PlattFit] Fatal error:', err.message);
  process.exit(1);
});