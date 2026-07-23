import { Stats, Odds, H2HRecord, FormRecord } from '../database/schema';

// ─── TYPES ─────────────────────────────────────────────────

export interface MarketProbability {
  market: string;
  selection: string;
  trueProbability: number;
  method: string;
}

export interface ModelInput {
  match: {
    id: string;
    sport: string;
    homeTeam: string;
    awayTeam: string;
    startTime: string;
  };
  stats: Stats;
  odds: Odds[];
}

interface FootballLambdas {
  lambdaHome: number;
  lambdaAway: number;
}

// ─── CONFIG ─────────────────────────────────────────────────

// Toggle: when true, football goals totals (1.5/2.5/3.5) use the
// Dixon-Coles corrected calculation instead of plain independent Poisson.
// Kept OFF by default — flip once Brier scores over real settled tips
// confirm it improves accuracy over the existing method. Does not affect
// corners, moneyline, handicap, BTTS, or any other sport.
const USE_DIXON_COLES_FOR_TOTALS = false;

// rho is a fixed literature value (typical range -0.05 to -0.15), not
// fitted per-league via MLE.
const DIXON_COLES_RHO = -0.1;

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

// Probability that total goals (home + away) exceed `line`, given lambdas.
function totalOverProbability(lambdaHome: number, lambdaAway: number, line: number, maxGoals = 8): number {
  let overProb = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      if (i + j > line) overProb += poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
    }
  }
  return overProb;
}

// ─── DIXON-COLES CORRECTION (isolated, toggleable) ─────────────────────────
//
// Applies the Dixon-Coles tau adjustment to fix known Poisson bias on
// low-scoring outcomes (0-0, 1-0, 0-1, 1-1). Kept SEPARATE from
// totalOverProbability so the original keeps running unchanged unless
// USE_DIXON_COLES_FOR_TOTALS is flipped on.

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

  // renormalize — tau shifts mass slightly off 1.0
  return total > 0 ? overProb / total : overProb;
}

// Full goal-margin distribution (home goals - away goals) -> probability
function marginDistribution(lambdaHome: number, lambdaAway: number, maxGoals = 8): Map<number, number> {
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

// Probability the HOME side covers a given Asian handicap line.
// line convention: negative = home is favored (must win by more than |line|).
//   e.g. line = -1.5 means home must win by 2+ goals to cover.
//   line = +1.5 means home covers unless they lose by 2+ goals.
// Quarter lines (e.g. -0.25, -0.75) are handled as an average of the two
// adjacent half-lines — a standard approximation for split-stake quarter lines.
// NOTE: this is an approximation, not a full split-stake EV model. Good enough
// for edge-detection purposes; flagged here for future refinement if needed.
function handicapCoverProbability(dist: Map<number, number>, line: number): number {
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
  return settled > 0 ? cover / settled : cover; // renormalized excluding pushes
}

// ─── FORM HELPERS ─────────────────────────────────────────────────

function formWinRate(form: FormRecord[]): number {
  if (!form.length) return 0.5;
  const wins = form.filter(f => f.result === 'W').length;
  return wins / form.length;
}

function formGoalsAvg(form: FormRecord[], key: 'goalsFor' | 'goalsAgainst'): number {
  const withData = form.filter(f => f[key] !== undefined);
  if (!withData.length) return 1.2;
  return withData.reduce((s, f) => s + (f[key] as number), 0) / withData.length;
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

// ─── FOOTBALL LAMBDA COMPUTATION (extracted so it's reusable) ──────────

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

// ─── CORNERS (single-floor totals, tip-scanner only) ───────────────────────
//
// Unlike goals, corners lambdas are NOT computed here — cornersAggregator.ts
// already writes the Dixon-Coles-blended expected corners (per side) directly
// to stats.homeCornersAvg/awayCornersAvg. This function just runs those two
// numbers through the same Poisson machinery already used for goals totals,
// then picks the HIGHEST line that still clears CORNERS_MIN_CONFIDENCE.
//
// NOTE: corners deliberately does NOT use the Dixon-Coles tau correction —
// rho is calibrated from goals data specifically; applying it to corners
// would be an unvalidated assumption. Plain Poisson stays here regardless
// of USE_DIXON_COLES_FOR_TOTALS.
const CORNERS_LINES = [7.5, 8.5, 9.5, 10.5, 11.5, 12.5];
const CORNERS_MIN_CONFIDENCE = 0.80;

function modelFootballCorners(stats: Stats): MarketProbability | null {
  const lambdaHome = stats.homeCornersAvg;
  const lambdaAway = stats.awayCornersAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const overProbs = CORNERS_LINES.map((line) => ({
    line,
    prob: totalOverProbability(lambdaHome, lambdaAway, line, 20),
  }));

  const clearingFloor = overProbs.filter((o) => o.prob >= CORNERS_MIN_CONFIDENCE);
  if (!clearingFloor.length) return null;

  const best = clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));
  return {
    market: 'corners_totals',
    selection: `Over ${best.line}`,
    trueProbability: best.prob,
    method: 'poisson-corners',
  };
}

