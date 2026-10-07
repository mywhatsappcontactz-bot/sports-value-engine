import { Stats, Odds, H2HRecord, FormRecord } from '../database/schema';

// ─── TYPES ─────────────────────────────────────────────────

export interface MarketProbability {
  market: string;
  selection: string;
  trueProbability: number;
  method: string;

  // Present only for basketball 'totals' rows. The model's own predicted
  // combined-score total for this specific matchup, independent of
  // whatever comparison line (real or fallback default) was used to
  // compute trueProbability. Lets callers without real odds (the free
  // tipscanner path) show "model predicts ~187" instead of forcing every
  // game through one fixed constant (183.5 WNBA / 225.5 NBA) that's
  // wrong for most individual matchups given real lines vary widely
  // (WNBA observed range: ~171.5-197.5; NBA similarly varies by pace).
  rawExpectedTotal?: number;
}

export interface ModelInput {
  match: {
    id: string;
    sport: string;
    homeTeam: string;
    awayTeam: string;
    startTime: string;
    league?: string;
  };
  stats: Stats;
  odds: Odds[];
}

interface FootballLambdas {
  lambdaHome: number;
  lambdaAway: number;
}

// ─── CONFIG ─────────────────────────────────────────────────

// Toggle: when true, football goals totals (1.5/3.5) use the
// Dixon-Coles corrected calculation instead of plain independent Poisson.
const USE_DIXON_COLES_FOR_TOTALS = false;

// rho is a fixed literature value (typical range -0.05 to -0.15)
const DIXON_COLES_RHO = -0.1;

// Toggle: when true, football corners totals (7.5/8.5) AND corners
// winner use a Negative Binomial distribution instead of plain Poisson.
const USE_NB_FOR_CORNERS = true;

// Dispersion parameter k, fitted empirically in backtestModel.ts (~58)
const CORNERS_NB_DISPERSION_K = 58;

// Config: Tennis confidence ceiling based on multi-year backtest data (2021-2024).
const TENNIS_MAX_CONFIDENCE_CAP = 0.799;

// Config: Minimum probability threshold to surface totals bets
const TOTALS_MIN_CONFIDENCE = 0.54;

// Placeholder — UNVALIDATED against real data, same status as baseball's
// parkFactor/bullpenFactor hooks below. Converts a goalie's rolling
// GSAx/60 (goals saved above expected per 60 min, prior starts only —
// see mergeGoalieGSAx.ts) into a multiplicative adjustment on the
// SHOOTING team's expected goals. 0.05 means a goalie running +1.0
// GSAx/60 suppresses the opponent's lambda by 5%. Clamped to +/-15% so
// a single small-sample rolling value can't blow up a lambda. Tune or
// replace with a fitted curve once sbroNhlPuckLineGoalieBacktest.ts
// shows this is worth keeping — do not trust this number as calibrated.
const GOALIE_GSAX_SENSITIVITY = 0.05;

// ─── POISSON ─────────────────────────────────────────────────

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function poissonMatchProbs(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals = 8,
): { home: number; draw: number; away: number } {
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  return { home, draw, away };
}

function totalOverProbability(lambdaHome: number, lambdaAway: number, line: number, maxGoals = 8): number {
  let overProb = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      if (i + j > line) overProb += poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
    }
  }
  return overProb;
}

// ─── DIXON-COLES CORRECTION ─────────────────────────────────────────

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
  maxGoals = 8,
  rho: number = DIXON_COLES_RHO,
): number {
  let overProb = 0;
  let total = 0;

  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const base = poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
      const tau = dixonColesTau(i, j, lambdaHome, lambdaAway, rho);
      const p = base * tau;
      total += p;
      if (i + j > line) overProb += p;
    }
  }

  return total > 0 ? overProb / total : overProb;
}

// ─── NEGATIVE BINOMIAL CORRECTION ──────────────────────────────────

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

// Single-side over-probability — ONE team's own count exceeding a line,
// distinct from totalOverProbabilityNB/totalOverProbability above (which
// sum TWO teams' counts together). Needed for team-corners-over: "will
// THIS team's own corners exceed X", not "will the combined total exceed
// X" (corners_totals) or "will team A have more than team B" (corners_winner).
function singleOverProbabilityNB(mean: number, line: number, k: number, maxVal = 20): number {
  let overProb = 0;
  for (let i = 0; i <= maxVal; i++) {
    if (i > line) overProb += negativeBinomialPmf(mean, k, i);
  }
  return overProb;
}

function singleOverProbabilityPoisson(mean: number, line: number, maxVal = 20): number {
  let overProb = 0;
  for (let i = 0; i <= maxVal; i++) {
    if (i > line) overProb += poissonPmf(mean, i);
  }
  return overProb;
}

export function marginDistribution(lambdaHome: number, lambdaAway: number, maxGoals = 8): Map<number, number> {
  const dist = new Map<number, number>();
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      const p = poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
      const margin = i - j;
      dist.set(margin, (dist.get(margin) || 0) + p);
    }
  }
  return dist;
}

export function handicapCoverProbability(dist: Map<number, number>, line: number): number {
  const isQuarterLine = Math.abs((line * 4) % 1) < 1e-9 && Math.abs((line * 2) % 1) > 1e-9;

  if (isQuarterLine) {
    const lower = Math.floor(line * 2) / 2;
    const upper = Math.ceil(line * 2) / 2;
    return (
      handicapCoverProbability(dist, lower) * 0.5 +
      handicapCoverProbability(dist, upper) * 0.5
    );
  }

  let cover = 0;
  let push = 0;
  for (const [margin, p] of dist) {
    const adjusted = margin + line;
    if (adjusted > 0) cover += p;
    else if (adjusted === 0) push += p;
  }
  const lose = 1 - cover - push;
  const settled = cover + lose;
  return settled > 0 ? cover / settled : cover;
}

// ─── FORM HELPERS ─────────────────────────────────────────────────

function formWinRate(form: FormRecord[]): number {
  if (!form.length) return 0.5;
  const wins = form.filter(f => f.result === 'W').length;
  return wins / form.length;
}

function h2hWinRate(h2h: H2HRecord[], perspective: 'home' | 'away'): number {
  if (!h2h.length) return 0.5;
  const wins = h2h.filter(r => {
    if (r.winner !== undefined) return r.winner === perspective;
    if (perspective === 'home') return r.homeScore > r.awayScore;
    return r.awayScore > r.homeScore;
  }).length;
  return wins / h2h.length;
}

function weightedGoalsAvg(form: FormRecord[], key: 'goalsFor' | 'goalsAgainst'): number {
  const withData = form.filter(f => f[key] !== undefined);
  if (!withData.length) return 1.2;
  let weightSum = 0, valueSum = 0;
  withData.forEach((f, i) => {
    const w = Math.pow(0.85, i);
    valueSum += (f[key] as number) * w;
    weightSum += w;
  });
  return valueSum / weightSum;
}

// ─── ELO ─────────────────────────────────────────────────────

function eloStrengthRatio(
  homeWinRate: number,
  awayWinRate: number,
  h2hHomeWinRate: number,
): number {
  const homeStrength = homeWinRate * 0.6 + h2hHomeWinRate * 0.4;
  const awayStrength = awayWinRate * 0.6 + (1 - h2hHomeWinRate) * 0.4;
  const total = homeStrength + awayStrength || 1;
  return homeStrength / total;
}

// ─── NORMALIZATION ─────────────────────────────────────────────────

function normalize(probs: Record<string, number>): Record<string, number> {
  const total = Object.values(probs).reduce((s, v) => s + v, 0);
  if (total === 0) return probs;
  const out: Record<string, number> = {};
  for (const k of Object.keys(probs)) out[k] = probs[k] / total;
  return out;
}

// ─── NORMAL CDF ─────────────────────────────────────────────────

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
  return z > 0 ? 1 - p : p;
}

// ─── TOTAL LINE EXTRACTOR ─────────────────────────────────────────────────

function extractTotalLine(odds: Odds[], market: string, defaultLine: number): number {
  const oddsForMarket = odds.filter(o => o.market === market);
  if (!oddsForMarket.length) return defaultLine;
  for (const o of oddsForMarket) {
    const match = o.selection.match(/[\d.]+/);
    if (match) return parseFloat(match[0]);
  }
  return defaultLine;
}

// ─── FOOTBALL LAMBDA COMPUTATION ──────────────────────────────

function computeFootballLambdas(stats: Stats): FootballLambdas {
  const homeVenueForm = stats.homeForm.filter(f => f.venue === 'home');
  const awayVenueForm = stats.awayForm.filter(f => f.venue === 'away');

  const homeAttack = weightedGoalsAvg(homeVenueForm, 'goalsFor');
  const awayAttack = weightedGoalsAvg(awayVenueForm, 'goalsFor');
  const homeDefenseWeakness = weightedGoalsAvg(homeVenueForm, 'goalsAgainst');
  const awayDefenseWeakness = weightedGoalsAvg(awayVenueForm, 'goalsAgainst');

  const formLambdaHome = (homeAttack + awayDefenseWeakness) / 2;
  const formLambdaAway = (awayAttack + homeDefenseWeakness) / 2;

  const leagueLambdaHome = (stats.additionalContext?.homeGoalsAvg as number | undefined) ?? 1.35;
  const leagueLambdaAway = (stats.additionalContext?.awayGoalsAvg as number | undefined) ?? 1.10;

  let lambdaHome = formLambdaHome * 0.5 + leagueLambdaHome * 0.5;
  let lambdaAway = formLambdaAway * 0.5 + leagueLambdaAway * 0.5;

  const h2hHomeGoals = stats.h2h.reduce((s, r) => s + r.homeScore, 0) / (stats.h2h.length || 1);
  const h2hAwayGoals = stats.h2h.reduce((s, r) => s + r.awayScore, 0) / (stats.h2h.length || 1);
  lambdaHome = lambdaHome * 0.8 + h2hHomeGoals * 0.2;
  lambdaAway = lambdaAway * 0.8 + h2hAwayGoals * 0.2;

  lambdaHome *= 1.08;

  const fatigue = stats.situational?.fatigueDays;
  if (fatigue !== undefined && fatigue < 4) {
    lambdaAway *= (0.88 + fatigue * 0.03);
  }

  const weather = stats.situational?.weather?.toLowerCase() || '';
  if (weather.includes('heavy rain') || weather.includes('storm')) {
    lambdaHome *= 0.88;
    lambdaAway *= 0.88;
  }

  const surface = stats.additionalContext?.surfaceType as string | undefined;
  if (surface === 'artificial') {
    lambdaHome *= 1.10;
    lambdaAway *= 1.10;
  }

  if (stats.referee?.avgFouls && stats.referee.avgFouls > 32) {
    lambdaHome *= 0.95;
    lambdaAway *= 0.95;
  }

  lambdaHome = Math.min(lambdaHome, 3.0);
  lambdaAway = Math.min(lambdaAway, 3.0);

  return { lambdaHome, lambdaAway };
}

const CORNERS_LINES = [7.5, 8.5, 9.5,];
const CORNERS_MIN_CONFIDENCE = 0.80;

// ─── CORNERS TOTALS ISOTONIC ─────────────────────────────────────
// Fitted via scripts/cornersTotalsIsotonicFit.ts on pooled 2016/17-2024/25
// seasons (football-data.co.uk, 13 leagues), 12,700 predictions — the
// exact tips modelFootballCorners would have fired historically. Refit
// after catching a self-referential bug (see conversation): the prior
// fit was feeding this function's own already-calibrated output back
// into itself. Reliable range: x=0.8005-0.8780 (9 blocks, min weight 30
// games). Anything above the top raw block (x=0.8780, from only 25
// games in the 90-95% raw band — real hit rate there was 56.0%, too
// thin to trust) clamps to the last block's y=0.7996 rather than
// extrapolating.
const CORNERS_TOTALS_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8005, y: 0.6712 },
  { x: 0.8014, y: 0.7324 },
  { x: 0.8021, y: 0.7415 },
  { x: 0.8128, y: 0.7521 },
  { x: 0.8275, y: 0.7597 },
  { x: 0.8380, y: 0.7694 },
  { x: 0.8553, y: 0.7715 },
  { x: 0.8701, y: 0.7818 },
  { x: 0.8780, y: 0.7996 },
];

function applyCornersTotalsIsotonicCalibration(rawProb: number): number {
  const blocks = CORNERS_TOTALS_ISOTONIC_BLOCKS;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function modelFootballCorners(stats: Stats): MarketProbability | null {
  const lambdaHome = stats.homeCornersAvg;
  const lambdaAway = stats.awayCornersAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const overProbs = CORNERS_LINES.map((line) => ({
    line,
    prob: USE_NB_FOR_CORNERS
      ? totalOverProbabilityNB(lambdaHome, lambdaAway, line, CORNERS_NB_DISPERSION_K, 20)
      : totalOverProbability(lambdaHome, lambdaAway, line, 20),
  }));

  const clearingFloor = overProbs.filter((o) => o.prob >= CORNERS_MIN_CONFIDENCE);
  if (!clearingFloor.length) return null;

  const best = clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));
  const calibratedProb = applyCornersTotalsIsotonicCalibration(best.prob);
  return {
    market: 'corners_totals',
    selection: `Over ${best.line}`,
    trueProbability: calibratedProb,
    method: USE_NB_FOR_CORNERS ? 'negative-binomial-corners-isotonic' : 'poisson-corners-isotonic',
  };
}

// Joint Home/Draw/Away distribution over corner counts, reusing the same
// distribution family (NB vs Poisson) as modelFootballCorners' totals
// calculation via USE_NB_FOR_CORNERS, so the two corners markets stay
// consistent with each other. 3-way (not 2-way) because tied corner
// counts are common enough at typical football corner totals (roughly
// 4-10 per team) that a "Draw" outcome is real and matches how "Corners
// Result" markets are actually priced at most bookmakers.
function cornersWinnerProbs(lambdaHome: number, lambdaAway: number, maxVal = 20): { home: number; draw: number; away: number } {
  let home = 0, draw = 0, away = 0;
  for (let i = 0; i <= maxVal; i++) {
    for (let j = 0; j <= maxVal; j++) {
      const p = USE_NB_FOR_CORNERS
        ? negativeBinomialPmf(lambdaHome, CORNERS_NB_DISPERSION_K, i) * negativeBinomialPmf(lambdaAway, CORNERS_NB_DISPERSION_K, j)
        : poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
      if (i > j) home += p;
      else if (i === j) draw += p;
      else away += p;
    }
  }
  return { home, draw, away };
}

// ─── CORNERS WINNER ISOTONIC ─────────────────────────────────────
// Fitted via scripts/cornersWinnerIsotonicFit.ts on pooled 2016/17-2024/25
// seasons (football-data.co.uk, 13 leagues), 33,967 predictions. Refit
// after catching the same self-referential bug as corners_totals — see
// that table's comment. Reliable range: x=0.4390-0.9666 (33 blocks, min
// weight 30 games, low-end/high-end noisy blocks excluded).
//
// SCOPE: used ONLY by modelFootballCornersWinner. corners_totals has its
// own separate table above.
const CORNERS_WINNER_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.4390, y: 0.4367 },
  { x: 0.4512, y: 0.4452 },
  { x: 0.4688, y: 0.4661 },
  { x: 0.4863, y: 0.4836 },
  { x: 0.5054, y: 0.4844 },
  { x: 0.5250, y: 0.5003 },
  { x: 0.5355, y: 0.5088 },
  { x: 0.5375, y: 0.5135 },
  { x: 0.5443, y: 0.5188 },
  { x: 0.5642, y: 0.5280 },
  { x: 0.5982, y: 0.5428 },
  { x: 0.6238, y: 0.5433 },
  { x: 0.6308, y: 0.5631 },
  { x: 0.6413, y: 0.5663 },
  { x: 0.6591, y: 0.5876 },
  { x: 0.6703, y: 0.5970 },
  { x: 0.6803, y: 0.6116 },
  { x: 0.7126, y: 0.6241 },
  { x: 0.7511, y: 0.6388 },
  { x: 0.7764, y: 0.6505 },
  { x: 0.7899, y: 0.6616 },
  { x: 0.7966, y: 0.6643 },
  { x: 0.8043, y: 0.6723 },
  { x: 0.8112, y: 0.7072 },
  { x: 0.8222, y: 0.7192 },
  { x: 0.8294, y: 0.7288 },
  { x: 0.8435, y: 0.7346 },
  { x: 0.8707, y: 0.7448 },
  { x: 0.8853, y: 0.7561 },
  { x: 0.8961, y: 0.7668 },
  { x: 0.9161, y: 0.8175 },
  { x: 0.9408, y: 0.8509 },
  { x: 0.9666, y: 0.9318 },
];

