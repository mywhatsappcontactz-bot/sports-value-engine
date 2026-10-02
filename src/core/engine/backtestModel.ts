// src/core/engine/backtestModel.ts
//
// Goals & Corners backtest against historical online CSV data.
// Run with: npx ts-node src/core/engine/backtestModel.ts
//
// Goals: Poisson vs Dixon-Coles compared — DC showed negligible difference
// at 1.5/3.5 lines (0.0 to -0.2pt hit rate change), confirmed NOT worth
// enabling in production. Kept here for reference/re-verification only.
//
// Corners: Poisson vs Negative Binomial compared. Corners showed a
// climbing overconfidence gap with line height (7.5: +5.1pt, 8.5: +10.5pt,
// 9.5: +18.3pt, 10.5: +11.1pt) — the textbook signature of overdispersion,
// unlike goals' isolated mid-line dip. NB directly models this via a
// dispersion parameter (k), estimated empirically from the actual
// variance/mean ratio of corner totals in the historical data, not
// guessed. CONFIRMED across 3 season pairs: NB reduces the overconfidence
// gap by ~1pt at every line, consistently — now live in production
// (see probabilityModel.ts, USE_NB_FOR_CORNERS).

const MIN_TIP_CONFIDENCE = 0.70;
const TARGET_GOAL_LINES = [1.5, 2.5, 3.5];
const TARGET_CORNER_LINES = [7.5, 8.5, 9.5, 10.5];
const HOME_BOOST = 1.08;
const FORM_DECAY = 0.85;
const MIN_PRIOR_MATCHES = 5;
const MAIN_SEASONS: [string, string] = ['2021', '2122'];
const DIXON_COLES_RHO = -0.1;

// ─── LEAGUE CONFIG ────────────────────────────────────────────────────────

interface LeagueConfig {
  name: string;
  type: 'main' | 'extra';
  code: string;
}

const LEAGUES: LeagueConfig[] = [
  { name: 'EPL',                        type: 'main',  code: 'E0' },
  { name: 'Championship',               type: 'main',  code: 'E1' },
  { name: 'League 1',                   type: 'main',  code: 'E2' },
  { name: 'League 2',                   type: 'main',  code: 'E3' },
  { name: 'La Liga - Spain',            type: 'main',  code: 'SP1' },
  { name: 'La Liga 2 - Spain',          type: 'main',  code: 'SP2' },
  { name: 'Ligue 1 - France',           type: 'main',  code: 'F1' },
  { name: 'Bundesliga - Germany',       type: 'main',  code: 'D1' },
  { name: 'Dutch Eredivisie',           type: 'main',  code: 'N1' },
  { name: 'Serie A - Italy',            type: 'main',  code: 'I1' },
  { name: 'Premiership - Scotland',     type: 'main',  code: 'SC0' },
  { name: 'Allsvenskan - Sweden',       type: 'extra', code: 'SWE' },
  { name: 'Eliteserien - Norway',       type: 'extra', code: 'NOR' },
  { name: 'Denmark Superliga',          type: 'extra', code: 'DNK' },
  { name: 'Austrian Football Bundesliga',type: 'extra', code: 'AUT' },
  { name: 'Swiss Superleague',          type: 'extra', code: 'SWZ' },
  { name: 'Super League - China',       type: 'extra', code: 'CHN' },
  { name: 'Veikkausliiga - Finland',    type: 'extra', code: 'FIN' },
  { name: 'League of Ireland',          type: 'extra', code: 'IRL' },
  { name: 'Brazil Série A',             type: 'extra', code: 'BRA' },
];

// ─── TYPES ──────────────────────────────────────────────────────────────

interface HistMatch {
  date: Date;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  awayGoals: number;
  homeCorners: number;
  awayCorners: number;
}

interface TeamMatchRecord {
  date: Date;
  opponent: string;
  goalsFor: number;
  goalsAgainst: number;
  cornersFor: number;
  cornersAgainst: number;
  venue: 'home' | 'away';
}

