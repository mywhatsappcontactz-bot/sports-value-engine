// src/core/engine/kellyCalculator.ts

// ─── TYPES ───────────────────────────────────────────────

export interface KellyResult {
  kellyStake: number;       // fraction of bankroll to stake
  fullKelly: number;        // for audit — never use this
  quarterKelly: number;     // base before confidence adj
  confidenceMultiplier: number;
  cappedAt: number | null;  // null if under cap
}

// ─── CONSTANTS ───────────────────────────────────────────

const KELLY_FRACTION = 0.25;    // quarter Kelly
const MAX_STAKE = 0.03;         // hard cap: 3% of bankroll per bet

// ─── KELLY CALCULATOR ────────────────────────────────────

/**
 * Quarter Kelly with confidence adjustment and 3% bankroll hard cap.
 *
 * Formula:
 *   fullKelly   = edge / (bookmakerOdds - 1)
 *   quarterKelly = fullKelly * 0.25
 *   kellyStake  = quarterKelly * confidenceMultiplier
 *   kellyStake  = min(kellyStake, 0.03)
 *
 * confidenceMultiplier is the validator's confidenceAdjustment — already
 * a product of all the sport-specific penalty factors applied in validator.ts.
 */
export function calculateKelly(
  edge: number,
  bookmakerOdds: number,
  confidenceMultiplier: number,
): KellyResult {
  if (edge <= 0 || bookmakerOdds <= 1) {
    return {
      kellyStake: 0,
      fullKelly: 0,
      quarterKelly: 0,
      confidenceMultiplier,
      cappedAt: null,
    };
  }

  const fullKelly = edge / (bookmakerOdds - 1);
  const quarterKelly = fullKelly * KELLY_FRACTION;
  const adjusted = quarterKelly * Math.max(0, Math.min(1, confidenceMultiplier));
  const capped = Math.min(adjusted, MAX_STAKE);

  return {
    kellyStake: parseFloat(capped.toFixed(6)),
    fullKelly: parseFloat(fullKelly.toFixed(6)),
    quarterKelly: parseFloat(quarterKelly.toFixed(6)),
    confidenceMultiplier: parseFloat(confidenceMultiplier.toFixed(4)),
    cappedAt: adjusted > MAX_STAKE ? MAX_STAKE : null,
  };
}