function applyCornersWinnerIsotonicCalibration(rawProb: number): number {
  const blocks = CORNERS_WINNER_ISOTONIC_BLOCKS;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function modelFootballCornersWinner(stats: Stats): MarketProbability[] | null {
  const lambdaHome = stats.homeCornersAvg;
  const lambdaAway = stats.awayCornersAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const raw = cornersWinnerProbs(lambdaHome, lambdaAway);

  // Calibrate only the favorite (argmax) side, then scale the other two
  // outcomes proportionally so all three still sum to 1 — same
  // invariant-preserving approach used for basketball moneyline/totals,
  // adapted for a 3-way market instead of 2-way. The fit itself was built
  // exactly this way (always calibrating whichever side the raw model
  // favored), so this is the correct inverse to apply at prediction time.
  const entries: [('home' | 'draw' | 'away'), number][] = [
    ['home', raw.home], ['draw', raw.draw], ['away', raw.away],
  ];
  const [favoredKey, favoredRaw] = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const calibratedFavored = applyCornersWinnerIsotonicCalibration(favoredRaw);

  const remainingRawTotal = 1 - favoredRaw || 1;
  const remainingCalibratedTotal = 1 - calibratedFavored;

  const calibrated: Record<'home' | 'draw' | 'away', number> = { home: 0, draw: 0, away: 0 };
  calibrated[favoredKey] = calibratedFavored;
  for (const [key, value] of entries) {
    if (key === favoredKey) continue;
    calibrated[key] = (value / remainingRawTotal) * remainingCalibratedTotal;
  }

  const method = USE_NB_FOR_CORNERS ? 'negative-binomial-corners-winner-isotonic' : 'poisson-corners-winner-isotonic';

  return [
    { market: 'corners_winner', selection: 'Home', trueProbability: calibrated.home, method },
    { market: 'corners_winner', selection: 'Draw', trueProbability: calibrated.draw, method },
    { market: 'corners_winner', selection: 'Away', trueProbability: calibrated.away, method },
  ];
}

// ─── TEAM CORNERS OVER ──────────────────────────────────────────
// DESIGN INTENT (per conversation): eventually REPLACES corners_winner
// as the primary corners market, once proven — but ships alongside
// it for now, not instead of it. corners_winner stays fully active and
// untouched.
//
// WHY MULTIPLE CANDIDATE LINES, NOT ONE FIXED LINE: an earlier
// discussion flagged that a single fixed line (e.g. 4.5) applied to
// every team regardless of their real attacking tendency risks the same
// "barely filters anything" problem the original corners totals model
// hit at a 60-70% floor (91% of games cleared it). Testing multiple
// candidate lines per side and only surfacing the highest one that
// clears the confidence floor (same selection logic as
// modelFootballCorners) behaves more like a real, discriminating market
// instead of a blunt one-size-fits-all bar.
//
// Uses each team's OWN corner count (stats.homeCornersAvg alone, or
// stats.awayCornersAvg alone) via the single-side
// singleOverProbabilityNB/Poisson helpers — NOT the joint two-team
// distribution corners_totals/corners_winner use. Shares
// USE_NB_FOR_CORNERS/CORNERS_NB_DISPERSION_K with the other corners
// markets for consistency, same as corners_winner already does.
const TEAM_CORNERS_LINES = [3.5, 4.5, 5.5];
const TEAM_CORNERS_MIN_CONFIDENCE = 0.80; // raw-probability floor — gates whether a tip fires at all, same pattern as corners_totals
const TEAM_CORNERS_MIN_TIP_CONFIDENCE = 0.70; // CALIBRATED-probability floor — a tip that fires but calibrates below 70% is suppressed, not shipped

// ─── TEAM CORNERS OVER ISOTONIC (SIX TABLES: SIDE x LINE) ───────
// Fitted via scripts/teamCornersOverIsotonicFit.ts (revised version, see
// conversation) on pooled 2016/17-2024/25 seasons (football-data.co.uk,
// 13 leagues), 21,160 predictions. REPLACES the earlier two-table
// (side-only) fit: teamCornersOverBacktest.ts proved raw confidence is
// nearly flat across lines within a side (Home ~72-73.5%, Away
// ~65-66.5%) while real hit rate varies enormously underneath it (Home:
// 76.9% @ 3.5 down to 64.1% @ 5.5; Away: 69.6% @ 3.5 down to 54.5% @
// 5.5) — a spread the old side-only isotonic fit could never see, since
// it only looks at raw probability to decide output and all three lines
// cluster at nearly the same raw value.
//
// AWAY_4_5 and AWAY_5_5 have NO block table on purpose: neither fit
// produced a curve that clears TEAM_CORNERS_MIN_TIP_CONFIDENCE (0.70).
// AWAY_4.5 collapsed to a single flat block (y=0.5960, MIN_RELIABLE_WEIGHT
// left only 1 block standing) and AWAY_5.5 was non-monotonic/thin
// (721 predictions, real hit rate bounced 59.2%→54.6%→44.3%→56.4% across
// bands) — both markets are suppressed entirely at the calibration
// function, per user decision (see conversation): don't ship anything
// that can't cross a 70% real hit rate.
// ─── TEAM CORNERS OVER ISOTONIC (SIX TABLES: HOME/AWAY x 3.5/4.5/5.5) ──
// Fitted via scripts/teamCornersOverIsotonicFit.ts, pooled 2016/17-2024/25
// seasons (football-data.co.uk, 13 leagues), against the shrinkage-
// adjusted homeCornersAvg/awayCornersAvg (see cornersAggregator.ts).
//
// AWAY_4.5 and AWAY_5.5 are DELIBERATELY NOT DEFINED as tables — real
// backtest data showed neither ever clears a 70% real hit rate anywhere
// in its reliable raw-confidence range (AWAY_4.5 flat at ~59.6% across
// its entire range; AWAY_5.5 tops out at ~55.4% even at 92-96% raw
// confidence) — per user decision: only ship tips with a real 70%+ hit
// rate. Both fall through to blocks === null in
// applyTeamCornersOverIsotonicCalibration below, which returns null,
// which modelFootballTeamCornersOver treats as "no tip" (same as never
// clearing the raw floor).
//
// The four live tables (HOME_3.5, HOME_4.5, HOME_5.5, AWAY_3.5) each span
// a raw-confidence range where SOME points clear 70% and some don't —
// TEAM_CORNERS_MIN_TIP_CONFIDENCE (0.70), checked in
// modelFootballTeamCornersOver AFTER calibration, filters out any
// individual tip whose calibrated value falls short, even though the
// table itself stays live. HOME_5.5 and AWAY_3.5 in particular will
// produce comparatively few live tips as a result, since most of their
// raw-confidence range calibrates below 70% — this is expected, not a bug.
const TEAM_CORNERS_HOME_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8108, y: 0.7426 },
  { x: 0.8297, y: 0.7529 },
  { x: 0.8462, y: 0.7644 },
  { x: 0.8565, y: 0.7725 },
  { x: 0.8597, y: 0.7810 },
  { x: 0.8778, y: 0.7870 },
  { x: 0.8963, y: 0.8161 },
  { x: 0.8984, y: 0.8172 },
];

const TEAM_CORNERS_HOME_4_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8077, y: 0.6589 },
  { x: 0.8334, y: 0.6781 },
  { x: 0.8545, y: 0.6824 },
  { x: 0.8595, y: 0.6941 },
  { x: 0.8628, y: 0.7143 },
  { x: 0.8744, y: 0.7304 },
  { x: 0.8888, y: 0.8276 },
];

const TEAM_CORNERS_HOME_5_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8040, y: 0.5472 },
  { x: 0.8083, y: 0.5714 },
  { x: 0.8127, y: 0.5789 },
  { x: 0.8225, y: 0.5859 },
  { x: 0.8483, y: 0.6245 },
  { x: 0.8747, y: 0.6588 },
  { x: 0.8973, y: 0.6638 },
  { x: 0.9246, y: 0.7124 },
  { x: 0.9323, y: 0.7143 },
  { x: 0.9377, y: 0.7157 },
  { x: 0.9446, y: 0.7600 },
  { x: 0.9482, y: 0.7969 },
];

const TEAM_CORNERS_AWAY_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8052, y: 0.6751 },
  { x: 0.8274, y: 0.6768 },
  { x: 0.8501, y: 0.6949 },
  { x: 0.8600, y: 0.6965 },
  { x: 0.8705, y: 0.7112 },
  { x: 0.8791, y: 0.7226 },
  { x: 0.8904, y: 0.7489 },
];

function applyTeamCornersOverIsotonicCalibration(
  side: 'home' | 'away',
  line: number,
  rawProb: number
): number | null {
  let blocks: { x: number; y: number }[] | null = null;

  if (side === 'home' && line === 3.5) blocks = TEAM_CORNERS_HOME_3_5_BLOCKS;
  else if (side === 'home' && line === 4.5) blocks = TEAM_CORNERS_HOME_4_5_BLOCKS;
  else if (side === 'home' && line === 5.5) blocks = TEAM_CORNERS_HOME_5_5_BLOCKS;
  else if (side === 'away' && line === 3.5) blocks = TEAM_CORNERS_AWAY_3_5_BLOCKS;
  // away/4.5 and away/5.5 intentionally fall through with blocks === null
  // — see block comment above the table declarations for why.

  if (blocks === null) return null;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function bestTeamCornersOverLine(mean: number): { line: number; prob: number } | null {
  const overProbs = TEAM_CORNERS_LINES.map((line) => ({
    line,
    prob: USE_NB_FOR_CORNERS
      ? singleOverProbabilityNB(mean, line, CORNERS_NB_DISPERSION_K, 20)
      : singleOverProbabilityPoisson(mean, line, 20),
  }));

  const clearingFloor = overProbs.filter((o) => o.prob >= TEAM_CORNERS_MIN_CONFIDENCE);
  if (!clearingFloor.length) return null;

  return clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));
}

function modelFootballTeamCornersOver(stats: Stats): MarketProbability[] | null {
  const lambdaHome = stats.homeCornersAvg;
  const lambdaAway = stats.awayCornersAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const results: MarketProbability[] = [];
  const method = USE_NB_FOR_CORNERS ? 'negative-binomial-team-corners-over-isotonic' : 'poisson-team-corners-over-isotonic';

  const homeBest = bestTeamCornersOverLine(lambdaHome);
  if (homeBest) {
    const calibrated = applyTeamCornersOverIsotonicCalibration('home', homeBest.line, homeBest.prob);
    if (calibrated !== null && calibrated >= TEAM_CORNERS_MIN_TIP_CONFIDENCE) {
      results.push({
        market: 'team_corners_over',
        selection: `Home Over ${homeBest.line}`,
        trueProbability: calibrated,
        method,
      });
    }
  }

  const awayBest = bestTeamCornersOverLine(lambdaAway);
  if (awayBest) {
    const calibrated = applyTeamCornersOverIsotonicCalibration('away', awayBest.line, awayBest.prob);
    if (calibrated !== null && calibrated >= TEAM_CORNERS_MIN_TIP_CONFIDENCE) {
      results.push({
        market: 'team_corners_over',
        selection: `Away Over ${awayBest.line}`,
        trueProbability: calibrated,
        method,
      });
    }
  }

  return results.length ? results : null;
}

// ─── CARDS ────────────────────────────────────────────────────
// STATUS: uncalibrated — same bootstrap state modelBaseball was in before
// nbaIsotonicFit.ts-style backtesting existed. No historical fit has been
// run against this yet. Do NOT trust confidence numbers as calibrated
// until a real isotonic fit (same pattern as
// CORNERS_WINNER_ISOTONIC_BLOCKS) is built and wired in.
//
// DATA DEPENDENCY: requires stats.homeCardsAvg / stats.awayCardsAvg,
// which do not exist in schema.ts yet, and an FBref cards scraper +
// aggregator (mirrors cornersAggregator.ts) to populate them. Returns
// null until both exist.

const CARDS_LINES = [3.5]; // 4.5 never cleared 70% real hit rate in cardsSotBacktest.ts — dropped
const CARDS_MIN_CONFIDENCE = 0.80;
const USE_NB_FOR_CARDS = true;
// Placeholder — reusing corners' fitted dispersion until a real cards
// backtest produces its own k. Cards and corners are different count
// processes; this is a starting assumption, not a validated value.
const CARDS_NB_DISPERSION_K = 58;

// ─── CARDS / SOT ISOTONIC CALIBRATION ─────────────────────────────
// Fitted via scripts/cardsSotIsotonicFit.ts on pooled 2016/17-2024/25
// seasons (football-data.co.uk, 5 leagues: EPL, La Liga, Bundesliga,
// Serie A, Eredivisie — the exact leagues with live FBref coverage via
// TEAM_FBREF_IDS), after scripts/cardsSotBacktest.ts confirmed these
// specific market/line/side combos clear a real 70%+ hit rate; every
// combo that didn't clear 70% (cards 4.5/5.5/6.5, SOT 8.5/9.5/10.5,
// team cards 2.5/3.5 both sides, team SOT 5.5 both sides) was
// deliberately NOT fit and is not available as a tip at all.
//
// Post-calibration floor: several of these tables still dip below 70%
// at their low-confidence end even though their backtest AVERAGE
// cleared it (e.g. TEAM_SOT_HOME_3.5 ranges 57.6%-84.5% calibrated) —
// same situation team_corners_over's HOME_4.5/HOME_5.5/AWAY_3.5 tables
// were in. CARDS_SOT_MIN_TIP_CONFIDENCE gates every individual tip on
// its OWN calibrated value, not just the table's average, same pattern
// as TEAM_CORNERS_MIN_TIP_CONFIDENCE. Confirmed worth having via
// scripts/sotBaselineCheck.ts: TEAM_SOT_HOME_3.5's uncalibrated low end
// (57.6%) sits BELOW the unconditional base rate of "home clears 3.5 in
// any random match" (67.8%) — without this floor, the weakest tips from
// this table would carry negative real skill, not just low confidence.
const CARDS_SOT_MIN_TIP_CONFIDENCE = 0.70;

const CARDS_TOTALS_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8133, y: 0.6767 },
  { x: 0.8506, y: 0.7127 },
  { x: 0.8752, y: 0.7143 },
  { x: 0.9000, y: 0.7403 },
  { x: 0.9326, y: 0.7576 },
  { x: 0.9422, y: 0.7629 },
  { x: 0.9510, y: 0.7857 },
  { x: 0.9603, y: 0.7979 },
  { x: 0.9706, y: 0.8000 },
  { x: 0.9797, y: 0.8475 },
];

const SOT_TOTALS_7_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8280, y: 0.7155 },
  { x: 0.8539, y: 0.7250 },
  { x: 0.8569, y: 0.7325 },
  { x: 0.8649, y: 0.7679 },
  { x: 0.8801, y: 0.7725 },
  { x: 0.9073, y: 0.7818 },
  { x: 0.9422, y: 0.8344 },
];

const TEAM_CARDS_HOME_1_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8036, y: 0.6418 },
  { x: 0.8079, y: 0.6667 },
  { x: 0.8410, y: 0.7348 },
  { x: 0.8876, y: 0.8000 },
  { x: 0.8887, y: 0.8000 },
  { x: 0.8901, y: 0.8000 },
  { x: 0.9191, y: 0.8125 },
];

const TEAM_CARDS_AWAY_1_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8018, y: 0.6036 },
  { x: 0.8065, y: 0.6626 },
  { x: 0.8093, y: 0.6667 },
  { x: 0.8103, y: 0.6964 },
  { x: 0.8199, y: 0.7187 },
  { x: 0.8540, y: 0.7261 },
  { x: 0.8822, y: 0.7386 },
  { x: 0.8868, y: 0.7455 },
  { x: 0.8969, y: 0.7458 },
  { x: 0.9072, y: 0.7638 },
  { x: 0.9249, y: 0.7791 },
  { x: 0.9544, y: 0.7880 },
  { x: 0.9780, y: 0.7910 },
];

const TEAM_SOT_HOME_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8038, y: 0.5493 },
  { x: 0.8146, y: 0.6930 },
  { x: 0.8311, y: 0.7294 },
  { x: 0.8628, y: 0.7440 },
  { x: 0.8898, y: 0.7551 },
  { x: 0.9040, y: 0.7807 },
  { x: 0.9146, y: 0.7857 },
  { x: 0.9157, y: 0.7969 },
  { x: 0.9183, y: 0.8051 },
  { x: 0.9323, y: 0.8117 },
  { x: 0.9432, y: 0.8333 },
  { x: 0.9523, y: 0.8450 },
];

const TEAM_SOT_AWAY_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8017, y: 0.7179 },
  { x: 0.8041, y: 0.7778 },
  { x: 0.8058, y: 0.7778 },
  { x: 0.8249, y: 0.7897 },
  { x: 0.8589, y: 0.8241 },
  { x: 0.8785, y: 0.8571 },
  { x: 0.8859, y: 0.8696 },
  { x: 0.9147, y: 0.8697 },
  { x: 0.9478, y: 0.8889 },
  { x: 0.9547, y: 0.8958 },
];

const TEAM_SOT_HOME_4_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8023, y: 0.5833 },
  { x: 0.8120, y: 0.6221 },
  { x: 0.8217, y: 0.6333 },
  { x: 0.8243, y: 0.6364 },
  { x: 0.8469, y: 0.6545 },
  { x: 0.8648, y: 0.6667 },
  { x: 0.8652, y: 0.6667 },
  { x: 0.8654, y: 0.6667 },
  { x: 0.8713, y: 0.6724 },
  { x: 0.8777, y: 0.7059 },
  { x: 0.8829, y: 0.7069 },
  { x: 0.8987, y: 0.7211 },
  { x: 0.9109, y: 0.7246 },
  { x: 0.9184, y: 0.7387 },
  { x: 0.9235, y: 0.7647 },
  { x: 0.9253, y: 0.7763 },
  { x: 0.9262, y: 0.8125 },
];

const TEAM_SOT_AWAY_4_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8244, y: 0.7222 },
  { x: 0.8631, y: 0.7273 },
  { x: 0.8954, y: 0.7857 },
];

function isotonicLookup(blocks: { x: number; y: number }[], rawProb: number): number {
  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;
  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function modelFootballCards(stats: Stats): MarketProbability | null {
  const lambdaHome = stats.homeCardsAvg;
  const lambdaAway = stats.awayCardsAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const overProbs = CARDS_LINES.map((line) => ({
    line,
    prob: USE_NB_FOR_CARDS
      ? totalOverProbabilityNB(lambdaHome, lambdaAway, line, CARDS_NB_DISPERSION_K, 15)
      : totalOverProbability(lambdaHome, lambdaAway, line, 15),
  }));

  const clearingFloor = overProbs.filter((o) => o.prob >= CARDS_MIN_CONFIDENCE);
  if (!clearingFloor.length) return null;

  const best = clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));

  // Only 3.5 survives (see CARDS_LINES) — always calibrate against that table.
  const calibrated = isotonicLookup(CARDS_TOTALS_3_5_BLOCKS, best.prob);
  if (calibrated < CARDS_SOT_MIN_TIP_CONFIDENCE) return null;

  return {
    market: 'cards_totals',
    selection: `Over ${best.line}`,
    trueProbability: calibrated,
    method: USE_NB_FOR_CARDS ? 'negative-binomial-cards-isotonic' : 'poisson-cards-isotonic',
  };
}

// ─── SHOTS ON TARGET ───────────────────────────────────────────
// STATUS: uncalibrated — same caveat as modelFootballCards above.
//
// DATA DEPENDENCY: requires stats.homeSotAvg / stats.awaySotAvg (new
// schema.ts fields) and an FBref SOT scraper + aggregator. Returns null
// until both exist.

const SOT_LINES = [7.5]; // 8.5/9.5 never cleared 70% real hit rate in cardsSotBacktest.ts — dropped, 7.5 added (the line that actually survived)
const SOT_MIN_CONFIDENCE = 0.80;
const USE_NB_FOR_SOT = true;
// Placeholder — same reasoning as CARDS_NB_DISPERSION_K above.
const SOT_NB_DISPERSION_K = 58;

function modelFootballShotsOnTarget(stats: Stats): MarketProbability | null {
  const lambdaHome = stats.homeSotAvg;
  const lambdaAway = stats.awaySotAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const overProbs = SOT_LINES.map((line) => ({
    line,
    prob: USE_NB_FOR_SOT
      ? totalOverProbabilityNB(lambdaHome, lambdaAway, line, SOT_NB_DISPERSION_K, 20)
      : totalOverProbability(lambdaHome, lambdaAway, line, 20),
  }));

  const clearingFloor = overProbs.filter((o) => o.prob >= SOT_MIN_CONFIDENCE);
  if (!clearingFloor.length) return null;

  const best = clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));

  // Only 7.5 survives (see SOT_LINES) — always calibrate against that table.
  const calibrated = isotonicLookup(SOT_TOTALS_7_5_BLOCKS, best.prob);
  if (calibrated < CARDS_SOT_MIN_TIP_CONFIDENCE) return null;

  return {
    market: 'sot_totals',
    selection: `Over ${best.line}`,
    trueProbability: calibrated,
    method: USE_NB_FOR_SOT ? 'negative-binomial-sot-isotonic' : 'poisson-sot-isotonic',
  };
}

// ─── TEAM CARDS OVER ────────────────────────────────────────────
// Only Home Over 1.5 / Away Over 1.5 survived cardsSotBacktest.ts's 70%
// bar (2.5/3.5 both sides did not). Mirrors modelFootballTeamCornersOver's
// structure exactly.
const TEAM_CARDS_LINE = 1.5;

function modelFootballTeamCardsOver(stats: Stats): MarketProbability[] | null {
  const lambdaHome = stats.homeCardsAvg;
  const lambdaAway = stats.awayCardsAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const results: MarketProbability[] = [];
  const method = USE_NB_FOR_CARDS ? 'negative-binomial-team-cards-over-isotonic' : 'poisson-team-cards-over-isotonic';

  const homeRawProb = USE_NB_FOR_CARDS
    ? singleOverProbabilityNB(lambdaHome, TEAM_CARDS_LINE, CARDS_NB_DISPERSION_K, 15)
    : singleOverProbabilityPoisson(lambdaHome, TEAM_CARDS_LINE, 15);
  if (homeRawProb >= CARDS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(TEAM_CARDS_HOME_1_5_BLOCKS, homeRawProb);
    if (calibrated >= CARDS_SOT_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'team_cards_over', selection: `Home Over ${TEAM_CARDS_LINE}`, trueProbability: calibrated, method });
    }
  }

  const awayRawProb = USE_NB_FOR_CARDS
    ? singleOverProbabilityNB(lambdaAway, TEAM_CARDS_LINE, CARDS_NB_DISPERSION_K, 15)
    : singleOverProbabilityPoisson(lambdaAway, TEAM_CARDS_LINE, 15);
  if (awayRawProb >= CARDS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(TEAM_CARDS_AWAY_1_5_BLOCKS, awayRawProb);
    if (calibrated >= CARDS_SOT_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'team_cards_over', selection: `Away Over ${TEAM_CARDS_LINE}`, trueProbability: calibrated, method });
    }
  }

  return results.length ? results : null;
}