interface BacktestResult {
  league: string;
  variant: 'A' | 'B';
  method: 'poisson' | 'dixon-coles' | 'negative-binomial';
  date: string;
  homeTeam: string;
  awayTeam: string;
  marketType: 'goals' | 'corners';
  targetLine: number;
  predictedSelection: string;
  predictedProbability: number;
  actualTotal: number;
  hit: boolean;
}

// ─── CSV HELPERS ────────────────────────────────────────────────────────

async function fetchCsv(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ',' && !inQuotes) { fields.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields;
}

function parseDate(raw: string): Date | null {
  const parts = raw.split('/');
  if (parts.length !== 3) return null;
  let [d, m, y] = parts.map(p => parseInt(p, 10));
  if (y < 100) y += y < 50 ? 2000 : 1900;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return isNaN(dt.getTime()) ? null : dt;
}

function findColumn(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const i = headers.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

interface ParsedCsv {
  headers: string[];
  rows: string[][];
  dateIdx: number;
  homeIdx: number;
  awayIdx: number;
  fthgIdx: number;
  ftagIdx: number;
  hcIdx: number;
  acIdx: number;
  seasonIdx: number;
}

function parseCsv(csvText: string): ParsedCsv {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
  const headers = lines.length ? parseCsvLine(lines[0]).map(h => h.trim()) : [];

  const dateIdx = findColumn(headers, ['Date']);
  const homeIdx = findColumn(headers, ['HomeTeam', 'Home']);
  const awayIdx = findColumn(headers, ['AwayTeam', 'Away']);
  const fthgIdx = findColumn(headers, ['FTHG', 'HG']);
  const ftagIdx = findColumn(headers, ['FTAG', 'AG']);
  const hcIdx = findColumn(headers, ['HC']);
  const acIdx = findColumn(headers, ['AC']);
  const seasonIdx = findColumn(headers, ['Season']);

  if ([dateIdx, homeIdx, awayIdx, fthgIdx, ftagIdx].some(i => i === -1)) {
    throw new Error(`[Backtest] Expected basic columns not found. Headers seen: ${headers.join(', ')}`);
  }

  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) {
    const row = parseCsvLine(lines[i]);
    if (row.length <= Math.max(dateIdx, homeIdx, awayIdx, fthgIdx, ftagIdx)) continue;
    rows.push(row);
  }

  return { headers, rows, dateIdx, homeIdx, awayIdx, fthgIdx, ftagIdx, hcIdx, acIdx, seasonIdx };
}

function rowsToMatches(parsed: ParsedCsv, rows: string[][]): HistMatch[] {
  const matches: HistMatch[] = [];
  for (const row of rows) {
    const date = parseDate(row[parsed.dateIdx]);
    const homeGoals = parseInt(row[parsed.fthgIdx], 10);
    const awayGoals = parseInt(row[parsed.ftagIdx], 10);
    const homeCorners = parsed.hcIdx !== -1 ? parseInt(row[parsed.hcIdx], 10) : 0;
    const awayCorners = parsed.acIdx !== -1 ? parseInt(row[parsed.acIdx], 10) : 0;

    if (!date || isNaN(homeGoals) || isNaN(awayGoals)) continue;

    matches.push({
      date,
      homeTeam: row[parsed.homeIdx].trim(),
      awayTeam: row[parsed.awayIdx].trim(),
      homeGoals,
      awayGoals,
      homeCorners: isNaN(homeCorners) ? 0 : homeCorners,
      awayCorners: isNaN(awayCorners) ? 0 : awayCorners
    });
  }
  matches.sort((a, b) => a.date.getTime() - b.date.getTime());
  return matches;
}

function getDistinctSeasons(parsed: ParsedCsv): string[] {
  if (parsed.seasonIdx === -1) return [];
  const set = new Set<string>();
  for (const row of parsed.rows) {
    const v = row[parsed.seasonIdx]?.trim();
    if (v) set.add(v);
  }
  return [...set].sort();
}

function matchesForSeason(parsed: ParsedCsv, seasonValue: string): HistMatch[] {
  const rows = parsed.rows.filter(r => r[parsed.seasonIdx]?.trim() === seasonValue);
  return rowsToMatches(parsed, rows);
}

// ─── FORM TRACKING ──────────────────────────────────────────────────────

