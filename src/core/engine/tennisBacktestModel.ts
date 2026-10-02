// src/core/engine/tennisBacktestModel.ts
//
// Tennis backtest against historical tennis-data.co.uk XLSX data.
// Run with: npx ts-node src/core/engine/tennisBacktestModel.ts
//
// Predicts match winner using recency-weighted win rate (surface-aware
// where enough same-surface history exists, falling back to overall
// form otherwise) — same structural approach as modelTennis in
// probabilityModel.ts (h2h/form blend + surface adjustment), simplified
// for backtesting purposes.
//
// Uniquely for this backtest (vs goals/corners): tennis-data.co.uk
// includes REAL bookmaker odds (Bet365, Pinnacle, Max, Avg). This lets
// us compare our model's hit rate against a genuine market benchmark —
// "how often does the bookmaker's own favorite actually win" — not just
// against raw outcomes, which is a stronger validation than the
// goals/corners backtest could do.

import * as XLSX from 'xlsx';

const MIN_TIP_CONFIDENCE = 0.65; // tennis moneyline is naturally less lopsided than football totals
const FORM_DECAY = 0.85;
const MIN_PRIOR_MATCHES = 8;
const MIN_SURFACE_MATCHES = 5; // below this, fall back to overall form instead of surface-specific
const HISTORY_YEARS = [2018, 2019, 2020];
const TEST_YEAR = 2020
;

// Config: Tennis confidence ceiling aligned with live probabilityModel.ts production guardrail.
const TENNIS_MAX_CONFIDENCE_CAP = 0.799;

// ─── TYPES ──────────────────────────────────────────────────────────────

interface TennisMatch {
  date: Date;
  winner: string;
  loser: string;
  surface: string;
  pinnacleWinnerOdds: number | null;
  pinnacleLoserOdds: number | null;
}

interface PlayerMatchRecord {
  date: Date;
  opponent: string;
  result: 'W' | 'L';
  surface: string;
}

interface BacktestResult {
  date: string;
  playerA: string;
  playerB: string;
  surface: string;
  predictedWinner: string;
  actualWinner: string;
  confidence: number;
  hit: boolean;
  bookmakerFavorite: string | null;
  bookmakerHit: boolean | null;
}

// ─── EXCEL DATE CONVERSION ───────────────────────────────────────────────
// Standard serial-to-JS-date conversion (Excel epoch is 1899-12-30, with
// a well-known leap-year quirk baked into the 25569-day offset).

function excelDateToJSDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569);
  const utcValue = utcDays * 86400;
  return new Date(utcValue * 1000);
}

// ─── DATA FETCHING ────────────────────────────────────────────────────────

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

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
        pinnacleWinnerOdds: typeof row.PSW === 'number' ? row.PSW : null,
        pinnacleLoserOdds: typeof row.PSL === 'number' ? row.PSL : null,
      });
    }

    matches.sort((a, b) => a.date.getTime() - b.date.getTime());
    console.log(`  ✓ ${year}: ${matches.length} matches fetched`);
    return matches;
  } catch (err: any) {
    console.error(`  ✗ ${year} FAILED: ${err.message}`);
    return [];
  }
}

// ─── FORM TRACKING ──────────────────────────────────────────────────────

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

// Picks surface-specific history if there's enough of it, otherwise
// falls back to all recent matches regardless of surface — same
// insufficient-data fallback pattern used throughout football
// scrapers/aggregators.
function getRelevantForm(
  allHistory: PlayerMatchRecord[],
  surface: string,
): { form: PlayerMatchRecord[]; usedSurfaceSpecific: boolean } {
  const sorted = [...allHistory].sort((a, b) => b.date.getTime() - a.date.getTime());
  const surfaceMatches = sorted.filter(r => r.surface === surface);

  if (surfaceMatches.length >= MIN_SURFACE_MATCHES) {
    return { form: surfaceMatches, usedSurfaceSpecific: true };
  }
  return { form: sorted, usedSurfaceSpecific: false };
}

// ─── BACKTEST LOOP ──────────────────────────────────────────────────────

function runTennisBacktest(allMatches: TennisMatch[], testYear: number): BacktestResult[] {
  const results: BacktestResult[] = [];
  const testMatches = allMatches.filter(m => m.date.getFullYear() === testYear);

  for (const match of testMatches) {
    const priorMatches = allMatches.filter(m => m.date.getTime() < match.date.getTime());
    const historyMap = buildPlayerHistoryMap(priorMatches);

    const winnerHistory = historyMap.get(match.winner) ?? [];
    const loserHistory = historyMap.get(match.loser) ?? [];

    if (winnerHistory.length < MIN_PRIOR_MATCHES || loserHistory.length < MIN_PRIOR_MATCHES) continue;

    const { form: winnerForm } = getRelevantForm(winnerHistory, match.surface);
    const { form: loserForm } = getRelevantForm(loserHistory, match.surface);

    const winnerStrength = weightedWinRate(winnerForm);
    const loserStrength = weightedWinRate(loserForm);

    const total = winnerStrength + loserStrength || 1;
    let probWinnerWins = winnerStrength / total;

    // Apply the production upper confidence ceiling guardrail
    probWinnerWins = Math.max(1 - TENNIS_MAX_CONFIDENCE_CAP, Math.min(TENNIS_MAX_CONFIDENCE_CAP, probWinnerWins));

    const predictedWinner = probWinnerWins >= 0.5 ? match.winner : match.loser;
    const confidence = Math.max(probWinnerWins, 1 - probWinnerWins);

    if (confidence < MIN_TIP_CONFIDENCE) continue;

    // Bookmaker favorite benchmark (Pinnacle — sharpest book in the dataset)
    let bookmakerFavorite: string | null = null;
    let bookmakerHit: boolean | null = null;
    if (match.pinnacleWinnerOdds !== null && match.pinnacleLoserOdds !== null) {
      bookmakerFavorite = match.pinnacleWinnerOdds < match.pinnacleLoserOdds ? match.winner : match.loser;
      bookmakerHit = bookmakerFavorite === match.winner; // always true if winner had lower odds — kept explicit for clarity/extension
    }

    results.push({
      date: match.date.toISOString().split('T')[0],
      playerA: match.winner,
      playerB: match.loser,
      surface: match.surface,
      predictedWinner,
      actualWinner: match.winner,
      confidence,
      hit: predictedWinner === match.winner,
      bookmakerFavorite,
      bookmakerHit,
    });
  }

  return results;
}