// ─── TEAM SOT OVER ────────────────────────────────────────────
// Home Over 3.5, Home Over 4.5, Away Over 3.5, Away Over 4.5 all
// survived cardsSotBacktest.ts's 70% bar (5.5 both sides did not).
// Tests both lines per side, picks the highest clearing the raw floor —
// same "pick highest qualifying line" pattern as team_corners_over.
const TEAM_SOT_LINES_LIVE = [3.5, 4.5];

function bestTeamSotOverLine(
  mean: number,
  blocksFor: (line: number) => { x: number; y: number }[]
): { line: number; rawProb: number; calibrated: number } | null {
  const candidates = TEAM_SOT_LINES_LIVE.map((line) => {
    const rawProb = USE_NB_FOR_SOT
      ? singleOverProbabilityNB(mean, line, SOT_NB_DISPERSION_K, 20)
      : singleOverProbabilityPoisson(mean, line, 20);
    return { line, rawProb, calibrated: rawProb >= SOT_MIN_CONFIDENCE ? isotonicLookup(blocksFor(line), rawProb) : -1 };
  });

  const clearingBoth = candidates.filter((c) => c.rawProb >= SOT_MIN_CONFIDENCE && c.calibrated >= CARDS_SOT_MIN_TIP_CONFIDENCE);
  if (!clearingBoth.length) return null;

  return clearingBoth.reduce((a, b) => (b.line > a.line ? b : a));
}

function modelFootballTeamSotOver(stats: Stats): MarketProbability[] | null {
  const lambdaHome = stats.homeSotAvg;
  const lambdaAway = stats.awaySotAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const results: MarketProbability[] = [];
  const method = USE_NB_FOR_SOT ? 'negative-binomial-team-sot-over-isotonic' : 'poisson-team-sot-over-isotonic';

  const homeBest = bestTeamSotOverLine(lambdaHome, (line) => (line === 3.5 ? TEAM_SOT_HOME_3_5_BLOCKS : TEAM_SOT_HOME_4_5_BLOCKS));
  if (homeBest) {
    results.push({ market: 'team_sot_over', selection: `Home Over ${homeBest.line}`, trueProbability: homeBest.calibrated, method });
  }

  const awayBest = bestTeamSotOverLine(lambdaAway, (line) => (line === 3.5 ? TEAM_SOT_AWAY_3_5_BLOCKS : TEAM_SOT_AWAY_4_5_BLOCKS));
  if (awayBest) {
    results.push({ market: 'team_sot_over', selection: `Away Over ${awayBest.line}`, trueProbability: awayBest.calibrated, method });
  }

  return results.length ? results : null;
}

function modelFootball(input: ModelInput): MarketProbability[] {
  const { stats } = input;
  const results: MarketProbability[] = [];

  const { lambdaHome, lambdaAway } = computeFootballLambdas(stats);

  const raw1x2 = poissonMatchProbs(lambdaHome, lambdaAway);

  const homeWR = formWinRate(stats.homeForm);
  const awayWR = formWinRate(stats.awayForm);
  const h2hHWR = h2hWinRate(stats.h2h, 'home');
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);

  const blended = normalize({
    home: raw1x2.home * 0.7 + eloHome * 0.3,
    draw: raw1x2.draw * 0.7 + 0.25 * 0.3,
    away: raw1x2.away * 0.7 + (1 - eloHome) * 0.3,
  });

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: blended.home, method: 'poisson+elo' },
    { market: 'moneyline', selection: 'Draw', trueProbability: blended.draw, method: 'poisson+elo' },
    { market: 'moneyline', selection: 'Away', trueProbability: blended.away, method: 'poisson+elo' },
  );

  results.push(
    { market: 'double_chance', selection: '1X', trueProbability: blended.home + blended.draw, method: 'derived-1x2' },
    { market: 'double_chance', selection: 'X2', trueProbability: blended.draw + blended.away, method: 'derived-1x2' },
    { market: 'double_chance', selection: '12', trueProbability: blended.home + blended.away, method: 'derived-1x2' },
  );

  // ─── GOALS TOTALS ISOTONIC CALIBRATION ─────────────────────────────
  // Fitted via scripts/goalsTotalsIsotonicFit.ts on pooled 2016/17-2024/25
  // seasons (football-data.co.uk, all 13 leagues — no FBref dependency),
  // after scripts/goalsTotalsBacktest.ts confirmed these 8 specific
  // market/line/side combos clear a real 70%+ hit rate out of 14 tested.
  // Team Over 1.5/2.5 (both sides) and team Under 1.5 (both sides) did
  // NOT clear 70% and are NOT available as tips at all.
  //
  // BEHAVIOR CHANGE from the old generic TARGET_LINES loop: this now
  // ONLY produces combined Over 1.5 / Under 3.5 (the two selections
  // actually backtested) — NOT Under 1.5 or Over 3.5, which were never
  // tested and are no longer possible outputs.
  //
  // Tables fit against PLAIN POISSON raw output — hardcoded to
  // totalOverProbability/singleOverProbabilityPoisson below regardless
  // of USE_DIXON_COLES_FOR_TOTALS; if that flag is ever turned on, these
  // tables would need refitting first.
  //
  // Declared locally (matching this section's pre-existing convention —
  // TARGET_LINES itself was already function-local, not module-level)
  // rather than hoisted to module scope. Minor known tradeoff: these 8
  // arrays + helper function get redeclared on every modelFootball()
  // call rather than once — negligible for this job's call volume, but
  // worth hoisting to module scope later if that ever changes.
  const GOALS_MIN_TIP_CONFIDENCE = 0.70;

  const COMBINED_OVER_1_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5415, y: 0.6607 },
    { x: 0.5433, y: 0.6667 },
    { x: 0.6333, y: 0.7234 },
    { x: 0.7073, y: 0.7277 },
    { x: 0.7207, y: 0.7294 },
    { x: 0.7282, y: 0.7302 },
    { x: 0.7326, y: 0.7377 },
    { x: 0.7369, y: 0.7419 },
    { x: 0.7455, y: 0.7480 },
    { x: 0.7765, y: 0.7561 },
    { x: 0.8202, y: 0.7694 },
    { x: 0.8466, y: 0.7812 },
    { x: 0.8687, y: 0.7893 },
    { x: 0.9020, y: 0.7953 },
    { x: 0.9267, y: 0.8004 },
    { x: 0.9342, y: 0.8182 },
    { x: 0.9374, y: 0.8309 },
    { x: 0.9414, y: 0.8316 },
    { x: 0.9437, y: 0.8333 },
    { x: 0.9496, y: 0.8407 },
    { x: 0.9598, y: 0.8446 },
    { x: 0.9732, y: 0.8506 },
  ];

  const COMBINED_UNDER_3_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5447, y: 0.6747 },
    { x: 0.5616, y: 0.6766 },
    { x: 0.5810, y: 0.6769 },
    { x: 0.6009, y: 0.6800 },
    { x: 0.6242, y: 0.6946 },
    { x: 0.6400, y: 0.7000 },
    { x: 0.6705, y: 0.7104 },
    { x: 0.7038, y: 0.7214 },
    { x: 0.7361, y: 0.7231 },
    { x: 0.7593, y: 0.7253 },
    { x: 0.7696, y: 0.7263 },
    { x: 0.7830, y: 0.7274 },
    { x: 0.7881, y: 0.7338 },
    { x: 0.8199, y: 0.7560 },
    { x: 0.8557, y: 0.7786 },
    { x: 0.9108, y: 0.7790 },
    { x: 0.9982, y: 0.7931 },
  ];

  const TEAM_GOALS_OVER_HOME_0_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5423, y: 0.6452 },
    { x: 0.5438, y: 0.6667 },
    { x: 0.5448, y: 0.6875 },
    { x: 0.5844, y: 0.6939 },
    { x: 0.6423, y: 0.7049 },
    { x: 0.6836, y: 0.7154 },
    { x: 0.7084, y: 0.7194 },
    { x: 0.7286, y: 0.7319 },
    { x: 0.7481, y: 0.7331 },
    { x: 0.7625, y: 0.7334 },
    { x: 0.7744, y: 0.7343 },
    { x: 0.7785, y: 0.7458 },
    { x: 0.7789, y: 0.7500 },
    { x: 0.7791, y: 0.7500 },
    { x: 0.7804, y: 0.7530 },
    { x: 0.7883, y: 0.7686 },
    { x: 0.7954, y: 0.7692 },
    { x: 0.8011, y: 0.7763 },
    { x: 0.8107, y: 0.7767 },
    { x: 0.8164, y: 0.7778 },
    { x: 0.8377, y: 0.7818 },
    { x: 0.8620, y: 0.7840 },
    { x: 0.8847, y: 0.7897 },
    { x: 0.9030, y: 0.7990 },
    { x: 0.9040, y: 0.8000 },
    { x: 0.9044, y: 0.8068 },
    { x: 0.9188, y: 0.8320 },
    { x: 0.9336, y: 0.8333 },
    { x: 0.9456, y: 0.8483 },
    { x: 0.9585, y: 0.8529 },
    { x: 0.9610, y: 0.8626 },
    { x: 0.9637, y: 0.8660 },
    { x: 0.9644, y: 0.8750 },
    { x: 0.9647, y: 0.8868 },
    { x: 0.9723, y: 0.8918 },
    { x: 0.9811, y: 0.9130 },
    { x: 0.9822, y: 0.9444 },
    { x: 0.9822, y: 0.9706 },
  ];

  const TEAM_GOALS_OVER_AWAY_0_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5422, y: 0.6046 },
    { x: 0.5461, y: 0.6152 },
    { x: 0.5566, y: 0.6500 },
    { x: 0.5714, y: 0.6605 },
    { x: 0.5873, y: 0.6875 },
    { x: 0.6140, y: 0.7081 },
    { x: 0.6320, y: 0.7138 },
    { x: 0.6545, y: 0.7226 },
    { x: 0.6915, y: 0.7245 },
    { x: 0.7140, y: 0.7254 },
    { x: 0.7414, y: 0.7322 },
    { x: 0.7658, y: 0.7521 },
    { x: 0.7884, y: 0.7626 },
    { x: 0.8108, y: 0.7658 },
    { x: 0.8378, y: 0.7944 },
    { x: 0.8696, y: 0.8099 },
    { x: 0.8912, y: 0.8468 },
    { x: 0.9314, y: 0.8497 },
    { x: 0.9625, y: 0.8681 },
    { x: 0.9753, y: 0.9216 },
  ];

  const TEAM_GOALS_UNDER_HOME_2_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5436, y: 0.7143 },
    { x: 0.5475, y: 0.7143 },
    { x: 0.5674, y: 0.7480 },
    { x: 0.5864, y: 0.7500 },
    { x: 0.5886, y: 0.7589 },
    { x: 0.6124, y: 0.7791 },
    { x: 0.6358, y: 0.7800 },
    { x: 0.6384, y: 0.7805 },
    { x: 0.6548, y: 0.7962 },
    { x: 0.7127, y: 0.8097 },
    { x: 0.7653, y: 0.8201 },
    { x: 0.7921, y: 0.8352 },
    { x: 0.8194, y: 0.8460 },
    { x: 0.8356, y: 0.8549 },
    { x: 0.8585, y: 0.8569 },
    { x: 0.8787, y: 0.8788 },
    { x: 0.9072, y: 0.8788 },
    { x: 0.9451, y: 0.8823 },
    { x: 0.9600, y: 0.8918 },
    { x: 0.9792, y: 0.9008 },
    { x: 0.9986, y: 0.9234 },
  ];

  const TEAM_GOALS_UNDER_AWAY_2_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5962, y: 0.7358 },
    { x: 0.6448, y: 0.7372 },
    { x: 0.6533, y: 0.7391 },
    { x: 0.6655, y: 0.7406 },
    { x: 0.6859, y: 0.7483 },
    { x: 0.7376, y: 0.7959 },
    { x: 0.7849, y: 0.8014 },
    { x: 0.8084, y: 0.8113 },
    { x: 0.8231, y: 0.8155 },
    { x: 0.8288, y: 0.8391 },
    { x: 0.8659, y: 0.8468 },
    { x: 0.8960, y: 0.8608 },
    { x: 0.9098, y: 0.8661 },
    { x: 0.9225, y: 0.8666 },
    { x: 0.9340, y: 0.8827 },
    { x: 0.9440, y: 0.8867 },
    { x: 0.9466, y: 0.8929 },
    { x: 0.9504, y: 0.8939 },
    { x: 0.9573, y: 0.8975 },
    { x: 0.9664, y: 0.9078 },
    { x: 0.9707, y: 0.9091 },
    { x: 0.9754, y: 0.9138 },
    { x: 0.9850, y: 0.9263 },
    { x: 0.9934, y: 0.9293 },
    { x: 0.9968, y: 0.9333 },
    { x: 0.9970, y: 0.9344 },
    { x: 0.9983, y: 0.9372 },
    { x: 0.9996, y: 0.9452 },
    { x: 0.9999, y: 0.9545 },
  ];

  const TEAM_GOALS_UNDER_HOME_3_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5447, y: 0.8198 },
    { x: 0.5877, y: 0.8634 },
    { x: 0.6425, y: 0.8718 },
    { x: 0.6644, y: 0.8802 },
    { x: 0.6848, y: 0.8836 },
    { x: 0.7043, y: 0.8943 },
    { x: 0.7203, y: 0.9022 },
    { x: 0.7471, y: 0.9037 },
    { x: 0.7716, y: 0.9069 },
    { x: 0.7848, y: 0.9142 },
    { x: 0.8146, y: 0.9211 },
    { x: 0.8388, y: 0.9231 },
    { x: 0.8428, y: 0.9270 },
    { x: 0.8492, y: 0.9276 },
    { x: 0.8733, y: 0.9341 },
    { x: 0.8989, y: 0.9356 },
    { x: 0.9047, y: 0.9412 },
    { x: 0.9085, y: 0.9446 },
    { x: 0.9232, y: 0.9491 },
    { x: 0.9355, y: 0.9506 },
    { x: 0.9449, y: 0.9540 },
    { x: 0.9570, y: 0.9542 },
    { x: 0.9625, y: 0.9599 },
    { x: 0.9650, y: 0.9621 },
    { x: 0.9802, y: 0.9668 },
    { x: 0.9940, y: 0.9682 },
    { x: 0.9969, y: 0.9704 },
    { x: 0.9988, y: 0.9709 },
    { x: 0.9996, y: 0.9816 },
    { x: 0.9999, y: 0.9836 },
  ];

  const TEAM_GOALS_UNDER_AWAY_3_5_BLOCKS: { x: number; y: number }[] = [
    { x: 0.5959, y: 0.7885 },
    { x: 0.6344, y: 0.8197 },
    { x: 0.7056, y: 0.8312 },
    { x: 0.7526, y: 0.8710 },
    { x: 0.8167, y: 0.8845 },
    { x: 0.8604, y: 0.8977 },
    { x: 0.8907, y: 0.9206 },
    { x: 0.9105, y: 0.9286 },
    { x: 0.9207, y: 0.9286 },
    { x: 0.9410, y: 0.9374 },
    { x: 0.9532, y: 0.9392 },
    { x: 0.9624, y: 0.9467 },
    { x: 0.9688, y: 0.9515 },
    { x: 0.9760, y: 0.9566 },
    { x: 0.9816, y: 0.9614 },
    { x: 0.9834, y: 0.9638 },
    { x: 0.9866, y: 0.9695 },
    { x: 0.9917, y: 0.9736 },
    { x: 0.9950, y: 0.9765 },
    { x: 0.9955, y: 0.9769 },
    { x: 0.9974, y: 0.9814 },
    { x: 0.9993, y: 0.9866 },
    { x: 0.9997, y: 0.9882 },
    { x: 0.9998, y: 0.9882 },
    { x: 0.9999, y: 0.9883 },
    { x: 1.0000, y: 0.9947 },
  ];

  const combinedOver15Raw = totalOverProbability(lambdaHome, lambdaAway, 1.5);
  if (combinedOver15Raw >= TOTALS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(COMBINED_OVER_1_5_BLOCKS, combinedOver15Raw);
    if (calibrated >= GOALS_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'totals', selection: 'Over 1.5', trueProbability: calibrated, method: 'poisson-goals-isotonic' });
    }
  }

  const combinedUnder35Raw = 1 - totalOverProbability(lambdaHome, lambdaAway, 3.5);
  if (combinedUnder35Raw >= TOTALS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(COMBINED_UNDER_3_5_BLOCKS, combinedUnder35Raw);
    if (calibrated >= GOALS_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'totals', selection: 'Under 3.5', trueProbability: calibrated, method: 'poisson-goals-isotonic' });
    }
  }

  // Team-split goals — only 4 of 12 tested combos cleared 70%: Home/Away
  // Over 0.5, Home/Away Under 2.5 or 3.5 (whichever, if either, clears
  // both floors — picking the LOWEST qualifying line, the more specific/
  // stronger claim, mirroring how Over markets elsewhere pick the
  // HIGHEST qualifying line for the same "strongest surviving claim"
  // reason).
  const homeOver05Raw = singleOverProbabilityPoisson(lambdaHome, 0.5);
  if (homeOver05Raw >= TOTALS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(TEAM_GOALS_OVER_HOME_0_5_BLOCKS, homeOver05Raw);
    if (calibrated >= GOALS_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'team_goals_over', selection: 'Home Over 0.5', trueProbability: calibrated, method: 'poisson-team-goals-over-isotonic' });
    }
  }

  const awayOver05Raw = singleOverProbabilityPoisson(lambdaAway, 0.5);
  if (awayOver05Raw >= TOTALS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(TEAM_GOALS_OVER_AWAY_0_5_BLOCKS, awayOver05Raw);
    if (calibrated >= GOALS_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'team_goals_over', selection: 'Away Over 0.5', trueProbability: calibrated, method: 'poisson-team-goals-over-isotonic' });
    }
  }

  const TEAM_GOALS_UNDER_LINES = [2.5, 3.5];

  function bestTeamGoalsUnderLine(
    mean: number,
    blocksFor: (line: number) => { x: number; y: number }[]
  ): { line: number; calibrated: number } | null {
    const candidates = TEAM_GOALS_UNDER_LINES.map((line) => {
      const rawProb = 1 - singleOverProbabilityPoisson(mean, line);
      const calibrated = rawProb >= TOTALS_MIN_CONFIDENCE ? isotonicLookup(blocksFor(line), rawProb) : -1;
      return { line, rawProb, calibrated };
    });

    const clearingBoth = candidates.filter((c) => c.rawProb >= TOTALS_MIN_CONFIDENCE && c.calibrated >= GOALS_MIN_TIP_CONFIDENCE);
    if (!clearingBoth.length) return null;

    return clearingBoth.reduce((a, b) => (b.line < a.line ? b : a));
  }

  const homeUnderBest = bestTeamGoalsUnderLine(lambdaHome, (line) => (line === 2.5 ? TEAM_GOALS_UNDER_HOME_2_5_BLOCKS : TEAM_GOALS_UNDER_HOME_3_5_BLOCKS));
  if (homeUnderBest) {
    results.push({ market: 'team_goals_under', selection: `Home Under ${homeUnderBest.line}`, trueProbability: homeUnderBest.calibrated, method: 'poisson-team-goals-under-isotonic' });
  }

  const awayUnderBest = bestTeamGoalsUnderLine(lambdaAway, (line) => (line === 2.5 ? TEAM_GOALS_UNDER_AWAY_2_5_BLOCKS : TEAM_GOALS_UNDER_AWAY_3_5_BLOCKS));
  if (awayUnderBest) {
    results.push({ market: 'team_goals_under', selection: `Away Under ${awayUnderBest.line}`, trueProbability: awayUnderBest.calibrated, method: 'poisson-team-goals-under-isotonic' });
  }


  const HANDICAP_LINES = [-1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5];
  const dist = marginDistribution(lambdaHome, lambdaAway);

  for (const line of HANDICAP_LINES) {
    const homeCoverProb = handicapCoverProbability(dist, line);
    results.push(
      { market: 'handicap', selection: `Home ${line >= 0 ? '+' : ''}${line}`, trueProbability: homeCoverProb, method: 'poisson-margin' },
      { market: 'handicap', selection: `Away ${-line >= 0 ? '+' : ''}${-line}`, trueProbability: 1 - homeCoverProb, method: 'poisson-margin' },
    );
  }

  const pHomeScores = 1 - poissonPmf(lambdaHome, 0);
  const pAwayScores = 1 - poissonPmf(lambdaAway, 0);
  const bttsYes = pHomeScores * pAwayScores;
  results.push(
    { market: 'btts', selection: 'Yes', trueProbability: bttsYes, method: 'poisson' },
    { market: 'btts', selection: 'No', trueProbability: 1 - bttsYes, method: 'poisson' },
  );

  const cornersTip = modelFootballCorners(stats);
  if (cornersTip) results.push(cornersTip);

  const cornersWinnerTip = modelFootballCornersWinner(stats);
  if (cornersWinnerTip) results.push(...cornersWinnerTip);

  const teamCornersOverTip = modelFootballTeamCornersOver(stats);
  if (teamCornersOverTip) results.push(...teamCornersOverTip);

  const cardsTip = modelFootballCards(stats);
  if (cardsTip) results.push(cardsTip);

  const sotTip = modelFootballShotsOnTarget(stats);
  if (sotTip) results.push(sotTip);

  const teamCardsOverTip = modelFootballTeamCardsOver(stats);
  if (teamCardsOverTip) results.push(...teamCardsOverTip);

  const teamSotOverTip = modelFootballTeamSotOver(stats);
  if (teamSotOverTip) results.push(...teamSotOverTip);

  return results;
}