function buildTeamHistoryMap(matches: HistMatch[]): Map<string, TeamMatchRecord[]> {
  const map = new Map<string, TeamMatchRecord[]>();
  function push(team: string, rec: TeamMatchRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }
  for (const m of matches) {
    push(m.homeTeam, {
      date: m.date,
      opponent: m.awayTeam,
      goalsFor: m.homeGoals,
      goalsAgainst: m.awayGoals,
      cornersFor: m.homeCorners,
      cornersAgainst: m.awayCorners,
      venue: 'home'
    });
    push(m.awayTeam, {
      date: m.date,
      opponent: m.homeTeam,
      goalsFor: m.awayGoals,
      goalsAgainst: m.homeGoals,
      cornersFor: m.awayCorners,
      cornersAgainst: m.homeCorners,
      venue: 'away'
    });
  }
  return map;
}

function weightedAvg(records: TeamMatchRecord[], key: keyof TeamMatchRecord, defaultVal: number): number {
  if (!records.length) return defaultVal;
  let weightSum = 0, valueSum = 0;
  records.forEach((r, i) => {
    const w = Math.pow(FORM_DECAY, i);
    const val = typeof r[key] === 'number' ? (r[key] as number) : defaultVal;
    valueSum += val * w;
    weightSum += w;
  });
  return valueSum / weightSum;
}

// ─── POISSON ENGINE ────────────────────────────────────────────────

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function totalOverProbability(lambdaHome: number, lambdaAway: number, line: number, maxVal = 20): number {
  let overProb = 0;
  for (let i = 0; i <= maxVal; i++) {
    for (let j = 0; j <= maxVal; j++) {
      if (i + j > line) overProb += poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
    }
  }
  return overProb;
}

// ─── DIXON-COLES ────────────────────────────────────────────────────────
// tau correction for the four low-score cells. Cross-lambda dependency
// confirmed correct against the Dixon & Coles (1997) formulation.
// CONFIRMED NOT WORTH ENABLING for goals 1.5/3.5 lines — negligible
// difference vs plain Poisson. Kept here for reference only.