// ─── REPORTING ──────────────────────────────────────────────────────────

function printOverallSummary(results: BacktestResult[]) {
  const hits = results.filter(r => r.hit).length;
  const hitRate = results.length ? (hits / results.length) * 100 : 0;
  const avgConf = results.length ? (results.reduce((s, r) => s + r.confidence, 0) / results.length) * 100 : 0;

  const withBookmaker = results.filter(r => r.bookmakerFavorite !== null);
  const bookmakerHits = withBookmaker.filter(r => r.bookmakerHit).length;
  const bookmakerHitRate = withBookmaker.length ? (bookmakerHits / withBookmaker.length) * 100 : 0;

  console.log('\n======================================================');
  console.log('             TENNIS MODEL — OVERALL SUMMARY           ');
  console.log('======================================================');
  console.log(`Our model:        ${results.length} tips | Hits: ${hits} | Hit Rate: ${hitRate.toFixed(1)}% | Avg Conf: ${avgConf.toFixed(1)}%`);
  console.log(`Bookmaker (Pinnacle favorite): ${withBookmaker.length} matches with odds | Favorite win rate: ${bookmakerHitRate.toFixed(1)}%`);
  console.log(`\nNote: bookmaker favorite hit rate is a market benchmark, not something we're beating/losing to directly —`);
  console.log(`it shows how often the "obvious" pick wins, so our model's hit rate can be judged in context.`);
}

function printSurfaceBreakdown(results: BacktestResult[]) {
  console.log('\n======================================================');
  console.log('               BREAKDOWN BY SURFACE                   ');
  console.log('======================================================');

  const surfaces = [...new Set(results.map(r => r.surface))];
  console.log('Surface     | Tips   | Hits   | Hit Rate | Avg Conf');
  console.log('------------------------------------------------------');
  for (const surface of surfaces) {
    const items = results.filter(r => r.surface === surface);
    const hits = items.filter(r => r.hit).length;
    const hitRate = items.length ? (hits / items.length) * 100 : 0;
    const avgConf = items.length ? (items.reduce((s, r) => s + r.confidence, 0) / items.length) * 100 : 0;
    console.log(`${surface.padEnd(11)} | ${items.length.toString().padStart(4)} | ${hits.toString().padStart(4)} | ${hitRate.toFixed(1).padStart(6)}% | ${avgConf.toFixed(1)}%`);
  }
}

function printConfidenceBandBreakdown(results: BacktestResult[]) {
  console.log('\n======================================================');
  console.log('         CALIBRATION CHECK — BY CONFIDENCE BAND       ');
  console.log('======================================================');

  const bands = [
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80%+',   min: 0.80, max: 1.01 },
  ];

  console.log('Band     | Tips   | Hits   | Hit Rate | Avg Conf | Gap');
  console.log('------------------------------------------------------------------');
  for (const band of bands) {
    const items = results.filter(r => r.confidence >= band.min && r.confidence < band.max);
    const hits = items.filter(r => r.hit).length;
    const hitRate = items.length ? (hits / items.length) * 100 : 0;
    const avgConf = items.length ? (items.reduce((s, r) => s + r.confidence, 0) / items.length) * 100 : 0;
    const gap = avgConf - hitRate;
    console.log(`${band.label.padEnd(8)} | ${items.length.toString().padStart(4)} | ${hits.toString().padStart(4)} | ${hitRate.toFixed(1).padStart(6)}% | ${avgConf.toFixed(1).padStart(6)}% | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pt`);
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  console.log('Starting tennis backtest (ATP, tennis-data.co.uk)...');
  console.log(`History years: ${HISTORY_YEARS.join(', ')} | Test year: ${TEST_YEAR}\n`);

  const allYears = [...HISTORY_YEARS, TEST_YEAR];
  const allMatchesNested = await Promise.all(allYears.map(y => fetchTennisYear(y)));
  const allMatches = allMatchesNested.flat().sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`\nTotal matches loaded: ${allMatches.length}`);
  console.log('Running backtest...\n');

  const results = runTennisBacktest(allMatches, TEST_YEAR);

  printOverallSummary(results);
  printSurfaceBreakdown(results);
  printConfidenceBandBreakdown(results);

  console.log('\n=== Tennis Backtest Complete ===');
}

main().catch(err => {
  console.error('[TennisBacktest] Fatal error:', err.message);
  process.exit(1);
});