// ─── TENNIS ISOTONIC ────────────────────────────────────────────────
// Fitted on pooled 2021-2024 backtest, 9,310 predictions — verified good,
// unmodified.
const TENNIS_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5000, y: 0.3333 },
  { x: 0.5004, y: 0.3770 },
  { x: 0.5008, y: 0.4444 },
  { x: 0.5042, y: 0.4856 },
  { x: 0.5117, y: 0.5102 },
  { x: 0.5200, y: 0.5321 },
  { x: 0.5247, y: 0.5435 },
  { x: 0.5267, y: 0.5627 },
  { x: 0.5339, y: 0.5667 },
  { x: 0.5423, y: 0.5742 },
  { x: 0.5568, y: 0.6142 },
  { x: 0.5761, y: 0.6295 },
  { x: 0.6028, y: 0.6510 },
  { x: 0.6285, y: 0.6757 },
  { x: 0.6305, y: 0.6757 },
  { x: 0.6370, y: 0.6854 },
  { x: 0.6648, y: 0.6999 },
  { x: 0.6956, y: 0.7115 },
  { x: 0.7237, y: 0.7234 },
  { x: 0.7614, y: 0.7391 },
  { x: 0.8195, y: 0.7419 },
];

function applyTennisIsotonicCalibration(rawProb: number): number {
  const blocks = TENNIS_ISOTONIC_BLOCKS;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function modelTennis(input: ModelInput): MarketProbability[] {
  const { stats } = input;
  const results: MarketProbability[] = [];

  const surface = (stats.additionalContext?.surfaceType as string | undefined)?.toLowerCase() || 'hard';

  let homeWinProb = h2hWinRate(stats.h2h, 'home') * 0.4 + formWinRate(stats.homeForm) * 0.6;

  const homeSurfaceSpec = stats.additionalContext?.homeSurfaceSpecialist as string | undefined;
  const awaySurfaceSpec = stats.additionalContext?.awaySurfaceSpecialist as string | undefined;

  let surfaceAdj = 0;
  if (homeSurfaceSpec === surface) surfaceAdj += 0.05;
  if (awaySurfaceSpec === surface) surfaceAdj -= 0.05;
  if (surface === 'grass') surfaceAdj *= 1.2;
  if (surface === 'carpet') surfaceAdj *= 0.5;

  homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb + surfaceAdj));

  const fatigue = stats.situational?.fatigueDays;
  if (fatigue !== undefined && fatigue < 2) {
    const homeFatigued = stats.additionalContext?.homeFatigue as boolean | undefined;
    if (homeFatigued) homeWinProb = Math.max(0.05, homeWinProb - 0.07);
    else homeWinProb = Math.min(0.95, homeWinProb + 0.07);
  }

  const weather = stats.situational?.weather?.toLowerCase() || '';
  if (weather.includes('wind')) {
    const homeServerDominant = stats.additionalContext?.homeServeDominant as boolean | undefined;
    const awayServerDominant = stats.additionalContext?.awayServeDominant as boolean | undefined;
    if (homeServerDominant) homeWinProb -= 0.04;
    if (awayServerDominant) homeWinProb += 0.04;
  }

  homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb));

  let cappedHomeProb: number;
  let cappedAwayProb: number;
  if (homeWinProb >= 0.5) {
    cappedHomeProb = applyTennisIsotonicCalibration(homeWinProb);
    cappedAwayProb = 1 - cappedHomeProb;
  } else {
    cappedAwayProb = applyTennisIsotonicCalibration(1 - homeWinProb);
    cappedHomeProb = 1 - cappedAwayProb;
  }

  results.push(
    { market: 'moneyline', selection: input.match.homeTeam, trueProbability: cappedHomeProb, method: 'elo+surface+isotonic' },
    { market: 'moneyline', selection: input.match.awayTeam, trueProbability: cappedAwayProb, method: 'elo+surface+isotonic' },
  );
  return results;
}

// ─── BASKETBALL ISOTONIC (WNBA) ──────────────────────────────
// Fitted on pooled 2021-2024 WNBA backtest, 936 predictions — verified
// good, unmodified. Fit AFTER the home-court advantage fix was applied.
const BASKETBALL_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5189, y: 0.5725 },
  { x: 0.5480, y: 0.5821 },
  { x: 0.5880, y: 0.6378 },
  { x: 0.6205, y: 0.6429 },
  { x: 0.6351, y: 0.6548 },
  { x: 0.6765, y: 0.6648 },
  { x: 0.7136, y: 0.6923 },
  { x: 0.7627, y: 0.7541 },
  { x: 0.8268, y: 0.7778 },
  { x: 0.8349, y: 0.8000 },
  { x: 0.8685, y: 0.8750 },
];

// ─── NBA ISOTONIC ─────────────────────────────────────────────
// Fitted via nbaIsotonicFit.ts on pooled 2016-2026 NBA seasons (Kaggle
// Games.csv, moneyline only), 14,083 predictions, run while this branch
// was still a raw passthrough — so this is a clean fit against true raw
// elo+homecourt output, not a previous fit's mistakes. Reliable range:
// x=0.5022-0.9482 (33 blocks, min weight 30 games each). Values outside
// this range are clamped to the nearest edge, not extrapolated — so
// calibrated NBA moneyline probability will never exceed ~0.9231.
// REFIT (see conversation): re-fit against the decay-weighted
// basketballDecayWinRate formula (0.85^i, full season — replaces the old
// flat-10-game average). 14,083 predictions, real NBA seasons via
// Games.csv. Calibrated-vs-actual gaps under 1pp at every band — a
// tight, trustworthy fit. Reliable range: x=0.5002-0.9231 (18 blocks,
// min weight 30 games, 1 low-end noisy block excluded). NOTE: raw
// confidence ceiling is meaningfully LOWER than the old flat-average
// table's (old topped calibrated ~0.92 near x=0.95; this one tops
// calibrated ~0.76 near x=0.92) — decay-weighted history alone doesn't
// let raw confidence run as hot as flat averaging did; the tight
// calibration confirms this lower ceiling is correct, not an error.
const NBA_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5002, y: 0.4118 },
  { x: 0.5047, y: 0.4939 },
  { x: 0.5231, y: 0.5054 },
  { x: 0.5421, y: 0.5091 },
  { x: 0.5486, y: 0.5109 },
  { x: 0.5594, y: 0.5247 },
  { x: 0.5862, y: 0.5287 },
  { x: 0.5935, y: 0.5393 },
  { x: 0.6468, y: 0.5649 },
  { x: 0.6687, y: 0.5804 },
  { x: 0.6874, y: 0.5895 },
  { x: 0.7310, y: 0.6238 },
  { x: 0.7513, y: 0.6471 },
  { x: 0.7762, y: 0.6503 },
  { x: 0.7963, y: 0.6812 },
  { x: 0.8206, y: 0.7099 },
  { x: 0.9175, y: 0.7333 },
  { x: 0.9231, y: 0.7624 },
];

// ─── PROBALLERS ISOTONIC (24 INTERNATIONAL LEAGUES) ─────────────────
// Fitted via proballersIsotonicFit.ts on 2026-09-06, pooled across 24
// Proballers international leagues (all leagues in PROBALLERS_LEAGUE_MAP
// except Argentina/Puerto Rico/Australia/Philippines — see
// EXCLUDED_LEAGUES in that script for why each was dropped), walk-forward
// no-lookahead predictions using the exact elo+HOME_COURT_ADVANTAGE
// formula that ships in modelBasketball below, 21,359 pooled predictions.
// Built because these 20 leagues were previously falling through to
// BASKETBALL_ISOTONIC_BLOCKS above (a WNBA-only fit, 936 predictions) —
// confirmed via conversation that no Proballers-specific table was ever
// actually wired into applyBasketballIsotonicCalibration despite the fit
// script existing; this is that missing wiring.
// Before/after check confirmed real, if modest, overconfidence being
// corrected — e.g. raw 83.6% average in the 80-90% band vs 87.1% real
// hit rate at that band once calibrated (the corrected number sits
// closer to actual than raw does, in the direction of raw
// UNDERclaiming here, not overclaiming — worth noting since most of this
// file's other calibrations correct overconfidence, not underconfidence).
// Reliable range: x=0.5005-0.9057 (36 blocks, min weight 30 games,
// 1 low-end + 28 high-end noisy blocks excluded — the high end is
// thinner here than NBA's, so treat 90%+ confidence on these leagues
// with more caution than the same number would warrant on NBA).
// REFIT (see conversation, 2026-09-25): re-fit after two separate real
// fixes landed together — (1) decay-weighted win rate replacing flat
// averaging (basketballDecayWinRate, matches NBA's same-day refit), and
// (2) a genuine markup break in Proballersscraper.ts itself: the schedule
// page's itemtype attribute changed from http:// to https:// (silently
// matching ZERO rows), and the visible startDate text was replaced by an
// unreliable <meta> content attribute (observed showing a 2026 date on a
// 2024-season row) — real date now read from the row's own <td> text
// instead. 17,745 pooled predictions across ~20 leagues (post-exclusion
// of Philippines/Argentina/Puerto Rico/Australia). Calibrated-vs-actual
// gaps under 1pp at every band, including a real 90%+ band (274 games,
// 93.0% calibrated vs 93.1% actual) — a tight, trustworthy fit. Reliable
// range: x=0.5027-0.9451 (33 blocks, min weight 10, 2 low-end + 34
// high-end noisy blocks excluded).
const PROBALLERS_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5027, y: 0.5057 },
  { x: 0.5156, y: 0.5208 },
  { x: 0.5301, y: 0.5267 },
  { x: 0.5354, y: 0.5437 },
  { x: 0.5373, y: 0.5455 },
  { x: 0.5458, y: 0.5506 },
  { x: 0.5544, y: 0.5714 },
  { x: 0.5635, y: 0.5930 },
  { x: 0.5730, y: 0.6000 },
  { x: 0.5807, y: 0.6046 },
  { x: 0.5966, y: 0.6063 },
  { x: 0.6051, y: 0.6167 },
  { x: 0.6153, y: 0.6246 },
  { x: 0.6284, y: 0.6472 },
  { x: 0.6393, y: 0.6564 },
  { x: 0.6514, y: 0.6698 },
  { x: 0.6639, y: 0.6850 },
  { x: 0.6755, y: 0.7004 },
  { x: 0.6809, y: 0.7085 },
  { x: 0.6900, y: 0.7168 },
  { x: 0.6971, y: 0.7326 },
  { x: 0.7195, y: 0.7393 },
  { x: 0.7620, y: 0.7554 },
  { x: 0.7821, y: 0.7949 },
  { x: 0.7871, y: 0.8118 },
  { x: 0.7930, y: 0.8228 },
  { x: 0.8015, y: 0.8444 },
  { x: 0.8177, y: 0.8535 },
  { x: 0.8347, y: 0.8538 },
  { x: 0.8551, y: 0.8730 },
  { x: 0.8797, y: 0.8809 },
  { x: 0.9072, y: 0.9158 },
  { x: 0.9451, y: 0.9397 },
];

function applyBasketballIsotonicCalibration(rawProb: number, league?: string): number {
  const normalizedLeague = league?.toLowerCase();
  const isNba = normalizedLeague === 'nba';
  const isWnba = normalizedLeague === 'wnba';
  // Any non-NBA, non-WNBA league (i.e. one of the 20+ Proballers
  // international leagues) now routes to its own fit — see
  // PROBALLERS_ISOTONIC_BLOCKS comment above for why this branch exists
  // and what it replaces.
  const blocks = isNba ? NBA_ISOTONIC_BLOCKS : isWnba ? BASKETBALL_ISOTONIC_BLOCKS : PROBALLERS_ISOTONIC_BLOCKS;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

// ─── NBA TOTALS ISOTONIC ─────────────────────────────────────────
// Fitted via nbaTotalsIsotonicFit.ts on pooled 2016-2026 NBA seasons
// (Kaggle Games.csv), 14,083 predictions, AFTER the constant-0.6462 bug
// was fixed (real rolling homePpgFor/awayPpgFor/homePpgAgainst/
// awayPpgAgainst populated per game). Fixed line 225.5 used throughout —
// see caveat in nbaTotalsIsotonicFit.ts: this evaluates "how accurate is
// the model's confidence against a fixed 225.5 line", not against
// whatever line is actually posted on a given night, since Games.csv has
// no historical odds. Treat as a first-pass correction, not a
// production-grade fit against real market lines. Reliable range:
// x=0.5047-0.9977 (36 blocks, low-end/high-end noisy blocks excluded).
//
// WNBA totals has NO calibration yet — see applyBasketballTotalsIsotonicCalibration,
// which passes WNBA raw probability straight through until an equivalent
// WNBA fit (wnbaTotalsIsotonicFit.ts) is built and wired in here.
//
// NOTE: Proballers international leagues' totals also fall through to
// the WNBA branch below (isNba check only, same as before this
// conversation's moneyline fix) — the proballersIsotonicFit.ts fit that
// produced PROBALLERS_ISOTONIC_BLOCKS above was MONEYLINE ONLY (see that
// script's predictMoneyline-based generateRawPredictionsForLeague). No
// totals fit exists for these leagues yet, and the 174.5 default line
// extractTotalLine falls back to is a WNBA-specific number — likely
// wrong for most Proballers leagues' real scoring totals. Treat any
// Proballers 'totals' tip as unvalidated until a dedicated fit (and a
// realistic per-league default line) exists.
const NBA_TOTALS_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5047, y: 0.4835 },
  { x: 0.5083, y: 0.5000 },
  { x: 0.5096, y: 0.5000 },
  { x: 0.5155, y: 0.5170 },
  { x: 0.5432, y: 0.5262 },
  { x: 0.5783, y: 0.5499 },
  { x: 0.6034, y: 0.5663 },
  { x: 0.6240, y: 0.5781 },
  { x: 0.6379, y: 0.5843 },
  { x: 0.6414, y: 0.5844 },
  { x: 0.6478, y: 0.5905 },
  { x: 0.6632, y: 0.6065 },
  { x: 0.6850, y: 0.6180 },
  { x: 0.6993, y: 0.6400 },
  { x: 0.7380, y: 0.6509 },
  { x: 0.7819, y: 0.6932 },
  { x: 0.8024, y: 0.7025 },
  { x: 0.8255, y: 0.7040 },
  { x: 0.8331, y: 0.7143 },
  { x: 0.8389, y: 0.7326 },
  { x: 0.8509, y: 0.7436 },
  { x: 0.8644, y: 0.7565 },
  { x: 0.8845, y: 0.7727 },
  { x: 0.9007, y: 0.7815 },
  { x: 0.9101, y: 0.8203 },
  { x: 0.9206, y: 0.8261 },
  { x: 0.9263, y: 0.8293 },
  { x: 0.9285, y: 0.8421 },
  { x: 0.9389, y: 0.8433 },
  { x: 0.9496, y: 0.8542 },
  { x: 0.9588, y: 0.8578 },
  { x: 0.9695, y: 0.8835 },
  { x: 0.9788, y: 0.9158 },
  { x: 0.9892, y: 0.9202 },
  { x: 0.9942, y: 0.9510 },
  { x: 0.9977, y: 0.9796 },
];

// Fitted via scripts/wnbaTotalsIsotonicFit.ts on real WNBA game logs
// (stats.wnba.com, seasons 2022-2026, 1,147 predictions) on 2026-08-02.
// Uses fixed line 174.5 — confirmed against a real bookie main line
// (Over 174.5 @ 1.22) and matching the real 2026 season average total
// exactly. An earlier fit using 183.5 (a rough, unverified estimate) was
// discarded — 183.5 sat ~9-17 points above the real distribution, which
// skewed raw model confidence hard toward "Under" on 95% of games
// (not real predictive skill, just an unrealistically high bar). This
// fit's calibrated averages track actual hit rates closely across every
// confidence band. Reliable range: x=0.5330-0.9412 (9 blocks, low-end/
// high-end noisy blocks excluded).
// Refitted via scripts/wnbaTotalsIsotonicFit.ts on 2026-08-02, AFTER
// fixing a real bug in ABBREV_TO_NAME (wnbaScraper.ts and this fit
// script both had it wrong): stats.wnba.com uses PHX/LAS/PDX, not the
// previously-mapped PHO/LA/POR. The old map silently filed Phoenix
// Mercury, LA Sparks, and Portland Fire's 2025/2026 games under raw,
// unmapped abbreviation strings instead of their real names — LA Sparks
// and Portland Fire had ZERO usable data for those seasons as a result,
// and Phoenix Mercury's data was stuck ~682 days stale. This refit uses
// the corrected 1,149-prediction dataset with all three teams properly
// included. Reliable range: x=0.6205-0.8032 (7 blocks, narrower than the
// prior buggy fit's 0.53-0.94 range — the old wider range was partly an
// artifact of the incomplete/wrong underlying data, not real signal).
const WNBA_TOTALS_ISOTONIC_BLOCKS: { x: number; y: number }[] | null = [
  { x: 0.6205, y: 0.6262 },
  { x: 0.6370, y: 0.6364 },
  { x: 0.6503, y: 0.6471 },
  { x: 0.7126, y: 0.7115 },
  { x: 0.7339, y: 0.7419 },
  { x: 0.7719, y: 0.7783 },
  { x: 0.8032, y: 0.8078 },
];

