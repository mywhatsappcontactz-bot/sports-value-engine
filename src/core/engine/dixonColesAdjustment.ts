// src/core/engine/dixonColesAdjustment.ts
//
// Applies the Dixon-Coles tau correction to fix known Poisson bias on
// low-scoring outcomes (0-0, 1-0, 0-1, 1-1). Use AFTER lambdaHome/lambdaAway
// are computed (from goalsAggregator.ts or fcStats-based lambdas), and
// BEFORE building the full scoreline probability matrix used for
// Over/Under edge calculations.
//
// rho is typically -0.05 to -0.15 in professional football. Using a fixed
// literature value here (not fitted per-league) — see conversation notes
// on why a full MLE fit was deferred.

const DEFAULT_RHO = -0.1;

export function dixonColesTau(
  homeGoals: number,
  awayGoals: number,
  lambdaHome: number,
  lambdaAway: number,
  rho: number = DEFAULT_RHO
): number {
  if (homeGoals === 0 && awayGoals === 0) {
    return 1 - lambdaHome * lambdaAway * rho;
  }
  if (homeGoals === 1 && awayGoals === 0) {
    return 1 + lambdaAway * rho; // Fixed: uses lambdaAway
  }
  if (homeGoals === 0 && awayGoals === 1) {
    return 1 + lambdaHome * rho; // Fixed: uses lambdaHome
  }
  if (homeGoals === 1 && awayGoals === 1) {
    return 1 - rho;
  }
  return 1;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

/**
 * Builds the full scoreline probability matrix (0..maxGoals for each side),
 * with Dixon-Coles correction applied to the four low-score cells.
 * matrix[h][a] = P(home scores h, away scores a)
 */
export function buildCorrectedScoreMatrix(
  lambdaHome: number,
  lambdaAway: number,
  maxGoals: number = 8,
  rho: number = DEFAULT_RHO
): number[][] {
  const matrix: number[][] = [];

  for (let h = 0; h <= maxGoals; h++) {
    matrix[h] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const basePoisson = poissonPmf(h, lambdaHome) * poissonPmf(a, lambdaAway);
      const tau = dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      matrix[h][a] = basePoisson * tau;
    }
  }

  // Renormalize so total probability sums to 1 (tau adjustments shift mass
  // slightly off 1.0 across the truncated grid).
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) total += matrix[h][a];
  }
  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) matrix[h][a] /= total;
  }

  return matrix;
}

/**
 * Sums the matrix to get P(total goals > line) — e.g. Over 2.5, Under 3.5.
 */
export function probabilityOverUnder(
  matrix: number[][],
  line: number,
  direction: 'over' | 'under'
): number {
  let prob = 0;
  const maxGoals = matrix.length - 1;

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const total = h + a;
      if (direction === 'over' && total > line) prob += matrix[h][a];
      if (direction === 'under' && total < line) prob += matrix[h][a];
    }
  }

  return prob;
}