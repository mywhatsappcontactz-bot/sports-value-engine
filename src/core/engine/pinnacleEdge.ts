// src/core/engine/pinnacleEdge.ts
import { Odds } from '../database/schema';

// ─── TYPES ───────────────────────────────────────────────

export interface PinnacleSignal {
  hasPinnacle: boolean;
  pinnacleImplied: number | null;    // Pinnacle's implied probability for this selection
  modelDelta: number | null;          // our model - pinnacle (positive = we're higher)
  sharpMoneySignal: number;           // 0.0 to 1.0
  flagged: boolean;                  // true if model diverges too far from Pinnacle
  reason: string;
}

// ─── CONSTANTS ───────────────────────────────────────────

const MAX_MODEL_DIVERGENCE = 0.08;   // >8% from Pinnacle = model is likely wrong
const STRONG_AGREEMENT_THRESHOLD = 0.03; // within 3% = strong signal
const PINNACLE_BOOKMAKER = 'Pinnacle';

// ─── PINNACLE EDGE ───────────────────────────────────────

export function getPinnacleSignal(
  market: string,
  selection: string,
  trueProbability: number,
  allOdds: Odds[],
  softBookmakerImplied: number,
): PinnacleSignal {
  const pinnacleOdds = allOdds.find(
    o =>
      o.bookmaker === PINNACLE_BOOKMAKER &&
      o.market === market &&
      o.selection === selection,
  );

  if (!pinnacleOdds) {
    return {
      hasPinnacle: false,
      pinnacleImplied: null,
      modelDelta: null,
      sharpMoneySignal: 0.0,
      flagged: false,
      reason: 'No Pinnacle line — signal unvalidated',
    };
  }

  const devigged =
    devigPinnacle(market, selection, allOdds) ??
    pinnacleOdds.impliedProbability;

  const modelDelta = trueProbability - devigged;
  const absDelta = Math.abs(modelDelta);

  // ── LARGE DIVERGENCE ────────────────────────────────
  if (absDelta > MAX_MODEL_DIVERGENCE) {
    return {
      hasPinnacle: true,
      pinnacleImplied: devigged,
      modelDelta,
      sharpMoneySignal: 0.0,
      flagged: true,
      reason: `Model diverges ${(modelDelta * 100).toFixed(
        1,
      )}% from Pinnacle — exceeds ${MAX_MODEL_DIVERGENCE * 100}% threshold`,
    };
  }

  const modelBeatsSoft = trueProbability > softBookmakerImplied;
  const pinnacleBeatsSoft = devigged > softBookmakerImplied;

  // ── STRONG AGREEMENT ────────────────────────────────
  if (
    absDelta <= STRONG_AGREEMENT_THRESHOLD &&
    modelBeatsSoft &&
    pinnacleBeatsSoft
  ) {
    return {
      hasPinnacle: true,
      pinnacleImplied: devigged,
      modelDelta,
      sharpMoneySignal: 1.0,
      flagged: false,
      reason: `Strong signal: model and Pinnacle agree within ${(absDelta *
        100
      ).toFixed(1)}%, both beat soft line`,
    };
  }

  // ── MODERATE AGREEMENT ──────────────────────────────
  if (absDelta <= STRONG_AGREEMENT_THRESHOLD) {
    return {
      hasPinnacle: true,
      pinnacleImplied: devigged,
      modelDelta,
      sharpMoneySignal: 0.7,
      flagged: false,
      reason: `Model agrees with Pinnacle (Δ${(modelDelta * 100).toFixed(
        1,
      )}%) but soft line edge weak`,
    };
  }

  // ── WEAK AGREEMENT ──────────────────────────────────
  return {
    hasPinnacle: true,
    pinnacleImplied: devigged,
    modelDelta,
    sharpMoneySignal: 0.5,
    flagged: false,
    reason: `Moderate Pinnacle alignment (Δ${(modelDelta * 100).toFixed(
      1,
    )}%)`,
  };
}

// ─── DEVIG ───────────────────────────────────────────────

function devigPinnacle(
  market: string,
  selection: string,
  allOdds: Odds[],
): number | null {
  const pinnacleLines = allOdds.filter(
    o => o.bookmaker === PINNACLE_BOOKMAKER && o.market === market,
  );

  if (pinnacleLines.length < 2) return null;

  const overround = pinnacleLines.reduce(
    (s, o) => s + o.impliedProbability,
    0,
  );

  if (overround <= 0) return null;

  const target = pinnacleLines.find(o => o.selection === selection);
  if (!target) return null;

  return target.impliedProbability / overround;
}