function applyBasketballTotalsIsotonicCalibration(rawProb: number, league?: string): number {
  const isNba = league?.toLowerCase() === 'nba';
  const blocks = isNba ? NBA_TOTALS_ISOTONIC_BLOCKS : WNBA_TOTALS_ISOTONIC_BLOCKS;

  // No calibration table available for this league yet (currently WNBA,
  // and — see NOTE above PROBALLERS_ISOTONIC_BLOCKS's introduction —
  // also every Proballers league, which has no totals fit at all) —
  // pass through raw. This is explicit, not a silent gap: callers can see
  // exactly why WNBA/Proballers totals confidence is uncalibrated by
  // reading this.
  if (!blocks) return rawProb;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

// Proballers leagues cleared for game-total tips (held-out backtest,
// scripts/totalsWiredBacktest.ts). Average from scripts/leagueTotals.ts.
// Other Proballers leagues emit NO totals tip.
const PROBALLERS_TOTALS_LEAGUES: Record<string, { avg: number }> = {
  'CBA - China': { avg: 198.8 },
  'ACB - Spain': { avg: 168.4 },
  'A League - Serbia': { avg: 168 },
  'A1 - Greece': { avg: 160.3 },
  'Betclic Elite - France': { avg: 166.1 },
  'Basketligan - Sweden': { avg: 169.4 },
  'Liga Profissional - Portugal': { avg: 162.7 },
  'Ligaen - Denmark': { avg: 170.7 },
};
const PROBALLERS_TOTALS_MIN_CONF = 0.75;

function modelBasketball(input: ModelInput): MarketProbability[] {
  const { stats, odds } = input;
  const results: MarketProbability[] = [];

  const league = input.match.league || (stats.additionalContext?.league as string) || 'wnba';
  const normalizedLeague = league.toLowerCase();
  const isNba = normalizedLeague === 'nba';
  const isWnba = normalizedLeague === 'wnba';

  // BASKETBALL-SPECIFIC decay-weighted win rate (see conversation) — NOT
  // the shared formWinRate() every other sport uses, since that function
  // is shared cross-sport (football/tennis/hockey/baseball all call it)
  // and changing it would silently affect their already-calibrated
  // behavior. This applies the same 0.85^i decay pattern (i = games back
  // from most recent) as football's weightedGoalsAvg, replacing a flat
  // average. Backtested against NBA's real Games.csv history: 62.09% vs
  // 61.98% overall hit rate, and meaningfully tighter band calibration
  // at the 75%+ confidence band (80.4% actual vs 77.6% under flat
  // averaging) — a real, if modest, improvement, not a guess.
  //
  // stats.homeForm/awayForm must be sorted most-recent-first for this to
  // work correctly — true for both NBA (nbaScraper.ts's buildForm) and
  // Proballers (Proballersscraper.ts's buildTeamForm), confirmed via
  // direct inspection.
  function basketballDecayWinRate(form: FormRecord[]): number {
    if (!form.length) return 0.5;
    let weightSum = 0, valueSum = 0;
    form.forEach((f, i) => {
      const w = Math.pow(0.85, i);
      valueSum += (f.result === 'W' ? 1 : 0) * w;
      weightSum += w;
    });
    return valueSum / weightSum;
  }

  const homeWR = basketballDecayWinRate(stats.homeForm);
  const awayWR = basketballDecayWinRate(stats.awayForm);
  const h2hHWR = h2hWinRate(stats.h2h, 'home');
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);

  // Historical NBA/WNBA home teams win roughly 53-55% of games even in an
  // otherwise even matchup — backtest confirmed the base elo formula alone
  // had no home-court term. Set so eloHome = 0.5 -> homeWinProb = 0.54.
  // Same constant reused for Proballers leagues (proballersIsotonicFit.ts
  // fit against this exact value — see PROBALLERS_ISOTONIC_BLOCKS comment
  // above — so this is the confirmed-correct value for those leagues too,
  // not just an assumption carried over from NBA/WNBA).
  const HOME_COURT_ADVANTAGE = 0.075;
  let homeWinProb = eloHome * 0.85 + 0.04 + HOME_COURT_ADVANTAGE;

  const fatigue = stats.situational?.fatigueDays;
  if (fatigue !== undefined && fatigue < 2) {
    const homeFatigued = stats.additionalContext?.homeFatigue as boolean | undefined;
    if (homeFatigued) homeWinProb -= 0.08;
    else homeWinProb += 0.08;
  }

  homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb));

  // Calibrate only the FAVORITE side, then derive the other side as its
  // complement — calibrating both sides independently would break the
  // invariant that the two outcomes sum to 1, which downstream edge/EV
  // calculations rely on.
  let calibratedHomeProb: number;
  let calibratedAwayProb: number;
  if (homeWinProb >= 0.5) {
    calibratedHomeProb = applyBasketballIsotonicCalibration(homeWinProb, league);
    calibratedAwayProb = 1 - calibratedHomeProb;
  } else {
    calibratedAwayProb = applyBasketballIsotonicCalibration(1 - homeWinProb, league);
    calibratedHomeProb = 1 - calibratedAwayProb;
  }

  // Method label now distinguishes all three calibration paths — useful
  // for verifying which table actually fired on a given tip, the same
  // way NBA's '-nba' suffix already let that league be checked separately.
  // MARGIN MODEL (non-NBA, non-WNBA Proballers leagues only).
  // Decayed point-margin difference, scaled by avg points per team-game.
  // Fitted/held-out validated via scripts/marginIsotonicFit.ts (held-out
  // Brier 0.1940, isotonic added nothing, so no PAVA table here).
  // Falls through to the old path if either team has < 5 games.
  let marginHomeProb: number | null = null;
  if (!isNba && !isWnba) {
    const usable = (f: FormRecord[]) => f.filter(r => r.goalsFor !== undefined && r.goalsAgainst !== undefined);
    const hf = usable(stats.homeForm);
    const af = usable(stats.awayForm);
    if (hf.length >= 5 && af.length >= 5) {
      const decMargin = (f: FormRecord[]) => {
        let w = 0, s = 0, k = 1;
        for (const r of f) { s += (r.goalsFor! - r.goalsAgainst!) * k; w += k; k *= 0.85; }
        return w ? s / w : 0;
      };
      const avgTot = (f: FormRecord[]) => f.reduce((s, r) => s + (r.goalsFor! + r.goalsAgainst!) / 2, 0) / f.length;
      const scale = (avgTot(hf) + avgTot(af)) / 2;
      if (scale > 0) {
        const m = ((decMargin(hf) - decMargin(af)) / scale) * 100;
        marginHomeProb = Math.max(0.05, Math.min(0.95, 1 / (1 + Math.exp(-(0.46818 + 0.08169 * m)))));
      }
    }
  }
  if (marginHomeProb !== null) {
    calibratedHomeProb = marginHomeProb;
    calibratedAwayProb = 1 - marginHomeProb;
  }

  const moneylineMethod = isNba
    ? 'elo+homecourt+isotonic-nba'
    : isWnba
      ? 'elo+homecourt+isotonic-wnba'
      : marginHomeProb !== null
        ? 'margin-proballers'
        : 'elo+homecourt+isotonic-proballers';

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: calibratedHomeProb, method: moneylineMethod },
    { market: 'moneyline', selection: 'Away', trueProbability: calibratedAwayProb, method: moneylineMethod },
  );

  const homeOffAvg = (stats.additionalContext?.homePpgFor as number | undefined) ?? (isNba ? 115 : 80);
  const awayOffAvg = (stats.additionalContext?.awayPpgFor as number | undefined) ?? (isNba ? 115 : 80);
  const homeDefAvg = (stats.additionalContext?.homePpgAgainst as number | undefined) ?? (isNba ? 115 : 80);
  const awayDefAvg = (stats.additionalContext?.awayPpgAgainst as number | undefined) ?? (isNba ? 115 : 80);

  const pace = (stats.additionalContext?.pace as number | undefined) || 100;
  const paceMultiplier = pace / 100;
  const expectedTotal = ((homeOffAvg + awayDefAvg) / 2 + (awayOffAvg + homeDefAvg) / 2) * paceMultiplier;

  let foulAdj = 1.0;
  if (stats.referee?.avgFouls) {
    if (stats.referee.avgFouls > 50) foulAdj = 1.04;
    if (stats.referee.avgFouls < 35) foulAdj = 1.03;
  }
  const adjustedTotal = expectedTotal * foulAdj;

  // WNBA default updated 2 Aug 2026 from stale 165.5 to 183.5, based on
  // real observed book lines ranging ~171.5-197.5 depending on matchup
  // (165.5 was not within the real range at all — every live WNBA totals
  // tip was being compared against a bar roughly 10+ points below any
  // real market line, which is why raw confidence was showing up
  // implausibly high: clearing a too-low bar looks easy). 183.5 is a
  // rough central estimate, not a per-matchup line — real totals still
  // vary ~171.5-197.5 by team pace/style, so this remains an imperfect
  // fallback for any single game. Revisit if real book lines drift
  // further from this range.
  //
  // NOTE: this same fallback (174.5, see extractTotalLine call below) is
  // now also reached by every Proballers league when no real totals odds
  // exist for a match — that number was tuned for WNBA specifically and
  // has not been checked against international league scoring totals.
  // Treat Proballers 'totals' tips as unvalidated until a real per-league
  // default (and ideally a dedicated fit) exists — see the NOTE above
  // NBA_TOTALS_ISOTONIC_BLOCKS for the matching caveat on the calibration
  // side of this same gap.
  const leagueTot = (!isNba && !isWnba) ? PROBALLERS_TOTALS_LEAGUES[league] : undefined;
  const totalLine = extractTotalLine(odds, 'totals', isNba ? 225.5 : leagueTot ? Math.round(leagueTot.avg * 2) / 2 : 174.5);
  const sd = isNba ? 12 : leagueTot ? leagueTot.avg * 0.1054 : 10;
  const expForZ = leagueTot ? leagueTot.avg + 1.092 * (adjustedTotal - leagueTot.avg) : adjustedTotal;
  const z = (totalLine - expForZ) / sd;
  const rawOverProb = 1 - normalCdf(z);

  // Calibrate whichever side (Over/Under) is favored, then derive the
  // other side as its complement — same invariant-preserving approach as
  // moneyline above. Previously this branch had NO calibration at all
  // (raw normalCdf output went straight to trueProbability); see
  // NBA_TOTALS_ISOTONIC_BLOCKS comment above for the backtest that
  // justified adding this.
  let overProb: number;
  if (rawOverProb >= 0.5) {
    overProb = applyBasketballTotalsIsotonicCalibration(rawOverProb, league);
  } else {
    overProb = 1 - applyBasketballTotalsIsotonicCalibration(1 - rawOverProb, league);
  }

  const totalsMethod = isNba ? 'ppg+pace+normal+isotonic-nba' : leagueTot ? 'ppg+league-avg+normal' : 'ppg+pace+normal';

  if (!isNba && !isWnba) {
    // Proballers: whitelisted leagues only, one side, 0.75 floor, else nothing.
    const enough = stats.homeForm.length >= 5 && stats.awayForm.length >= 5;
    if (leagueTot && enough) {
      if (overProb >= PROBALLERS_TOTALS_MIN_CONF) {
        results.push({ market: 'totals', selection: `Over ${totalLine}`, trueProbability: overProb, method: totalsMethod, rawExpectedTotal: adjustedTotal });
      } else if ((1 - overProb) >= PROBALLERS_TOTALS_MIN_CONF) {
        results.push({ market: 'totals', selection: `Under ${totalLine}`, trueProbability: 1 - overProb, method: totalsMethod, rawExpectedTotal: adjustedTotal });
      }
    }
  } else if (overProb >= TOTALS_MIN_CONFIDENCE) {
    results.push({ market: 'totals', selection: `Over ${totalLine}`, trueProbability: overProb, method: totalsMethod, rawExpectedTotal: adjustedTotal });
  } else if ((1 - overProb) >= TOTALS_MIN_CONFIDENCE) {
    results.push({ market: 'totals', selection: `Under ${totalLine}`, trueProbability: 1 - overProb, method: totalsMethod, rawExpectedTotal: adjustedTotal });
  } else {
    results.push(
      { market: 'totals', selection: `Over ${totalLine}`, trueProbability: overProb, method: totalsMethod, rawExpectedTotal: adjustedTotal },
      { market: 'totals', selection: `Under ${totalLine}`, trueProbability: 1 - overProb, method: totalsMethod, rawExpectedTotal: adjustedTotal },
    );
  }

  // ─── TEAM-SPLIT TOTALS (NBA only) ──────────────────────────────────
  // Fitted via scripts/nbaTeamTotalsBacktest.ts + nbaTeamTotalsIsotonicFit.ts
  // on pooled Games.csv seasons — 11 of 28 tested (side, line, direction)
  // combos cleared 70% real hit rate. Splits this function's OWN
  // combined-total formula into its two halves:
  //   homeExpected = ((homeOffAvg + awayDefAvg) / 2) * paceMultiplier
  //   awayExpected = ((awayOffAvg + homeDefAvg) / 2) * paceMultiplier
  // (these sum back to expectedTotal above) — not a separate model.
  // Backtest used sd = 12/sqrt(2) ≈ 8.49 for one team alone (combined
  // total's sd=12, assuming rough independence) — a starting estimate;
  // the isotonic fit below absorbs whatever bias this introduces, same
  // as every other raw-formula imperfection handled this session.
  // Proballers/WNBA explicitly excluded (isNba only) — not backtested
  // for those leagues, would need its own separate fit given each
  // league gets its own calibration table already.
  // PROBALLERS TEAM EXPECTED POINTS (free path, no line, no calibration).
  // Unvalidated by design: reports the model's expected points only.
  if (!isNba && !isWnba && stats.homeForm.length >= 5 && stats.awayForm.length >= 5) {
    const homeExp = ((homeOffAvg + awayDefAvg) / 2) * paceMultiplier;
    const awayExp = ((awayOffAvg + homeDefAvg) / 2) * paceMultiplier;
    results.push(
      { market: 'team_points_expected', selection: 'Home', trueProbability: 0.5, method: 'ppg-expected-free', rawExpectedTotal: homeExp },
      { market: 'team_points_expected', selection: 'Away', trueProbability: 0.5, method: 'ppg-expected-free', rawExpectedTotal: awayExp },
    );
  }

  if (isNba) {
    const homeExpected = ((homeOffAvg + awayDefAvg) / 2) * paceMultiplier;
    const awayExpected = ((awayOffAvg + homeDefAvg) / 2) * paceMultiplier;
    const NBA_TEAM_TOTALS_SD = 12 / Math.sqrt(2);
    const TEAM_TOTALS_MIN_TIP_CONFIDENCE = 0.70;

    const HOME_OVER_95_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.6054, y: 0.5641 }, { x: 0.6483, y: 0.6800 }, { x: 0.6650, y: 0.6905 }, { x: 0.6950, y: 0.7079 }, { x: 0.7171, y: 0.7143 }, { x: 0.7322, y: 0.7313 }, { x: 0.7730, y: 0.7342 }, { x: 0.7993, y: 0.7579 }, { x: 0.8250, y: 0.7847 }, { x: 0.8471, y: 0.7962 }, { x: 0.8515, y: 0.8000 }, { x: 0.8527, y: 0.8140 }, { x: 0.8694, y: 0.8275 }, { x: 0.8867, y: 0.8412 }, { x: 0.8930, y: 0.8525 }, { x: 0.9042, y: 0.8535 }, { x: 0.9145, y: 0.8870 }, { x: 0.9312, y: 0.8902 }, { x: 0.9467, y: 0.9006 }, { x: 0.9584, y: 0.9098 }, { x: 0.9678, y: 0.9167 }, { x: 0.9736, y: 0.9403 }, { x: 0.9777, y: 0.9412 }, { x: 0.9808, y: 0.9428 }, { x: 0.9842, y: 0.9440 }, { x: 0.9860, y: 0.9543 }, { x: 0.9912, y: 0.9681 }, { x: 0.9956, y: 0.9793 }, { x: 0.9972, y: 0.9824 }, { x: 0.9987, y: 0.9890 }, { x: 0.9993, y: 0.9910 },
    ];
    const HOME_OVER_100_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5604, y: 0.5630 }, { x: 0.5809, y: 0.5714 }, { x: 0.5885, y: 0.5965 }, { x: 0.5955, y: 0.6000 }, { x: 0.6364, y: 0.6091 }, { x: 0.6719, y: 0.6296 }, { x: 0.6743, y: 0.6552 }, { x: 0.6771, y: 0.6667 }, { x: 0.7030, y: 0.6927 }, { x: 0.7283, y: 0.7054 }, { x: 0.7572, y: 0.7300 }, { x: 0.7886, y: 0.7574 }, { x: 0.8023, y: 0.7591 }, { x: 0.8081, y: 0.7857 }, { x: 0.8308, y: 0.7894 }, { x: 0.8525, y: 0.8000 }, { x: 0.8539, y: 0.8036 }, { x: 0.8651, y: 0.8237 }, { x: 0.8837, y: 0.8266 }, { x: 0.8952, y: 0.8421 }, { x: 0.8998, y: 0.8505 }, { x: 0.9133, y: 0.8650 }, { x: 0.9338, y: 0.8782 }, { x: 0.9499, y: 0.9048 }, { x: 0.9603, y: 0.9143 }, { x: 0.9670, y: 0.9235 }, { x: 0.9734, y: 0.9340 }, { x: 0.9831, y: 0.9536 }, { x: 0.9910, y: 0.9593 }, { x: 0.9950, y: 0.9713 },
    ];
    const HOME_OVER_105_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5425, y: 0.5385 }, { x: 0.5582, y: 0.5534 }, { x: 0.5733, y: 0.5556 }, { x: 0.5833, y: 0.6064 }, { x: 0.6009, y: 0.6075 }, { x: 0.6095, y: 0.6216 }, { x: 0.6221, y: 0.6247 }, { x: 0.6424, y: 0.6261 }, { x: 0.6600, y: 0.6463 }, { x: 0.6756, y: 0.6723 }, { x: 0.7039, y: 0.6837 }, { x: 0.7339, y: 0.6937 }, { x: 0.7523, y: 0.7192 }, { x: 0.7779, y: 0.7539 }, { x: 0.8154, y: 0.7701 }, { x: 0.8398, y: 0.7885 }, { x: 0.8413, y: 0.8056 }, { x: 0.8440, y: 0.8156 }, { x: 0.8514, y: 0.8202 }, { x: 0.8563, y: 0.8235 }, { x: 0.8654, y: 0.8296 }, { x: 0.8825, y: 0.8310 }, { x: 0.8948, y: 0.8311 }, { x: 0.8991, y: 0.8391 }, { x: 0.9007, y: 0.8421 }, { x: 0.9107, y: 0.8432 }, { x: 0.9206, y: 0.8444 }, { x: 0.9376, y: 0.8917 }, { x: 0.9631, y: 0.9234 }, { x: 0.9777, y: 0.9456 },
    ];
    const AWAY_OVER_95_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.6001, y: 0.5399 }, { x: 0.6604, y: 0.5741 }, { x: 0.6929, y: 0.5782 }, { x: 0.7115, y: 0.5909 }, { x: 0.7210, y: 0.6395 }, { x: 0.7771, y: 0.6562 }, { x: 0.8189, y: 0.7101 }, { x: 0.8378, y: 0.7140 }, { x: 0.8557, y: 0.7174 }, { x: 0.8687, y: 0.7185 }, { x: 0.8849, y: 0.7732 }, { x: 0.9111, y: 0.8138 }, { x: 0.9274, y: 0.8404 }, { x: 0.9379, y: 0.8496 }, { x: 0.9469, y: 0.8526 }, { x: 0.9522, y: 0.8567 }, { x: 0.9591, y: 0.8595 }, { x: 0.9618, y: 0.8750 }, { x: 0.9621, y: 0.8889 }, { x: 0.9680, y: 0.8955 }, { x: 0.9764, y: 0.9135 }, { x: 0.9804, y: 0.9173 }, { x: 0.9818, y: 0.9262 }, { x: 0.9823, y: 0.9268 }, { x: 0.9858, y: 0.9368 }, { x: 0.9893, y: 0.9430 }, { x: 0.9922, y: 0.9523 }, { x: 0.9957, y: 0.9619 }, { x: 0.9970, y: 0.9663 }, { x: 0.9978, y: 0.9706 }, { x: 0.9987, y: 0.9960 },
    ];
    const AWAY_OVER_100_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5586, y: 0.4419 }, { x: 0.5805, y: 0.4545 }, { x: 0.5856, y: 0.4615 }, { x: 0.5869, y: 0.5000 }, { x: 0.5871, y: 0.5000 }, { x: 0.5888, y: 0.5000 }, { x: 0.5986, y: 0.5000 }, { x: 0.6123, y: 0.5049 }, { x: 0.6203, y: 0.5156 }, { x: 0.6257, y: 0.5455 }, { x: 0.6282, y: 0.5455 }, { x: 0.6736, y: 0.5594 }, { x: 0.7132, y: 0.6000 }, { x: 0.7153, y: 0.6102 }, { x: 0.7313, y: 0.6542 }, { x: 0.7453, y: 0.6667 }, { x: 0.7455, y: 0.6667 }, { x: 0.7456, y: 0.6667 }, { x: 0.7480, y: 0.6667 }, { x: 0.7498, y: 0.6667 }, { x: 0.7510, y: 0.6744 }, { x: 0.7538, y: 0.6786 }, { x: 0.7748, y: 0.6833 }, { x: 0.8001, y: 0.6863 }, { x: 0.8067, y: 0.7083 }, { x: 0.8236, y: 0.7217 }, { x: 0.8406, y: 0.7293 }, { x: 0.8441, y: 0.7368 }, { x: 0.8645, y: 0.7555 }, { x: 0.8812, y: 0.7857 }, { x: 0.8821, y: 0.7903 }, { x: 0.8873, y: 0.7933 }, { x: 0.9013, y: 0.8093 }, { x: 0.9120, y: 0.8101 }, { x: 0.9143, y: 0.8140 }, { x: 0.9186, y: 0.8203 }, { x: 0.9244, y: 0.8304 }, { x: 0.9332, y: 0.8505 }, { x: 0.9464, y: 0.8603 }, { x: 0.9537, y: 0.8629 }, { x: 0.9552, y: 0.8657 }, { x: 0.9567, y: 0.8841 }, { x: 0.9625, y: 0.8871 }, { x: 0.9681, y: 0.8919 }, { x: 0.9713, y: 0.9033 }, { x: 0.9745, y: 0.9063 }, { x: 0.9754, y: 0.9091 }, { x: 0.9757, y: 0.9091 }, { x: 0.9830, y: 0.9261 }, { x: 0.9915, y: 0.9535 }, { x: 0.9925, y: 0.9623 }, { x: 0.9943, y: 0.9823 },
    ];
    const HOME_UNDER_120_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5482, y: 0.3968 }, { x: 0.5534, y: 0.5000 }, { x: 0.5539, y: 0.5000 }, { x: 0.5572, y: 0.5000 }, { x: 0.5892, y: 0.5450 }, { x: 0.6325, y: 0.5542 }, { x: 0.6685, y: 0.5679 }, { x: 0.6891, y: 0.5806 }, { x: 0.6910, y: 0.6000 }, { x: 0.6912, y: 0.6000 }, { x: 0.6937, y: 0.6173 }, { x: 0.7185, y: 0.6212 }, { x: 0.7461, y: 0.6231 }, { x: 0.7676, y: 0.6452 }, { x: 0.7812, y: 0.6667 }, { x: 0.7816, y: 0.6667 }, { x: 0.7817, y: 0.6667 }, { x: 0.8025, y: 0.6743 }, { x: 0.8252, y: 0.6993 }, { x: 0.8426, y: 0.7297 }, { x: 0.8562, y: 0.7586 }, { x: 0.8660, y: 0.7593 }, { x: 0.8760, y: 0.7792 }, { x: 0.8820, y: 0.7827 }, { x: 0.8989, y: 0.7994 }, { x: 0.9105, y: 0.8000 }, { x: 0.9136, y: 0.8224 }, { x: 0.9175, y: 0.8261 }, { x: 0.9207, y: 0.8326 }, { x: 0.9333, y: 0.8544 }, { x: 0.9433, y: 0.8571 }, { x: 0.9459, y: 0.8740 }, { x: 0.9531, y: 0.8752 }, { x: 0.9611, y: 0.8889 }, { x: 0.9678, y: 0.8939 }, { x: 0.9714, y: 0.9000 }, { x: 0.9723, y: 0.9182 }, { x: 0.9759, y: 0.9402 }, { x: 0.9834, y: 0.9430 }, { x: 0.9887, y: 0.9528 }, { x: 0.9907, y: 0.9615 }, { x: 0.9930, y: 0.9680 }, { x: 0.9951, y: 0.9707 }, { x: 0.9972, y: 0.9870 },
    ];
    const HOME_UNDER_125_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5946, y: 0.5167 }, { x: 0.6551, y: 0.5393 }, { x: 0.6822, y: 0.5556 }, { x: 0.6897, y: 0.6000 }, { x: 0.7120, y: 0.6316 }, { x: 0.7503, y: 0.6397 }, { x: 0.7797, y: 0.6769 }, { x: 0.7952, y: 0.7006 }, { x: 0.8342, y: 0.7050 }, { x: 0.8606, y: 0.7353 }, { x: 0.8632, y: 0.7439 }, { x: 0.8645, y: 0.7500 }, { x: 0.8784, y: 0.7563 }, { x: 0.8946, y: 0.7757 }, { x: 0.9066, y: 0.7770 }, { x: 0.9174, y: 0.8152 }, { x: 0.9277, y: 0.8166 }, { x: 0.9419, y: 0.8482 }, { x: 0.9502, y: 0.8557 }, { x: 0.9511, y: 0.8571 }, { x: 0.9561, y: 0.8647 }, { x: 0.9621, y: 0.8819 }, { x: 0.9683, y: 0.8967 }, { x: 0.9732, y: 0.8971 }, { x: 0.9737, y: 0.9063 }, { x: 0.9797, y: 0.9312 }, { x: 0.9867, y: 0.9466 }, { x: 0.9900, y: 0.9484 }, { x: 0.9923, y: 0.9528 }, { x: 0.9934, y: 0.9612 }, { x: 0.9937, y: 0.9643 }, { x: 0.9939, y: 0.9706 }, { x: 0.9958, y: 0.9812 }, { x: 0.9983, y: 0.9908 },
    ];
    const AWAY_UNDER_110_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5464, y: 0.5744 }, { x: 0.5560, y: 0.5812 }, { x: 0.5623, y: 0.6040 }, { x: 0.5925, y: 0.6208 }, { x: 0.6252, y: 0.6454 }, { x: 0.6541, y: 0.6552 }, { x: 0.6815, y: 0.6618 }, { x: 0.6851, y: 0.6667 }, { x: 0.6953, y: 0.6798 }, { x: 0.7123, y: 0.7005 }, { x: 0.7200, y: 0.7059 }, { x: 0.7263, y: 0.7432 }, { x: 0.7407, y: 0.7638 }, { x: 0.7747, y: 0.7743 }, { x: 0.8018, y: 0.7826 }, { x: 0.8087, y: 0.7843 }, { x: 0.8216, y: 0.7968 }, { x: 0.8357, y: 0.8154 }, { x: 0.8836, y: 0.8426 }, { x: 0.9507, y: 0.9099 },
    ];
    const AWAY_UNDER_115_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5445, y: 0.5879 }, { x: 0.5662, y: 0.6070 }, { x: 0.6010, y: 0.6137 }, { x: 0.6376, y: 0.6286 }, { x: 0.6653, y: 0.6493 }, { x: 0.6876, y: 0.6693 }, { x: 0.7113, y: 0.7012 }, { x: 0.7401, y: 0.7489 }, { x: 0.7643, y: 0.7500 }, { x: 0.7810, y: 0.7664 }, { x: 0.7996, y: 0.7692 }, { x: 0.8116, y: 0.7828 }, { x: 0.8350, y: 0.8112 }, { x: 0.8545, y: 0.8209 }, { x: 0.8562, y: 0.8214 }, { x: 0.8570, y: 0.8235 }, { x: 0.8664, y: 0.8324 }, { x: 0.8770, y: 0.8333 }, { x: 0.8807, y: 0.8698 }, { x: 0.8877, y: 0.8734 }, { x: 0.9081, y: 0.8793 }, { x: 0.9318, y: 0.9058 }, { x: 0.9499, y: 0.9174 }, { x: 0.9651, y: 0.9187 }, { x: 0.9745, y: 0.9371 }, { x: 0.9795, y: 0.9375 }, { x: 0.9820, y: 0.9500 }, { x: 0.9856, y: 0.9778 }, { x: 0.9885, y: 0.9828 },
    ];
    const AWAY_UNDER_120_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5495, y: 0.5306 }, { x: 0.5892, y: 0.5741 }, { x: 0.6340, y: 0.5910 }, { x: 0.6675, y: 0.5987 }, { x: 0.6897, y: 0.6599 }, { x: 0.6994, y: 0.6705 }, { x: 0.7107, y: 0.6840 }, { x: 0.7173, y: 0.6923 }, { x: 0.7351, y: 0.7118 }, { x: 0.7537, y: 0.7143 }, { x: 0.7547, y: 0.7143 }, { x: 0.7569, y: 0.7368 }, { x: 0.7861, y: 0.7521 }, { x: 0.8260, y: 0.7592 }, { x: 0.8451, y: 0.7757 }, { x: 0.8514, y: 0.7794 }, { x: 0.8604, y: 0.8131 }, { x: 0.8742, y: 0.8141 }, { x: 0.8810, y: 0.8308 }, { x: 0.8829, y: 0.8375 }, { x: 0.8881, y: 0.8518 }, { x: 0.8958, y: 0.8582 }, { x: 0.8993, y: 0.8636 }, { x: 0.9007, y: 0.8713 }, { x: 0.9148, y: 0.8783 }, { x: 0.9282, y: 0.8784 }, { x: 0.9302, y: 0.8864 }, { x: 0.9418, y: 0.9047 }, { x: 0.9534, y: 0.9097 }, { x: 0.9569, y: 0.9161 }, { x: 0.9641, y: 0.9353 }, { x: 0.9713, y: 0.9516 }, { x: 0.9743, y: 0.9553 }, { x: 0.9798, y: 0.9597 }, { x: 0.9885, y: 0.9598 }, { x: 0.9950, y: 0.9868 }, { x: 0.9976, y: 0.9910 },
    ];
    const AWAY_UNDER_125_5_BLOCKS: { x: number; y: number }[] = [
      { x: 0.5870, y: 0.4737 }, { x: 0.6386, y: 0.5309 }, { x: 0.6731, y: 0.5417 }, { x: 0.6958, y: 0.5821 }, { x: 0.7212, y: 0.6408 }, { x: 0.7768, y: 0.7081 }, { x: 0.8111, y: 0.7381 }, { x: 0.8361, y: 0.7699 }, { x: 0.8632, y: 0.7784 }, { x: 0.8732, y: 0.8233 }, { x: 0.8777, y: 0.8413 }, { x: 0.8885, y: 0.8421 }, { x: 0.9150, y: 0.8573 }, { x: 0.9365, y: 0.8655 }, { x: 0.9460, y: 0.8734 }, { x: 0.9549, y: 0.9000 }, { x: 0.9607, y: 0.9107 }, { x: 0.9643, y: 0.9248 }, { x: 0.9682, y: 0.9303 }, { x: 0.9692, y: 0.9412 }, { x: 0.9725, y: 0.9435 }, { x: 0.9757, y: 0.9524 }, { x: 0.9781, y: 0.9528 }, { x: 0.9810, y: 0.9551 }, { x: 0.9850, y: 0.9591 }, { x: 0.9905, y: 0.9650 }, { x: 0.9936, y: 0.9785 }, { x: 0.9941, y: 0.9825 }, { x: 0.9966, y: 0.9884 },
    ];

    function overProbForLine(expected: number, line: number): number {
      return 1 - normalCdf((line - expected) / NBA_TEAM_TOTALS_SD);
    }
    function underProbForLine(expected: number, line: number): number {
      return normalCdf((line - expected) / NBA_TEAM_TOTALS_SD);
    }

    // Over: pick the HIGHEST qualifying line (strongest claim), matching
    // every other Over market's convention in this file.
    const homeOverCandidates = [
      { line: 95.5, blocks: HOME_OVER_95_5_BLOCKS },
      { line: 100.5, blocks: HOME_OVER_100_5_BLOCKS },
      { line: 105.5, blocks: HOME_OVER_105_5_BLOCKS },
    ].map(c => ({ ...c, raw: overProbForLine(homeExpected, c.line) }))
     .map(c => ({ ...c, calibrated: c.raw >= TOTALS_MIN_CONFIDENCE ? isotonicLookup(c.blocks, c.raw) : -1 }))
     .filter(c => c.raw >= TOTALS_MIN_CONFIDENCE && c.calibrated >= TEAM_TOTALS_MIN_TIP_CONFIDENCE);
    if (homeOverCandidates.length) {
      const best = homeOverCandidates.reduce((a, b) => (b.line > a.line ? b : a));
      results.push({ market: 'team_points_over', selection: `Home Over ${best.line}`, trueProbability: best.calibrated, method: 'normal-team-points-over-isotonic' });
    }

    const awayOverCandidates = [
      { line: 95.5, blocks: AWAY_OVER_95_5_BLOCKS },
      { line: 100.5, blocks: AWAY_OVER_100_5_BLOCKS },
    ].map(c => ({ ...c, raw: overProbForLine(awayExpected, c.line) }))
     .map(c => ({ ...c, calibrated: c.raw >= TOTALS_MIN_CONFIDENCE ? isotonicLookup(c.blocks, c.raw) : -1 }))
     .filter(c => c.raw >= TOTALS_MIN_CONFIDENCE && c.calibrated >= TEAM_TOTALS_MIN_TIP_CONFIDENCE);
    if (awayOverCandidates.length) {
      const best = awayOverCandidates.reduce((a, b) => (b.line > a.line ? b : a));
      results.push({ market: 'team_points_over', selection: `Away Over ${best.line}`, trueProbability: best.calibrated, method: 'normal-team-points-over-isotonic' });
    }

    // Under: pick the LOWEST qualifying line (strongest claim), matching
    // football's team_goals_under convention.
    const homeUnderCandidates = [
      { line: 120.5, blocks: HOME_UNDER_120_5_BLOCKS },
      { line: 125.5, blocks: HOME_UNDER_125_5_BLOCKS },
    ].map(c => ({ ...c, raw: underProbForLine(homeExpected, c.line) }))
     .map(c => ({ ...c, calibrated: c.raw >= TOTALS_MIN_CONFIDENCE ? isotonicLookup(c.blocks, c.raw) : -1 }))
     .filter(c => c.raw >= TOTALS_MIN_CONFIDENCE && c.calibrated >= TEAM_TOTALS_MIN_TIP_CONFIDENCE);
    if (homeUnderCandidates.length) {
      const best = homeUnderCandidates.reduce((a, b) => (b.line < a.line ? b : a));
      results.push({ market: 'team_points_under', selection: `Home Under ${best.line}`, trueProbability: best.calibrated, method: 'normal-team-points-under-isotonic' });
    }

    const awayUnderCandidates = [
      { line: 110.5, blocks: AWAY_UNDER_110_5_BLOCKS },
      { line: 115.5, blocks: AWAY_UNDER_115_5_BLOCKS },
      { line: 120.5, blocks: AWAY_UNDER_120_5_BLOCKS },
      { line: 125.5, blocks: AWAY_UNDER_125_5_BLOCKS },
    ].map(c => ({ ...c, raw: underProbForLine(awayExpected, c.line) }))
     .map(c => ({ ...c, calibrated: c.raw >= TOTALS_MIN_CONFIDENCE ? isotonicLookup(c.blocks, c.raw) : -1 }))
     .filter(c => c.raw >= TOTALS_MIN_CONFIDENCE && c.calibrated >= TEAM_TOTALS_MIN_TIP_CONFIDENCE);
    if (awayUnderCandidates.length) {
      const best = awayUnderCandidates.reduce((a, b) => (b.line < a.line ? b : a));
      results.push({ market: 'team_points_under', selection: `Away Under ${best.line}`, trueProbability: best.calibrated, method: 'normal-team-points-under-isotonic' });
    }
  }

  return results;
}
// ─── HOCKEY ISOTONIC ────────────────────────────────────────────
// Fitted via hockeyIsotonicFit.ts on pooled 14 EliteProspects leagues,
// 4 seasons each (2022-2023 through 2025-2026), 35,386 predictions —
// confirmed 2026-09-05 after a first attempt silently ran on only 2/14
// leagues due to a mid-run cookie failure (caught by cross-checking the
// total against hockeyCalibrationCheck.ts's known-good count before
// trusting it). Built because backtesting showed the raw ELO formula
// below was overconfident specifically in the 60-80% range (e.g. raw
// 67.3% claimed vs 57.9% real hit rate in the 65-70% band) — exactly
// where most "confident" tips land. Reliable range: x=0.5003-0.8091
// (28 blocks, min weight 30 games, low-end/high-end noisy blocks
// excluded).
//
// Refit 2026-09-15 against the corrected raw formula (home-ice fix +
// hockeyBacktest1.ts/probabilityModel.ts formula-drift fix, both same
// night — see computeHockeyRawMoneylineProb() comment above modelHockey()
// for the full story). 35,386 predictions, all 14 leagues, complete run
// (matches the original baseline count exactly). Confirmed genuinely
// different from the pre-fix table: raw range widened from x=0.5003-0.8091
// to x=0.5002-0.8697 — the old formula's compression bug capped every
// prediction below ~81% confidence no matter how lopsided the matchup;
// that ceiling is gone now, with real predictions reaching the 90%+ band
// (16 games, calibrated 80.8%, actual hit rate 81.3%). Calibration gaps
// across every band are under 1 percentage point (e.g. 80-90% band:
// calibrated 76.1% vs actual 76.3%). Reliable range: x=0.5002-0.8697
// (29 blocks, min weight 30 games, 0 low-end + 2 high-end noisy blocks
// excluded).
const HOCKEY_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5002, y: 0.4231 },
  { x: 0.5005, y: 0.4725 },
  { x: 0.5009, y: 0.4727 },
  { x: 0.5044, y: 0.4919 },
  { x: 0.5152, y: 0.5191 },
  { x: 0.5271, y: 0.5349 },
  { x: 0.5471, y: 0.5505 },
  { x: 0.5656, y: 0.5525 },
  { x: 0.5746, y: 0.5664 },
  { x: 0.5824, y: 0.5685 },
  { x: 0.5838, y: 0.5688 },
  { x: 0.5914, y: 0.5760 },
  { x: 0.6028, y: 0.5765 },
  { x: 0.6120, y: 0.5882 },
  { x: 0.6245, y: 0.5914 },
  { x: 0.6542, y: 0.6121 },
  { x: 0.6995, y: 0.6211 },
  { x: 0.7260, y: 0.6232 },
  { x: 0.7387, y: 0.6510 },
  { x: 0.7555, y: 0.6648 },
  { x: 0.7655, y: 0.6667 },
  { x: 0.7724, y: 0.6722 },
  { x: 0.7801, y: 0.7000 },
  { x: 0.7897, y: 0.7025 },
  { x: 0.8052, y: 0.7447 },
  { x: 0.8107, y: 0.7500 },
  { x: 0.8175, y: 0.7550 },
  { x: 0.8354, y: 0.7600 },
  { x: 0.8697, y: 0.8077 },
];