// ─── SPORT MODELS ─────────────────────────────────────────────────

function modelFootball(input: ModelInput): MarketProbability[] {
  const { stats } = input;
  const results: MarketProbability[] = [];

  const { lambdaHome, lambdaAway } = computeFootballLambdas(stats);

  // ── 1X2 ────────────────────────────────────────────────
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

  // ── DOUBLE CHANCE (derived directly from blended 1X2 — no new modeling) ──
  results.push(
    { market: 'double_chance', selection: '1X', trueProbability: blended.home + blended.draw, method: 'derived-1x2' },
    { market: 'double_chance', selection: 'X2', trueProbability: blended.draw + blended.away, method: 'derived-1x2' },
    { market: 'double_chance', selection: '12', trueProbability: blended.home + blended.away, method: 'derived-1x2' },
  );

  // ── TOTALS: 1.5, 2.5, 3.5 (matches SportyBet's available lines) ──
  const TARGET_LINES = [1.5, 2.5, 3.5];

  for (const line of TARGET_LINES) {
    const overProb = USE_DIXON_COLES_FOR_TOTALS
      ? totalOverProbabilityDixonColes(lambdaHome, lambdaAway, line)
      : totalOverProbability(lambdaHome, lambdaAway, line);
    const method = USE_DIXON_COLES_FOR_TOTALS ? 'dixon-coles' : 'poisson';
    results.push(
      { market: 'totals', selection: `Over ${line}`, trueProbability: overProb, method },
      { market: 'totals', selection: `Under ${line}`, trueProbability: 1 - overProb, method },
    );
  }

  // ── ASIAN HANDICAP: standard set of lines a sharp book typically posts ──
  const HANDICAP_LINES = [-1.5, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5];
  const dist = marginDistribution(lambdaHome, lambdaAway);

  for (const line of HANDICAP_LINES) {
    const homeCoverProb = handicapCoverProbability(dist, line);
    results.push(
      { market: 'handicap', selection: `Home ${line >= 0 ? '+' : ''}${line}`, trueProbability: homeCoverProb, method: 'poisson-margin' },
      { market: 'handicap', selection: `Away ${-line >= 0 ? '+' : ''}${-line}`, trueProbability: 1 - homeCoverProb, method: 'poisson-margin' },
    );
  }

  // ── BTTS ────────────────────────────────────────────────
  const pHomeScores = 1 - poissonPmf(lambdaHome, 0);
  const pAwayScores = 1 - poissonPmf(lambdaAway, 0);
  const bttsYes = pHomeScores * pAwayScores;
  results.push(
    { market: 'btts', selection: 'Yes', trueProbability: bttsYes, method: 'poisson' },
    { market: 'btts', selection: 'No', trueProbability: 1 - bttsYes, method: 'poisson' },
  );

  // ── CORNERS: sweet-spot single-line tip (see modelFootballCorners) ──
  const cornersTip = modelFootballCorners(stats);
  if (cornersTip) results.push(cornersTip);

  return results;
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
  results.push(
    { market: 'moneyline', selection: input.match.homeTeam, trueProbability: homeWinProb, method: 'elo+surface' },
    { market: 'moneyline', selection: input.match.awayTeam, trueProbability: 1 - homeWinProb, method: 'elo+surface' },
  );
  return results;
}

function modelBasketball(input: ModelInput): MarketProbability[] {
  const { stats, odds } = input;
  const results: MarketProbability[] = [];

  const homeWR = formWinRate(stats.homeForm);
  const awayWR = formWinRate(stats.awayForm);
  const h2hHWR = h2hWinRate(stats.h2h, 'home');
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);

  let homeWinProb = eloHome * 0.85 + 0.04;

  const fatigue = stats.situational?.fatigueDays;
  if (fatigue !== undefined && fatigue < 2) {
    const homeFatigued = stats.additionalContext?.homeFatigue as boolean | undefined;
    if (homeFatigued) homeWinProb -= 0.08;
    else homeWinProb += 0.08;
  }

  homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb));

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: homeWinProb, method: 'elo+fatigue' },
    { market: 'moneyline', selection: 'Away', trueProbability: 1 - homeWinProb, method: 'elo+fatigue' },
  );

  const homeOffAvg = (stats.additionalContext?.homePpgFor as number | undefined) ?? 80;
  const awayOffAvg = (stats.additionalContext?.awayPpgFor as number | undefined) ?? 80;
  const homeDefAvg = (stats.additionalContext?.homePpgAgainst as number | undefined) ?? 80;
  const awayDefAvg = (stats.additionalContext?.awayPpgAgainst as number | undefined) ?? 80;

  const pace = (stats.additionalContext?.pace as number | undefined) || 100;
  const paceMultiplier = pace / 100;
  const expectedTotal = ((homeOffAvg + awayDefAvg) / 2 + (awayOffAvg + homeDefAvg) / 2) * paceMultiplier;

  let foulAdj = 1.0;
  if (stats.referee?.avgFouls) {
    if (stats.referee.avgFouls > 50) foulAdj = 1.04;
    if (stats.referee.avgFouls < 35) foulAdj = 1.03;
  }
  const adjustedTotal = expectedTotal * foulAdj;

  const totalLine = extractTotalLine(odds, 'totals', 165.5);
  const sd = 10;
  const z = (totalLine - adjustedTotal) / sd;
  const overProb = 1 - normalCdf(z);

  results.push(
    { market: 'totals', selection: `Over ${totalLine}`, trueProbability: overProb, method: 'ppg+pace+normal' },
    { market: 'totals', selection: `Under ${totalLine}`, trueProbability: 1 - overProb, method: 'ppg+pace+normal' },
  );

  return results;
}