function dixonColesTau(x: number, y: number, lambdaHome: number, lambdaAway: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lambdaHome * lambdaAway * rho;
  if (x === 1 && y === 0) return 1 + lambdaAway * rho;
  if (x === 0 && y === 1) return 1 + lambdaHome * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

function totalOverProbabilityDixonColes(
  lambdaHome: number,
  lambdaAway: number,
  line: number,
  maxVal = 8,
  rho: number = DIXON_COLES_RHO,
): number {
  let overProb = 0;
  let total = 0;

  for (let i = 0; i <= maxVal; i++) {
    for (let j = 0; j <= maxVal; j++) {
      const base = poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
      const tau = dixonColesTau(i, j, lambdaHome, lambdaAway, rho);
      const p = base * tau;
      total += p;
      if (i + j > line) overProb += p;
    }
  }

  return total > 0 ? overProb / total : overProb;
}

// ─── NEGATIVE BINOMIAL (corners) ───────────────────────────────────────
// Standard mean/dispersion parameterization: mean = lambda, variance =
// lambda + lambda^2/k. As k -> infinity, NB converges to Poisson — so a
// large fitted k here would itself be evidence NB isn't needed. k is
// estimated empirically below from the actual variance/mean ratio of
// corner totals across all collected historical matches, not guessed.
//
// PMF requires the gamma function (k is not necessarily an integer),
// computed via log-gamma for numerical stability at larger counts.

function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  if (x < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function negativeBinomialPmf(mean: number, k: number, x: number): number {
  if (mean <= 0) return x === 0 ? 1 : 0;
  if (k <= 0 || !isFinite(k)) return poissonPmf(mean, x);

  const logCoeff = logGamma(x + k) - logGamma(k) - logGamma(x + 1);
  const logProb = logCoeff + k * Math.log(k / (k + mean)) + x * Math.log(mean / (k + mean));
  return Math.exp(logProb);
}

function totalOverProbabilityNB(
  meanHome: number,
  meanAway: number,
  line: number,
  k: number,
  maxVal = 20,
): number {
  let overProb = 0;
  for (let i = 0; i <= maxVal; i++) {
    for (let j = 0; j <= maxVal; j++) {
      if (i + j > line) {
        overProb += negativeBinomialPmf(meanHome, k, i) * negativeBinomialPmf(meanAway, k, j);
      }
    }
  }
  return overProb;
}

function estimateDispersionK(cornerTotals: number[]): number {
  if (cornerTotals.length < 30) return Infinity;

  const mean = cornerTotals.reduce((s, v) => s + v, 0) / cornerTotals.length;
  const variance = cornerTotals.reduce((s, v) => s + (v - mean) ** 2, 0) / cornerTotals.length;

  if (variance <= mean) return Infinity;

  return (mean * mean) / (variance - mean);
}

function computeLambdas(homeVenueForm: TeamMatchRecord[], awayVenueForm: TeamMatchRecord[]) {
  const homeGoalAtt = weightedAvg(homeVenueForm, 'goalsFor', 1.35);
  const awayGoalDef = weightedAvg(awayVenueForm, 'goalsAgainst', 1.35);
  const awayGoalAtt = weightedAvg(awayVenueForm, 'goalsFor', 1.10);
  const homeGoalDef = weightedAvg(homeVenueForm, 'goalsAgainst', 1.10);

  let lambdaHomeGoals = ((homeGoalAtt + awayGoalDef) / 2) * HOME_BOOST;
  let lambdaAwayGoals = (awayGoalAtt + homeGoalDef) / 2;

  const homeCornAtt = weightedAvg(homeVenueForm, 'cornersFor', 5.5);
  const awayCornDef = weightedAvg(awayVenueForm, 'cornersAgainst', 5.5);
  const awayCornAtt = weightedAvg(awayVenueForm, 'cornersFor', 4.5);
  const homeCornDef = weightedAvg(homeVenueForm, 'cornersAgainst', 4.5);

  let lambdaHomeCorners = ((homeCornAtt + awayCornDef) / 2) * HOME_BOOST;
  let lambdaAwayCorners = (awayCornAtt + homeCornDef) / 2;

  return {
    lambdaHomeGoals: Math.min(lambdaHomeGoals, 3.5),
    lambdaAwayGoals: Math.min(lambdaAwayGoals, 3.5),
    lambdaHomeCorners: Math.min(lambdaHomeCorners, 10.0),
    lambdaAwayCorners: Math.min(lambdaAwayCorners, 10.0)
  };
}

// ─── PASS 1: COLLECT CORNER TOTALS FOR DISPERSION ESTIMATION ──────────

function collectCornerTotals(allLeagueMatches: HistMatch[][]): number[] {
  const totals: number[] = [];
  for (const matches of allLeagueMatches) {
    for (const m of matches) {
      if (m.homeCorners > 0 || m.awayCorners > 0) {
        totals.push(m.homeCorners + m.awayCorners);
      }
    }
  }
  return totals;
}

// ─── BACKTEST LOOP ──────────────────────────────────────────────────────

function runBacktest(
  league: string,
  seasonMatches: HistMatch[],
  priorSeasonMatches: HistMatch[],
  variantLabel: 'A' | 'B',
  dispersionK: number,
): BacktestResult[] {
  const results: BacktestResult[] = [];
  const allMatches = [...priorSeasonMatches, ...seasonMatches].sort((a, b) => a.date.getTime() - b.date.getTime());

  for (const match of seasonMatches) {
    const priorAll = allMatches.filter(m => m.date.getTime() < match.date.getTime());
    const historyMap = buildTeamHistoryMap(priorAll);

    const homeHistory = historyMap.get(match.homeTeam) ?? [];
    const awayHistory = historyMap.get(match.awayTeam) ?? [];

    const homeVenueForm = homeHistory.filter(r => r.venue === 'home').sort((a, b) => b.date.getTime() - a.date.getTime());
    const awayVenueForm = awayHistory.filter(r => r.venue === 'away').sort((a, b) => b.date.getTime() - a.date.getTime());

    if (homeVenueForm.length < MIN_PRIOR_MATCHES || awayVenueForm.length < MIN_PRIOR_MATCHES) continue;

    const { lambdaHomeGoals, lambdaAwayGoals, lambdaHomeCorners, lambdaAwayCorners } = computeLambdas(homeVenueForm, awayVenueForm);
    const actualGoals = match.homeGoals + match.awayGoals;
    const actualCorners = match.homeCorners + match.awayCorners;

    // ── GOALS: plain Poisson AND Dixon-Coles, same match, same line ──
    for (const line of TARGET_GOAL_LINES) {
      const overProbPoisson = totalOverProbability(lambdaHomeGoals, lambdaAwayGoals, line, 8);
      const underProbPoisson = 1 - overProbPoisson;
      const selectionPoisson = overProbPoisson >= underProbPoisson ? `Over ${line}` : `Under ${line}`;
      const confidencePoisson = Math.max(overProbPoisson, underProbPoisson);

      if (confidencePoisson >= MIN_TIP_CONFIDENCE) {
        results.push({
          league, variant: variantLabel, method: 'poisson',
          date: match.date.toISOString().split('T')[0],
          homeTeam: match.homeTeam, awayTeam: match.awayTeam,
          marketType: 'goals', targetLine: line,
          predictedSelection: selectionPoisson, predictedProbability: confidencePoisson,
          actualTotal: actualGoals,
          hit: selectionPoisson.startsWith('Over') ? actualGoals > line : actualGoals <= line
        });
      }

      const overProbDC = totalOverProbabilityDixonColes(lambdaHomeGoals, lambdaAwayGoals, line, 8);
      const underProbDC = 1 - overProbDC;
      const selectionDC = overProbDC >= underProbDC ? `Over ${line}` : `Under ${line}`;
      const confidenceDC = Math.max(overProbDC, underProbDC);

      if (confidenceDC >= MIN_TIP_CONFIDENCE) {
        results.push({
          league, variant: variantLabel, method: 'dixon-coles',
          date: match.date.toISOString().split('T')[0],
          homeTeam: match.homeTeam, awayTeam: match.awayTeam,
          marketType: 'goals', targetLine: line,
          predictedSelection: selectionDC, predictedProbability: confidenceDC,
          actualTotal: actualGoals,
          hit: selectionDC.startsWith('Over') ? actualGoals > line : actualGoals <= line
        });
      }
    }

    // ── CORNERS: plain Poisson AND Negative Binomial ──
    if (match.homeCorners > 0 || match.awayCorners > 0) {
      for (const line of TARGET_CORNER_LINES) {
        const overProb = totalOverProbability(lambdaHomeCorners, lambdaAwayCorners, line, 20);
        const underProb = 1 - overProb;
        const selection = overProb >= underProb ? `Over ${line}` : `Under ${line}`;
        const confidence = Math.max(overProb, underProb);

        if (confidence >= MIN_TIP_CONFIDENCE) {
          results.push({
            league, variant: variantLabel, method: 'poisson',
            date: match.date.toISOString().split('T')[0],
            homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            marketType: 'corners', targetLine: line,
            predictedSelection: selection, predictedProbability: confidence,
            actualTotal: actualCorners,
            hit: selection.startsWith('Over') ? actualCorners > line : actualCorners <= line
          });
        }

        const overProbNB = totalOverProbabilityNB(lambdaHomeCorners, lambdaAwayCorners, line, dispersionK, 20);
        const underProbNB = 1 - overProbNB;
        const selectionNB = overProbNB >= underProbNB ? `Over ${line}` : `Under ${line}`;
        const confidenceNB = Math.max(overProbNB, underProbNB);

        if (confidenceNB >= MIN_TIP_CONFIDENCE) {
          results.push({
            league, variant: variantLabel, method: 'negative-binomial',
            date: match.date.toISOString().split('T')[0],
            homeTeam: match.homeTeam, awayTeam: match.awayTeam,
            marketType: 'corners', targetLine: line,
            predictedSelection: selectionNB, predictedProbability: confidenceNB,
            actualTotal: actualCorners,
            hit: selectionNB.startsWith('Over') ? actualCorners > line : actualCorners <= line
          });
        }
      }
    }
  }

  return results;
}

// ─── ANALYSIS REPORTING ────────────────────────────────────────────────

function printMethodComparisonGoals(results: BacktestResult[]) {
  console.log(`\n======================================================`);
  console.log(`         POISSON vs DIXON-COLES — GOALS COMPARISON      `);
  console.log(`======================================================`);
  console.log(`Method       | Line | Tips   | Hits   | Hit Rate | Avg Conf | Gap`);
  console.log(`------------------------------------------------------------------`);

  for (const line of TARGET_GOAL_LINES) {
    for (const method of ['poisson', 'dixon-coles'] as const) {
      const items = results.filter(r => r.marketType === 'goals' && r.targetLine === line && r.method === method);
      const hits = items.filter(r => r.hit).length;
      const hitRate = items.length > 0 ? (hits / items.length) * 100 : 0;
      const avgConf = items.length > 0 ? (items.reduce((s, r) => s + r.predictedProbability, 0) / items.length) * 100 : 0;
      const gap = avgConf - hitRate;

      console.log(
        `${method.padEnd(12)} | ${line.toFixed(1).padEnd(4)} | ${items.length.toString().padStart(4)} | ${hits.toString().padStart(4)} | ${hitRate.toFixed(1).padStart(6)}% | ${avgConf.toFixed(1).padStart(6)}% | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pt`
      );
    }
  }
}

function printMethodComparisonCorners(results: BacktestResult[], dispersionK: number) {
  console.log(`\n======================================================`);
  console.log(`      POISSON vs NEGATIVE BINOMIAL — CORNERS COMPARISON      `);
  console.log(`      (fitted dispersion k = ${dispersionK === Infinity ? 'Infinity (no overdispersion detected)' : dispersionK.toFixed(2)})      `);
  console.log(`======================================================`);
  console.log(`Method       | Line  | Tips   | Hits   | Hit Rate | Avg Conf | Gap`);
  console.log(`------------------------------------------------------------------`);

  for (const line of TARGET_CORNER_LINES) {
    for (const method of ['poisson', 'negative-binomial'] as const) {
      const items = results.filter(r => r.marketType === 'corners' && r.targetLine === line && r.method === method);
      const hits = items.filter(r => r.hit).length;
      const hitRate = items.length > 0 ? (hits / items.length) * 100 : 0;
      const avgConf = items.length > 0 ? (items.reduce((s, r) => s + r.predictedProbability, 0) / items.length) * 100 : 0;
      const gap = avgConf - hitRate;

      console.log(
        `${method.padEnd(12)} | ${line.toFixed(1).padEnd(5)} | ${items.length.toString().padStart(4)} | ${hits.toString().padStart(4)} | ${hitRate.toFixed(1).padStart(6)}% | ${avgConf.toFixed(1).padStart(6)}% | ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pt`
      );
    }
  }
}

function printLeaguePerformanceReport(results: BacktestResult[], market: 'goals' | 'corners', method?: BacktestResult['method']) {
  const methodLabel = method ? ` — ${method.toUpperCase()}` : '';
  console.log(`\n======================================================`);
  console.log(`         LEAGUE PERFORMANCE BREAKDOWN (${market.toUpperCase()})${methodLabel}         `);
  console.log(`======================================================`);

  const leagueMap = new Map<string, BacktestResult[]>();
  for (const r of results) {
    if (r.marketType !== market) continue;
    if (method && r.method !== method) continue;
    if (!leagueMap.has(r.league)) leagueMap.set(r.league, []);
    leagueMap.get(r.league)!.push(r);
  }

  const stats: { league: string; total: number; hits: number; hitRate: number }[] = [];
  for (const [league, items] of leagueMap.entries()) {
    const total = items.length;
    const hits = items.filter(i => i.hit).length;
    const hitRate = total > 0 ? (hits / total) * 100 : 0;
    stats.push({ league, total, hits, hitRate });
  }

  stats.sort((a, b) => b.hitRate - a.hitRate);

  console.log(`League Name                    | Tips   | Hits   | Hit Rate`);
  console.log(`------------------------------------------------------`);
  for (const s of stats) {
    console.log(
      `${s.league.padEnd(30)} | ${s.total.toString().padStart(4)} | ${s.hits.toString().padStart(4)} | ${s.hitRate.toFixed(1)}%`
    );
  }
}

// ─── LEAGUE RUNNERS ────────────────────────────────────────────────────

async function fetchMainLeagueMatches(league: LeagueConfig): Promise<{ current: HistMatch[]; prior: HistMatch[] }> {
  const [priorSeason, currentSeason] = MAIN_SEASONS;
  const priorCsv = await fetchCsv(`https://www.football-data.co.uk/mmz4281/${priorSeason}/${league.code}.csv`);
  const currentCsv = await fetchCsv(`https://www.football-data.co.uk/mmz4281/${currentSeason}/${league.code}.csv`);

  const priorParsed = parseCsv(priorCsv);
  const currentParsed = parseCsv(currentCsv);
  const priorMatches = rowsToMatches(priorParsed, priorParsed.rows);
  const currentMatches = rowsToMatches(currentParsed, currentParsed.rows);

  return { current: currentMatches, prior: priorMatches };
}

async function fetchExtraLeagueMatches(league: LeagueConfig): Promise<{ current: HistMatch[]; prior: HistMatch[] }> {
  const csvText = await fetchCsv(`https://www.football-data.co.uk/new/${league.code}.csv`);
  const parsed = parseCsv(csvText);
  const seasons = getDistinctSeasons(parsed);

  if (seasons.length === 0) {
    throw new Error(`[Backtest] No Season column values found for ${league.name}`);
  }

  const currentSeason = seasons[seasons.length - 1];
  const priorSeason = seasons.length >= 2 ? seasons[seasons.length - 2] : null;

  const currentMatches = matchesForSeason(parsed, currentSeason);
  const priorMatches = priorSeason ? matchesForSeason(parsed, priorSeason) : [];

  return { current: currentMatches, prior: priorMatches };
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const allResults: BacktestResult[] = [];
  const failures: string[] = [];
  const leagueMatchCache: { league: LeagueConfig; current: HistMatch[]; prior: HistMatch[] }[] = [];

  console.log('Starting multi-market (Goals & Corners) remote backtest across all leagues...');
  console.log('Fetching all league data (pass 1/2 — needed to estimate NB dispersion before scoring)...');

  for (const league of LEAGUES) {
    try {
      const { current, prior } = league.type === 'main'
        ? await fetchMainLeagueMatches(league)
        : await fetchExtraLeagueMatches(league);
      leagueMatchCache.push({ league, current, prior });
      console.log(`  ✓ ${league.name} fetched (${current.length} current + ${prior.length} prior season matches)`);
    } catch (err: any) {
      console.error(`  ✗ ${league.name} FETCH FAILED: ${err.message}`);
      failures.push(`${league.name}: ${err.message}`);
    }
  }

  const allCornerTotals = collectCornerTotals(leagueMatchCache.flatMap(l => [l.current, l.prior]));
  const dispersionK = estimateDispersionK(allCornerTotals);
  console.log(`\nEstimated NB dispersion k = ${dispersionK === Infinity ? 'Infinity' : dispersionK.toFixed(2)} from ${allCornerTotals.length} matches with corner data.`);

  console.log('\nRunning backtest (pass 2/2 — scoring Poisson/Dixon-Coles/NB predictions)...');
  for (const { league, current, prior } of leagueMatchCache) {
    const variantA = runBacktest(league.name, current, [], 'A', dispersionK);
    const variantB = runBacktest(league.name, current, prior, 'B', dispersionK);
    allResults.push(...variantA, ...variantB);
    console.log(`  ✓ ${league.name} scored (${variantA.length + variantB.length} qualifying tips evaluated)`);
  }

  printMethodComparisonGoals(allResults);
  printMethodComparisonCorners(allResults, dispersionK);

  printLeaguePerformanceReport(allResults, 'goals', 'poisson');
  printLeaguePerformanceReport(allResults, 'corners', 'poisson');
  printLeaguePerformanceReport(allResults, 'corners', 'negative-binomial');

  if (failures.length) {
    console.log(`\n${failures.length} league(s) failed:`);
    failures.forEach(f => console.log(`  - ${f}`));
  }

  console.log('\n=== Backtest Complete ===');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Backtest] Fatal error:', err.message);
    process.exit(1);
  });
}

export { runBacktest, parseCsv, fetchCsv, LEAGUES };