export function applyHockeyIsotonicCalibration(rawProb: number): number {

  const blocks = HOCKEY_ISOTONIC_BLOCKS;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

// ── SHARED RAW HOCKEY MONEYLINE FORMULA ─────────────────────────────
// Extracted 2026-09-14, same day as the home-ice restructuring, for a
// reason that goes beyond code tidiness: hockeyBacktest1.ts (which
// hockeyIsotonicFit.ts imports predictMoneyline() FROM, per that file's
// own header comment about avoiding calibration drift) turned out to
// have an entirely separate, hand-duplicated copy of this exact
// formula — eloStrengthRatio()/predictMoneyline() in that file, with
// HOME_ICE_ADVANTAGE still blended inside the ratio, UNAFFECTED by
// today's fix here. That duplication is why an isotonic refit run
// tonight came back byte-for-byte identical to the pre-fix table: the
// refit was faithfully recalibrating the OLD, still-broken formula,
// because nothing forced the two copies to stay in sync. Exporting the
// raw computation from here and having hockeyBacktest1.ts's
// predictMoneyline() call THIS function instead of maintaining its own
// copy closes that gap structurally — a future change to this formula
// can no longer silently miss the backtest/fit path the way this one
// did. See hockeyBacktest1.ts's predictMoneyline() for the other side
// of this wiring.
//
// HOME_ICE_ADVANTAGE is a starting value, NOT independently backtested
// for hockey (unlike basketball's HOME_COURT_ADVANTAGE, confirmed via a
// real before/after split test) — a real, consistent Home>Away
// hit-rate skew showed up across nearly every league in the full
// backtest, meaning this is likely under-tuned. Revisit once that
// tuning work is done. Placement fixed 2026-09-14: previously blended
// INSIDE the strength ratio (diluted by the 0.6/0.4 weighting — for a
// truly even matchup this produced raw≈0.4947, barely above a coinflip
// and essentially cancelling out the intended home-ice edge), now added
// AFTER the 0.85/0.04 compression step, matching modelBasketball's
// HOME_COURT_ADVANTAGE placement exactly.
//
// NOT YET DONE, ON PURPOSE: the 0.85 compression constant and the
// ratio-based strength formula itself (eloStrengthRatio) are UNCHANGED
// here — whether hockey's win-rate inputs are naturally tighter than
// basketball's (a real property of the sport) or whether the
// compression itself needs a hockey-specific retune is still an open
// question pending a separate raw-spread comparison against basketball,
// agreed before making this change. This is scoped to the home-ice
// placement fix only.
export const HOCKEY_HOME_ICE_ADVANTAGE = 0.075;

export function computeHockeyRawMoneylineProb(homeWinRate: number, awayWinRate: number, h2hHomeWinRate: number): number {
  const eloHome = eloStrengthRatio(homeWinRate, awayWinRate, h2hHomeWinRate);
  const raw = eloHome * 0.85 + 0.04 + HOCKEY_HOME_ICE_ADVANTAGE;
  return Math.max(0.05, Math.min(0.95, raw));
}

// ── SHARED HOCKEY GOAL-SCORING LAMBDAS (puck_line / totals) ─────────
// Extracted 2026-09-15, same reasoning as computeHockeyRawMoneylineProb
// above: exporting this lets a real-odds puck-line backtest reuse the
// EXACT same lambda computation modelHockey() uses, instead of a second
// hand-copied version that could drift the same way the moneyline
// formula did earlier.
//
// UPDATE (this session): these lambdas are now BACKING CALIBRATED
// markets — puck_line (+/-1.5 and +/-2.5), hockey_totals (Over 4.5 /
// Under 7.5 fixed lines), and team_totals (Home/Away Over 1.5, Away
// Under 3.5) — see hockeyLineSweep.ts (raw historical line screening,
// 14 leagues x 4 seasons, which lines even clear 70% real hit rate
// before any model involvement) and hockeyCalibrationPrep.ts
// (walk-forward isotonic calibration using THESE SAME lambdas, 34,532
// pooled predictions) for the full validation trail. The lambdas
// themselves are UNCHANGED by this — no formula edits were made here,
// only new calibration tables downstream of them. Do not assume the
// underlying lambda formula itself is validated just because several
// markets built on top of it now are; it's still the same raw Poisson
// goal-scoring estimate as before, unrefit.
export function computeHockeyGoalLambdas(stats: Stats): { lambdaHome: number; lambdaAway: number } {
  let lambdaHome = weightedGoalsAvg(stats.homeForm.filter(f => f.venue === 'home'), 'goalsFor');
  let lambdaAway = weightedGoalsAvg(stats.awayForm.filter(f => f.venue === 'away'), 'goalsFor');

  const h2hHomeGoals = stats.h2h.reduce((s, r) => s + r.homeScore, 0) / (stats.h2h.length || 1);
  const h2hAwayGoals = stats.h2h.reduce((s, r) => s + r.awayScore, 0) / (stats.h2h.length || 1);
  lambdaHome = lambdaHome * 0.7 + h2hHomeGoals * 0.3;
  lambdaAway = lambdaAway * 0.7 + h2hAwayGoals * 0.3;

  lambdaHome *= 1.06;

  const fatigue = stats.situational?.fatigueDays;
  if (fatigue !== undefined && fatigue < 2) {
    lambdaAway *= 0.90;
    lambdaHome *= 0.93;
  }

  if (stats.referee?.avgYellowCards && stats.referee.avgYellowCards > 15) {
    lambdaHome *= 1.06;
    lambdaAway *= 1.06;
  }

  const weather = stats.situational?.weather?.toLowerCase() || '';
  if (weather.includes('wind') || weather.includes('snow')) {
    lambdaHome *= 0.85;
    lambdaAway *= 0.85;
  }

  // ── GOALIE ADJUSTMENT (opponent's starting goalie quality) ──────
  // STRUCTURAL HOOK, SENSITIVITY UNVALIDATED — see GOALIE_GSAX_SENSITIVITY
  // above. Read from additionalContext so no schema.ts change is needed,
  // same pattern as baseball's parkFactor/bullpenFactor. A team's
  // expected goals are suppressed by the OPPOSING goalie's positive
  // GSAx/60 (they've been stopping more than expected) and raised by a
  // negative one. Defaults to neutral (no adjustment) when the field
  // isn't populated — a no-op for every existing caller until something
  // actually writes these two fields, so this cannot change any current
  // backtest result until it's deliberately wired in.
  const awayGoalieGSAx = stats.additionalContext?.awayGoalieGSaxPer60 as number | undefined;
  const homeGoalieGSAx = stats.additionalContext?.homeGoalieGSaxPer60 as number | undefined;
  if (awayGoalieGSAx !== undefined) {
    const factor = Math.max(0.85, Math.min(1.15, 1 - GOALIE_GSAX_SENSITIVITY * awayGoalieGSAx));
    lambdaHome *= factor; // away goalie faces home team's shots
  }
  if (homeGoalieGSAx !== undefined) {
    const factor = Math.max(0.85, Math.min(1.15, 1 - GOALIE_GSAX_SENSITIVITY * homeGoalieGSAx));
    lambdaAway *= factor; // home goalie faces away team's shots
  }

  lambdaHome = Math.min(lambdaHome, 4.5);
  lambdaAway = Math.min(lambdaAway, 4.5);

  return { lambdaHome, lambdaAway };
}

// ─── HOCKEY PUCK LINE / TOTALS / TEAM TOTALS ISOTONIC ────────────────
// Fitted via hockeyCalibrationPrep.ts, walk-forward, 34,532 predictions,
// all 14 leagues pooled, 4 seasons (2022-23 through 2025-26). Lines
// themselves (puck line +/-1.5 and +/-2.5; game totals Over 4.5/Under
// 7.5; team totals Home Over 1.5/Away Over 1.5/Away Under 3.5) were
// FIRST screened via hockeyLineSweep.ts — a raw historical hit-rate
// sweep with NO model involved at all, just "did the real final score
// clear this fixed line 70%+ of the time across all 14 leagues." Lines
// that failed that screen were dropped before any calibration work
// began: game total 2.5/5.5/6.5 (40-65% range), Home Team Total Under
// 3.5 (53-69% range, never cleared 70% in any league). Only lines that
// passed the raw screen went into hockeyCalibrationPrep.ts's
// walk-forward run to get an actual per-matchup confidence number.
//
// Bins from hockeyCalibrationPrep.ts's output were pooled via manual
// pool-adjacent-violators where raw bins weren't already monotonic
// (hand-computed, not run through an automated PAVA script — flagged as
// a real limitation; worth re-verifying with a script before fully
// trusting the exact block values, same caution as any hand-derived fit
// elsewhere in this file).
//
// PUCK_LINE_1_5: real hit rate plateaus ~70-71% even at max raw
// confidence — capped there, do not expect this market to ever claim
// above ~70.6%. This is the market's genuine calibrated ceiling, not a
// display bug or a bug in the table.
const PUCK_LINE_1_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.547, y: 0.569 },
  { x: 0.609, y: 0.632 },
  { x: 0.646, y: 0.654 },
  { x: 0.673, y: 0.662 },
  { x: 0.694, y: 0.662 },
  { x: 0.713, y: 0.684 },
  { x: 0.729, y: 0.705 },
  { x: 0.745, y: 0.705 },
  { x: 0.761, y: 0.705 },
  { x: 0.788, y: 0.706 },
];