function modelHockey(input: ModelInput): MarketProbability[] {
  const { stats, odds } = input;
  const results: MarketProbability[] = [];

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

  lambdaHome = Math.min(lambdaHome, 4.5);
  lambdaAway = Math.min(lambdaAway, 4.5);

  const raw = poissonMatchProbs(lambdaHome, lambdaAway);

  const h2hHWR = h2hWinRate(stats.h2h, 'home');
  const homeWR = formWinRate(stats.homeForm);
  const awayWR = formWinRate(stats.awayForm);
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);

  const otProb = raw.draw;
  const blended = normalize({
    home: raw.home * 0.7 + eloHome * 0.3 + otProb * 0.5,
    away: raw.away * 0.7 + (1 - eloHome) * 0.3 + otProb * 0.5,
  });

  results.push(
    { market: 'moneyline', selection: 'Home', trueProbability: blended.home, method: 'poisson+elo' },
    { market: 'moneyline', selection: 'Away', trueProbability: blended.away, method: 'poisson+elo' },
  );

  let puckLineHome = 0;
  for (let i = 0; i <= 8; i++) {
    for (let j = 0; j <= 8; j++) {
      if (i - j >= 2) puckLineHome += poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
    }
  }
  results.push(
    { market: 'puck_line', selection: 'Home -1.5', trueProbability: puckLineHome, method: 'poisson' },
    { market: 'puck_line', selection: 'Away +1.5', trueProbability: 1 - puckLineHome, method: 'poisson' },
  );

  const over55 = totalOverProbability(lambdaHome, lambdaAway, 5.5);
  results.push(
    { market: 'totals', selection: 'Over 5.5', trueProbability: over55, method: 'poisson' },
    { market: 'totals', selection: 'Under 5.5', trueProbability: 1 - over55, method: 'poisson' },
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
    default:
      throw new Error(`[ProbabilityModel] Unknown sport: ${input.match.sport}`);
  }
}

// Ask the model for the true probability of "Over `line`" at an ARBITRARY
// line — not just the fixed TARGET_LINES.
export function getTotalProbabilityAtLine(input: ModelInput, line: number): number | null {
  if (input.match.sport === 'football') {
    const { lambdaHome, lambdaAway } = computeFootballLambdas(input.stats);
    return USE_DIXON_COLES_FOR_TOTALS
      ? totalOverProbabilityDixonColes(lambdaHome, lambdaAway, line)
      : totalOverProbability(lambdaHome, lambdaAway, line);
  }
  if (input.match.sport === 'hockey') {
    const { stats } = input;
    let lambdaHome = weightedGoalsAvg(stats.homeForm.filter(f => f.venue === 'home'), 'goalsFor');
    let lambdaAway = weightedGoalsAvg(stats.awayForm.filter(f => f.venue === 'away'), 'goalsFor');
    const h2hHomeGoals = stats.h2h.reduce((s, r) => s + r.homeScore, 0) / (stats.h2h.length || 1);
    const h2hAwayGoals = stats.h2h.reduce((s, r) => s + r.awayScore, 0) / (stats.h2h.length || 1);
    lambdaHome = lambdaHome * 0.7 + h2hHomeGoals * 0.3;
    lambdaAway = lambdaAway * 0.7 + h2hAwayGoals * 0.3;
    lambdaHome *= 1.06;
    lambdaHome = Math.min(lambdaHome, 4.5);
    lambdaAway = Math.min(lambdaAway, 4.5);
    return totalOverProbability(lambdaHome, lambdaAway, line);
  }
  return null;
}

// Ask the model for the home-side cover probability at an ARBITRARY
// handicap line.
export function getHandicapProbabilityAtLine(input: ModelInput, homeLine: number): number | null {
  if (input.match.sport !== 'football') return null;
  const { lambdaHome, lambdaAway } = computeFootballLambdas(input.stats);
  const dist = marginDistribution(lambdaHome, lambdaAway);
  return handicapCoverProbability(dist, homeLine);
}