// PUCK_LINE_2_5: meaningfully stronger than the 1.5 market — real hit
// rate reaches ~80-82% at high raw confidence, the best-behaved of every
// hockey market calibrated this session.
const PUCK_LINE_2_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.705, y: 0.701 },
  { x: 0.774, y: 0.751 },
  { x: 0.803, y: 0.769 },
  { x: 0.824, y: 0.774 },
  { x: 0.839, y: 0.782 },
  { x: 0.852, y: 0.784 },
  { x: 0.911, y: 0.8118 },
];

// GAME_TOTAL_OVER_4_5: raw formula UNDERclaims relative to real hit
// rate at every bin (e.g. bin1: 18.1% raw vs 66.3% real) — this table
// corrects UPWARD, same direction as most other calibrations in this
// file (moneyline, corners, etc.).
const GAME_TOTAL_OVER_4_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.181, y: 0.663 },
  { x: 0.266, y: 0.699 },
  { x: 0.317, y: 0.717 },
  { x: 0.359, y: 0.734 },
  { x: 0.397, y: 0.734 },
  { x: 0.434, y: 0.754 },
  { x: 0.472, y: 0.759 },
  { x: 0.515, y: 0.764 },
  { x: 0.565, y: 0.774 },
  { x: 0.655, y: 0.774 },
];

// GAME_TOTAL_UNDER_7_5: same underclaiming direction as Over 4.5 above.
const GAME_TOTAL_UNDER_7_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.796, y: 0.744 },
  { x: 0.863, y: 0.766 },
  { x: 0.891, y: 0.774 },
  { x: 0.911, y: 0.774 },
  { x: 0.927, y: 0.777 },
  { x: 0.941, y: 0.792 },
  { x: 0.952, y: 0.804 },
  { x: 0.964, y: 0.8115 },
  { x: 0.975, y: 0.8115 },
  { x: 0.988, y: 0.838 },
];

// HOME_TEAM_TOTAL_OVER_1_5: same underclaiming direction.
const HOME_TEAM_TOTAL_OVER_1_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.375, y: 0.742 },
  { x: 0.487, y: 0.770 },
  { x: 0.540, y: 0.785 },
  { x: 0.582, y: 0.799 },
  { x: 0.619, y: 0.799 },
  { x: 0.651, y: 0.807 },
  { x: 0.683, y: 0.813 },
  { x: 0.717, y: 0.8315 },
  { x: 0.755, y: 0.8315 },
  { x: 0.818, y: 0.844 },
];

// AWAY_TEAM_TOTAL_OVER_1_5: same underclaiming direction, slightly
// weaker than the Home side (consistent with hockeyBacktest1.ts's own
// finding of a real, consistent Home>Away skew across nearly every
// league — see HOCKEY_HOME_ICE_ADVANTAGE comment above).
const AWAY_TEAM_TOTAL_OVER_1_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.353, y: 0.682 },
  { x: 0.459, y: 0.722 },
  { x: 0.512, y: 0.724 },
  { x: 0.553, y: 0.726 },
  { x: 0.590, y: 0.751 },
  { x: 0.623, y: 0.766 },
  { x: 0.655, y: 0.766 },
  { x: 0.689, y: 0.782 },
  { x: 0.729, y: 0.786 },
  { x: 0.794, y: 0.814 },
];

// AWAY_TEAM_TOTAL_UNDER_3_5: the ONE market in this whole session where
// raw confidence OVERclaims relative to real hit rate at EVERY bin
// (bin1: 65.4% raw vs 59.2% real; bin10: 96.0% raw vs 75.9% real) — this
// table corrects DOWNWARD, opposite direction from every other hockey
// market above. Do not assume this table's shape by analogy with the
// others; it was checked and confirmed to run the other way.
const AWAY_TEAM_TOTAL_UNDER_3_5_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.654, y: 0.592 },
  { x: 0.739, y: 0.633 },
  { x: 0.781, y: 0.648 },
  { x: 0.811, y: 0.660 },
  { x: 0.837, y: 0.669 },
  { x: 0.860, y: 0.674 },
  { x: 0.882, y: 0.698 },
  { x: 0.904, y: 0.708 },
  { x: 0.928, y: 0.730 },
  { x: 0.960, y: 0.759 },
];

// Post-calibration floor for puck_line/hockey_totals/team_totals,
// mirroring CARDS_SOT_MIN_TIP_CONFIDENCE's role for football's cards/SOT
// markets — gates each individual tip on its OWN calibrated value, not
// just the table's average. Set to 0.65 rather than the 0.70 convention
// used elsewhere in this file specifically because PUCK_LINE_1_5's real
// calibrated ceiling is ~70.6% — a 0.70 floor here would let through
// almost nothing from that specific market despite it being a real,
// validated signal. Also mirrored in tipScanner.ts's
// MARKET_MIN_TIP_CONFIDENCE map (puck_line/hockey_totals/team_totals
// entries) — kept as two separate checks, same pattern as
// cards_totals/sot_totals having both a probabilityModel.ts floor and a
// scanner-level floor, so a future change to one doesn't silently rely
// on the other alone.
const HOCKEY_TOTALS_MIN_TIP_CONFIDENCE = 0.65;

function modelHockey(input: ModelInput): MarketProbability[] {
  const { stats, odds } = input;
  const results: MarketProbability[] = [];

  // ── MONEYLINE ─────────────────────────────────────────────────────
  // Raw probability comes from computeHockeyRawMoneylineProb() above —
  // shared with hockeyBacktest1.ts's predictMoneyline(), see that
  // function's export comment above for why this sharing exists.
  //
  // CALIBRATED 2026-09-15: HOCKEY_ISOTONIC_BLOCKS above is now a genuine
  // refit against this corrected formula (35,386 predictions, all 14
  // leagues, complete run) — see that table's comment for the full
  // validation detail. Confidence numbers below are calibrated.
  const homeWR = formWinRate(stats.homeForm);
  const awayWR = formWinRate(stats.awayForm);
  const h2hHWR = h2hWinRate(stats.h2h, 'home');
  const rawHomeWinProb = computeHockeyRawMoneylineProb(homeWR, awayWR, h2hHWR);

  // Calibrate only the favorite side, derive the other as its
  // complement — same invariant-preserving pattern as every other sport
  // in this file (calibrating both sides independently would break the
  // "sums to 1" invariant downstream edge/EV calculations rely on).
  let calibratedHomeProb: number;
  let calibratedAwayProb: number;
  if (rawHomeWinProb >= 0.5) {
    calibratedHomeProb = applyHockeyIsotonicCalibration(rawHomeWinProb);
    calibratedAwayProb = 1 - calibratedHomeProb;
  } else {
    calibratedAwayProb = applyHockeyIsotonicCalibration(1 - rawHomeWinProb);
    calibratedHomeProb = 1 - calibratedAwayProb;
  }

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: calibratedHomeProb, method: 'elo+homeice+isotonic' },
    { market: 'moneyline', selection: 'Away', trueProbability: calibratedAwayProb, method: 'elo+homeice+isotonic' },
  );

  // ── SHARED LAMBDAS FOR PUCK LINE / TOTALS / TEAM TOTALS ──────────
  // Computed once here, reused by every market below — previously
  // computed twice in an earlier draft of this section (once for puck
  // line, once for totals) before being consolidated into a single call.
  const { lambdaHome, lambdaAway } = computeHockeyGoalLambdas(stats);

  // ── PUCK LINE (+/-1.5 and +/-2.5) — CALIBRATED as of this session ──
  // FIXED 2026-09-15 (kept from before): puck_line used to hardcode Home
  // as the -1.5 favorite and Away as +1.5 underdog, ALWAYS — wrong for
  // any real game where the away team is actually the favorite (a
  // common, ordinary case, not an edge case). Real puck-line markets
  // assign the negative line to whichever team is actually favored,
  // which can be either side. Computes both directions properly via the
  // shared marginDistribution/handicapCoverProbability helpers (same
  // ones modelFootball's handicap market already uses), determined by
  // which side the model's OWN win probability favors, matching how a
  // real market assigns the line.
  //
  // CALIBRATED this session via hockeyCalibrationPrep.ts (34,532 pooled
  // walk-forward predictions) — see PUCK_LINE_1_5_ISOTONIC_BLOCKS /
  // PUCK_LINE_2_5_ISOTONIC_BLOCKS comments above for the full detail on
  // each line's real calibrated ceiling. Both lines fire independently;
  // a match can produce a +1.5 tip, a +2.5 tip, both, or neither,
  // depending on which (if either) clears HOCKEY_TOTALS_MIN_TIP_CONFIDENCE
  // after calibration.
  const dist = marginDistribution(lambdaHome, lambdaAway);
  const homeIsFavoredForPuckLine = rawHomeWinProb >= 0.5; // use the (now-fixed) moneyline signal to decide direction

  const puckLineConfigs: [number, { x: number; y: number }[]][] = [
    [1.5, PUCK_LINE_1_5_ISOTONIC_BLOCKS],
    [2.5, PUCK_LINE_2_5_ISOTONIC_BLOCKS],
  ];

  for (const [pl, blocks] of puckLineConfigs) {
    const homeLine = homeIsFavoredForPuckLine ? -pl : pl;
    const awayLine = -homeLine;
    const rawHomeCoverProb = handicapCoverProbability(dist, homeLine);

    let calibratedHomeCover: number;
    let calibratedAwayCover: number;
    if (rawHomeCoverProb >= 0.5) {
      calibratedHomeCover = isotonicLookup(blocks, rawHomeCoverProb);
      calibratedAwayCover = 1 - calibratedHomeCover;
    } else {
      calibratedAwayCover = isotonicLookup(blocks, 1 - rawHomeCoverProb);
      calibratedHomeCover = 1 - calibratedAwayCover;
    }

    if (Math.max(calibratedHomeCover, calibratedAwayCover) >= HOCKEY_TOTALS_MIN_TIP_CONFIDENCE) {
      results.push(
        { market: 'puck_line', selection: `Home ${homeLine >= 0 ? '+' : ''}${homeLine}`, trueProbability: calibratedHomeCover, method: `poisson-margin-isotonic-${pl}` },
        { market: 'puck_line', selection: `Away ${awayLine >= 0 ? '+' : ''}${awayLine}`, trueProbability: calibratedAwayCover, method: `poisson-margin-isotonic-${pl}` },
      );
    }
  }

  // ── GAME TOTALS (Over 4.5 / Under 7.5) — CALIBRATED, fixed lines ──
  // REPLACES the old fixed-5.5-line, uncalibrated version. That version
  // is gone — 5.5 was tested via hockeyLineSweep.ts's raw historical
  // sweep and did NOT clear 70% real hit rate in most leagues (40-60%
  // range), so it was dropped rather than kept and calibrated. Only
  // 4.5 (Over) and 7.5 (Under) survived the raw screen across all 14
  // leagues — see GAME_TOTAL_OVER_4_5_ISOTONIC_BLOCKS /
  // GAME_TOTAL_UNDER_7_5_ISOTONIC_BLOCKS comments above.
  //
  // MARKET NAME DELIBERATELY 'hockey_totals', NOT 'totals' — football's
  // goals market already uses the string 'totals' in tipScanner.ts's
  // MARKET_MIN_TIP_CONFIDENCE map (0.70 floor). Reusing that same string
  // here would have silently forced hockey's totals to inherit
  // football's 0.70 floor instead of hockey's own backtested 0.65 floor
  // (HOCKEY_TOTALS_MIN_TIP_CONFIDENCE above). Keep this name distinct in
  // any future edit — do not rename it back to 'totals'.
  const rawOverAt45 = totalOverProbability(lambdaHome, lambdaAway, 4.5, 15);
  const calibratedOver45 = isotonicLookup(GAME_TOTAL_OVER_4_5_ISOTONIC_BLOCKS, rawOverAt45);
  if (calibratedOver45 >= HOCKEY_TOTALS_MIN_TIP_CONFIDENCE) {
    results.push({ market: 'hockey_totals', selection: 'Over 4.5', trueProbability: calibratedOver45, method: 'poisson-isotonic' });
  }

  const rawOverAt75 = totalOverProbability(lambdaHome, lambdaAway, 7.5, 15);
  const rawUnderAt75 = 1 - rawOverAt75;
  const calibratedUnder75 = isotonicLookup(GAME_TOTAL_UNDER_7_5_ISOTONIC_BLOCKS, rawUnderAt75);
  if (calibratedUnder75 >= HOCKEY_TOTALS_MIN_TIP_CONFIDENCE) {
    results.push({ market: 'hockey_totals', selection: 'Under 7.5', trueProbability: calibratedUnder75, method: 'poisson-isotonic' });
  }

  // ── TEAM TOTALS (Home Over 1.5 / Away Over 1.5 / Away Under 3.5) ──
  // NEW this session. Home Team Total UNDER 3.5 was ALSO tested via
  // hockeyLineSweep.ts and DELIBERATELY DROPPED — never cleared 70%
  // real hit rate in any of the 14 leagues (53-69% range). Do not add
  // "Home Under 3.5" back into this section without a fresh backtest
  // showing it actually clears the bar; the sweep data at time of
  // writing says it doesn't.
  const rawHomeOver15 = singleOverProbabilityPoisson(lambdaHome, 1.5, 15);
  const calibratedHomeOver15 = isotonicLookup(HOME_TEAM_TOTAL_OVER_1_5_ISOTONIC_BLOCKS, rawHomeOver15);
  if (calibratedHomeOver15 >= HOCKEY_TOTALS_MIN_TIP_CONFIDENCE) {
    results.push({ market: 'team_totals', selection: 'Home Over 1.5', trueProbability: calibratedHomeOver15, method: 'poisson-isotonic' });
  }

  const rawAwayOver15 = singleOverProbabilityPoisson(lambdaAway, 1.5, 15);
  const calibratedAwayOver15 = isotonicLookup(AWAY_TEAM_TOTAL_OVER_1_5_ISOTONIC_BLOCKS, rawAwayOver15);
  if (calibratedAwayOver15 >= HOCKEY_TOTALS_MIN_TIP_CONFIDENCE) {
    results.push({ market: 'team_totals', selection: 'Away Over 1.5', trueProbability: calibratedAwayOver15, method: 'poisson-isotonic' });
  }

  const rawAwayUnder35 = 1 - singleOverProbabilityPoisson(lambdaAway, 3.5, 15);
  const calibratedAwayUnder35 = isotonicLookup(AWAY_TEAM_TOTAL_UNDER_3_5_ISOTONIC_BLOCKS, rawAwayUnder35);
  if (calibratedAwayUnder35 >= HOCKEY_TOTALS_MIN_TIP_CONFIDENCE) {
    results.push({ market: 'team_totals', selection: 'Away Under 3.5', trueProbability: calibratedAwayUnder35, method: 'poisson-isotonic' });
  }

  return results;
}
// ─── BASEBALL (MLB) ─────────────────────────────────────────────────
//
// STATUS: structurally complete, NOT YET CALIBRATED. No historical MLB
// data has been backtested against this model (unlike NBA/WNBA, which
// were fit against thousands of real games before shipping). This ships
// as a raw passthrough — see applyBaseballIsotonicCalibration below —
// exactly the same bootstrap state NBA moneyline was in before
// nbaIsotonicFit.ts existed. DO NOT trust confidence numbers from this
// model as calibrated until a real fit is done.
//
// ALSO: this model has no data source feeding it yet. Nothing in this
// codebase scrapes MLB team stats as of this addition — stats.homeForm/
// awayForm/h2h will be empty for every MLB match until an MLB scraper +
// aggregator (mirroring soccerStatsCornersScraper.ts /
// cornersAggregator.ts, or the WNBA stats.wnba.com approach) is built.
//
// DESIGN CHOICE: moneyline uses the SAME elo+isotonic structure as
// modelBasketball (requested: "low variance") — win-rate/h2h/elo blended
// BEFORE calibration, rather than deriving moneyline probability directly
// from the run-scoring Poisson lambdas below. Totals uses Poisson (like
// modelHockey), not the basketball-style normal-CDF approach — MLB run
// totals are low-count, Poisson-appropriate the same way goals are,
// unlike basketball's high-scoring totals which behave more like a
// continuous distribution.
const MLB_TOTALS_LINE_DEFAULT = 8.5; // rough MLB league-average total runs/game — UNVALIDATED, revisit once real book lines are observed (same caveat WNBA's 165.5->174.5 fix addressed)

function computeBaseballLambdas(stats: Stats): { lambdaHome: number; lambdaAway: number } {
  const homeVenueForm = stats.homeForm.filter(f => f.venue === 'home');
  const awayVenueForm = stats.awayForm.filter(f => f.venue === 'away');

  // weightedGoalsAvg operates on FormRecord.goalsFor/goalsAgainst — reused
  // here for runs scored/allowed, same field, same recency-weighting
  // logic (0.85^i decay) as goals/hockey. No schema change needed.
  const homeRunsFor = weightedGoalsAvg(homeVenueForm, 'goalsFor');
  const awayRunsFor = weightedGoalsAvg(awayVenueForm, 'goalsFor');
  const homeRunsAgainst = weightedGoalsAvg(homeVenueForm, 'goalsAgainst');
  const awayRunsAgainst = weightedGoalsAvg(awayVenueForm, 'goalsAgainst');

  let lambdaHome = (homeRunsFor + awayRunsAgainst) / 2;
  let lambdaAway = (awayRunsFor + homeRunsAgainst) / 2;

  const h2hHomeRuns = stats.h2h.reduce((s, r) => s + r.homeScore, 0) / (stats.h2h.length || 1);
  const h2hAwayRuns = stats.h2h.reduce((s, r) => s + r.awayScore, 0) / (stats.h2h.length || 1);
  lambdaHome = lambdaHome * 0.8 + h2hHomeRuns * 0.2;
  lambdaAway = lambdaAway * 0.8 + h2hAwayRuns * 0.2;

  // Modest home-scoring bump — MLB home-field advantage is real but
  // smaller than football's; placeholder multiplier, UNVALIDATED.
  lambdaHome *= 1.03;

  // ── PARK FACTOR ──────────────────────────────────────────────
  // Multiplicative run-scoring adjustment for the home team's ballpark —
  // Coors Field-type hitter's parks run well above 1.0, pitcher's parks
  // (e.g. Oracle Park historically) below. Applies to BOTH teams' scoring
  // in that park, not just the home team, since park effects act on
  // whoever's batting there. STRUCTURAL HOOK ONLY: no park-factor data
  // source exists yet — additionalContext.parkFactor will be undefined
  // for every match until one is built (likely scraped from a source like
  // Baseball Savant or FanGraphs' published park factors), so this
  // defaults to neutral (1.0, no adjustment) for now.
  const parkFactor = (stats.additionalContext?.parkFactor as number | undefined) ?? 1.0;
  lambdaHome *= parkFactor;
  lambdaAway *= parkFactor;

  // ── BULLPEN ADJUSTMENT ───────────────────────────────────────
  // A team's bullpen quality (relative to league-average bullpen ERA)
  // affects how many runs their OPPONENT scores against them, especially
  // in the back half of games — modeled here as a multiplier applied to
  // the opposing lambda: a below-average (weak) bullpen factor > 1.0
  // increases what the opponent is expected to score, a strong bullpen
  // (< 1.0) suppresses it. STRUCTURAL HOOK ONLY: no bullpen ERA data
  // source exists yet — both factors default to neutral (1.0) until one
  // is built (e.g. rolling bullpen ERA vs. league average, refreshed
  // periodically since bullpen personnel/form changes through a season
  // unlike a park's physical dimensions).
  const homeBullpenFactor = (stats.additionalContext?.homeBullpenFactor as number | undefined) ?? 1.0;
  const awayBullpenFactor = (stats.additionalContext?.awayBullpenFactor as number | undefined) ?? 1.0;
  lambdaAway *= homeBullpenFactor; // away team's runs are suppressed/boosted by HOME bullpen quality
  lambdaHome *= awayBullpenFactor; // home team's runs are suppressed/boosted by AWAY bullpen quality

  // ── WEATHER / WIND ───────────────────────────────────────────
  // Wind blowing out increases runs (more fly balls carry for home runs),
  // wind blowing in suppresses them — a much bigger real effect in
  // baseball than in football/hockey, where weather.includes() checks
  // elsewhere in this file only handle rain/snow/storm. Reuses the same
  // situational.weather free-text field rather than adding new schema,
  // consistent with how the rest of this file reads situational context.
  // Magnitudes are placeholder estimates pending real backtest validation
  // — commonly cited as a real MLB effect, but not fitted against this
  // pipeline's own data.
  const weather = stats.situational?.weather?.toLowerCase() || '';
  if (weather.includes('wind out') || weather.includes('wind blowing out')) {
    lambdaHome *= 1.06;
    lambdaAway *= 1.06;
  } else if (weather.includes('wind in') || weather.includes('wind blowing in')) {
    lambdaHome *= 0.94;
    lambdaAway *= 0.94;
  }
  // High heat/humidity also carries fly balls further — smaller, more
  // commonly-cited effect than wind; only applied when explicitly noted.
  if (weather.includes('hot') || weather.includes('humid')) {
    lambdaHome *= 1.02;
    lambdaAway *= 1.02;
  }

  lambdaHome = Math.min(lambdaHome, 8.0);
  lambdaAway = Math.min(lambdaAway, 8.0);

  return { lambdaHome, lambdaAway };
}

// TODO: once real MLB game history exists, build
// scripts/mlbIsotonicFit.ts (same architecture as nbaIsotonicFit.ts) and
// replace this passthrough with a real MLB_ISOTONIC_BLOCKS table, same
// pattern as applyBasketballIsotonicCalibration.
function applyBaseballIsotonicCalibration(rawProb: number): number {
  return rawProb; // TEMPORARY passthrough — no calibration data exists yet
}

function modelBaseball(input: ModelInput): MarketProbability[] {
  const { stats, odds } = input;
  const results: MarketProbability[] = [];

  const homeWR = formWinRate(stats.homeForm);
  const awayWR = formWinRate(stats.awayForm);
  const h2hHWR = h2hWinRate(stats.h2h, 'home');
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);

  // MLB home teams win roughly 54% of games historically (widely cited
  // figure, NOT independently backtested against this pipeline's data —
  // same caveat as HOME_COURT_ADVANTAGE in modelBasketball, which WAS
  // backtest-confirmed for NBA/WNBA. Treat this constant as a starting
  // guess pending a real fit.
  const HOME_FIELD_ADVANTAGE = 0.075;
  let homeWinProb = eloHome * 0.85 + 0.04 + HOME_FIELD_ADVANTAGE;

  const fatigue = stats.situational?.fatigueDays;
  if (fatigue !== undefined && fatigue < 1) {
    // Starting pitcher on short rest / bullpen day is a much bigger deal
    // in baseball than "fatigue" in basketball, but this model has no
    // pitcher-specific data yet — reusing the generic fatigue signal as a
    // rough proxy only. Smaller magnitude than basketball's 0.08 since
    // this is a weaker proxy for what actually matters in baseball.
    const homeFatigued = stats.additionalContext?.homeFatigue as boolean | undefined;
    if (homeFatigued) homeWinProb -= 0.04;
    else homeWinProb += 0.04;
  }

  homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb));

  // Calibrate only the favorite side, complement for the other — same
  // invariant-preserving pattern as basketball/football. Currently a
  // no-op passthrough (see applyBaseballIsotonicCalibration above).
  let calibratedHomeProb: number;
  let calibratedAwayProb: number;
  if (homeWinProb >= 0.5) {
    calibratedHomeProb = applyBaseballIsotonicCalibration(homeWinProb);
    calibratedAwayProb = 1 - calibratedHomeProb;
  } else {
    calibratedAwayProb = applyBaseballIsotonicCalibration(1 - homeWinProb);
    calibratedHomeProb = 1 - calibratedAwayProb;
  }

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: calibratedHomeProb, method: 'elo+homefield-uncalibrated-mlb' },
    { market: 'moneyline', selection: 'Away', trueProbability: calibratedAwayProb, method: 'elo+homefield-uncalibrated-mlb' },
  );

  const { lambdaHome, lambdaAway } = computeBaseballLambdas(stats);
  const totalLine = extractTotalLine(odds, 'totals', MLB_TOTALS_LINE_DEFAULT);
  const overProb = totalOverProbability(lambdaHome, lambdaAway, totalLine, 15);

  const totalsMethod = 'poisson-uncalibrated-mlb';

  if (overProb >= TOTALS_MIN_CONFIDENCE) {
    results.push({ market: 'totals', selection: `Over ${totalLine}`, trueProbability: overProb, method: totalsMethod });
  } else if ((1 - overProb) >= TOTALS_MIN_CONFIDENCE) {
    results.push({ market: 'totals', selection: `Under ${totalLine}`, trueProbability: 1 - overProb, method: totalsMethod });
  } else {
    results.push(
      { market: 'totals', selection: `Over ${totalLine}`, trueProbability: overProb, method: totalsMethod },
      { market: 'totals', selection: `Under ${totalLine}`, trueProbability: 1 - overProb, method: totalsMethod },
    );
  }

  return results;
}

// ─── NFL ────────────────────────────────────────────────────────
//
// STATUS: calibrated. Fitted via nflIsotonicFit.ts on pooled 2024-2025
// NFL regular seasons, 496 predictions.
//
// IMPORTANT — this is NOT a moneyline calibration. The fitted target was
// +3.5 HANDICAP COVER (did the model's picked side win outright, or lose
// by 3 or fewer), not plain win/loss — see conversation. The person
// applies the +3.5 handicap themselves at their bookmaker when placing
// the bet; the selection below still prints as plain "Home"/"Away" (see
// ALLOWED_TIP_MARKETS in tipScanner.ts), but the confidence number is
// honest about which bet it's actually calibrated for. tipScanner.ts's
// buildSignal() prints an explicit reminder for this reason.
//
// Formula reuses nflModel.ts's exact computeTeamStrengthFactor() +
// amplified-deviation-from-0.5 approach (yardage/turnover-based, NOT
// reimplemented here — the pre-computed per-team strength factors are
// written into additionalContext by nflStatsMapper.ts at sync time).
// AMPLIFICATION_FACTOR below MUST match nflModel.ts's own constant of
// the same name — if that ever changes, update both.
//
// Reliable range: x=0.5262-0.7182 (5 blocks, min weight 20 games,
// low-end/high-end noisy blocks excluded).

const NFL_AMPLIFICATION_FACTOR = 3.0; // must match nflModel.ts's AMPLIFICATION_FACTOR

const NFL_HANDICAP_ISOTONIC_BLOCKS: { x: number; y: number }[] = [
  { x: 0.5262, y: 0.6978 },
  { x: 0.5624, y: 0.7308 },
  { x: 0.6055, y: 0.7721 },
  { x: 0.6559, y: 0.7895 },
  { x: 0.7182, y: 0.8602 },
];

function applyNflHandicapIsotonicCalibration(rawProb: number): number {
  const blocks = NFL_HANDICAP_ISOTONIC_BLOCKS;

  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;

  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function modelNfl(input: ModelInput): MarketProbability[] {
  const { stats } = input;
  const results: MarketProbability[] = [];

  const ctx = stats.additionalContext || {};
  const homeStrength = ctx.homeStrengthFactor as number | undefined;
  const awayStrength = ctx.awayStrengthFactor as number | undefined;

  // Shouldn't happen — validator.ts's NFL branch already requires this
  // data to exist before stats get saved — but fail safe (return no
  // tips) rather than propagate NaN if it somehow does.
  if (homeStrength === undefined || awayStrength === undefined) {
    return results;
  }

  const total = homeStrength + awayStrength || 1;
  const strengthRatio = homeStrength / total; // 0.5 = evenly matched

  // Amplifies deviation from 0.5 rather than compressing it — see
  // nflModel.ts's CONFIDENCE_AMPLIFICATION comment for why (NFL's real
  // parity means strengthRatio naturally sits close to 0.5 even for real
  // mismatches; compression would squash out genuine signal).
  const deviation = strengthRatio - 0.5;
  let rawHomeWinProb = 0.5 + deviation * NFL_AMPLIFICATION_FACTOR;
  rawHomeWinProb = Math.max(0.05, Math.min(0.95, rawHomeWinProb));

  // Calibrate the favorite side, derive the other as its complement —
  // same invariant-preserving pattern as every other sport in this file.
  let calibratedHomeProb: number;
  let calibratedAwayProb: number;
  if (rawHomeWinProb >= 0.5) {
    calibratedHomeProb = applyNflHandicapIsotonicCalibration(rawHomeWinProb);
    calibratedAwayProb = 1 - calibratedHomeProb;
  } else {
    calibratedAwayProb = applyNflHandicapIsotonicCalibration(1 - rawHomeWinProb);
    calibratedHomeProb = 1 - calibratedAwayProb;
  }

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: calibratedHomeProb, method: 'yardage+turnover+amplified+isotonic-handicap' },
    { market: 'moneyline', selection: 'Away', trueProbability: calibratedAwayProb, method: 'yardage+turnover+amplified+isotonic-handicap' },
  );

  return results;
}

// ─── PUBLIC API ─────────────────────────────────────────────────

export function getProbabilities(input: ModelInput): MarketProbability[] {
  switch (input.match.sport) {
    case 'football':   return modelFootball(input);
    case 'tennis':     return modelTennis(input);
    case 'basketball': return modelBasketball(input);
    case 'hockey':     return modelHockey(input);
    case 'baseball':   return modelBaseball(input);
    case 'nfl':        return modelNfl(input);
    default:
      throw new Error(`[ProbabilityModel] Unknown sport: ${input.match.sport}`);
  }
}

export function getTotalProbabilityAtLine(input: ModelInput, line: number): number | null {
  if (input.match.sport === 'football') {
    const { lambdaHome, lambdaAway } = computeFootballLambdas(input.stats);
    return USE_DIXON_COLES_FOR_TOTALS
      ? totalOverProbabilityDixonColes(lambdaHome, lambdaAway, line)
      : totalOverProbability(lambdaHome, lambdaAway, line);
  }
  return null;
}