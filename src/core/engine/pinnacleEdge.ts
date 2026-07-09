// src/core/engine/pinnacleEdge.ts
import { Odds } from '../database/schema';

// ─── TYPES ─────────────────────────────────────────────────

export interface PinnacleSignal {
  hasPinnacle: boolean;
  pinnacleImplied: number | null;    // Pinnacle's implied probability for this selection
  modelDelta: number | null;          // our model - pinnacle (positive = we're higher)
  sharpMoneySignal: number;           // 0.0 to 1.0
  flagged: boolean;                  // true if model diverges too far from Pinnacle
  reason: string;
}

// Extended signal used for quarter-line inference (Pinnacle doesn't offer
// the exact line we want, but offers a nearby Asian line we can use as
// validation once our own model also prices that same nearby line).
export interface QuarterLineSignal extends PinnacleSignal {
  tier: 'high' | 'medium' | 'reject' | 'none';
  pinnacleLine: number | null;
  inferredFrom: string | null; // e.g. "Pinnacle Over 2.25"
}

// ─── CONSTANTS ─────────────────────────────────────────────────

const MAX_MODEL_DIVERGENCE = 0.08;   // >8% from Pinnacle = model is likely wrong
const STRONG_AGREEMENT_THRESHOLD = 0.03; // within 3% = strong signal
const PINNACLE_BOOKMAKER = 'Pinnacle';

// Quarter-line confidence gates (per agreed strategy):
// model must clear this floor before a quarter-line inference is even
// considered eligible, regardless of what Pinnacle shows.
const MODEL_PROBABILITY_FLOOR = 0.65;
const HIGH_CONFIDENCE_FLOOR = 0.75;

// Cross-line signals are derived, not direct — cap their sharpMoneySignal
// below what an exact Pinnacle match can achieve (1.0), so the engine
// never treats an inferred read as equal to a direct sharp-line match.
const QUARTER_LINE_SIGNAL_CAP = 0.6;

// Confirmed mapping: when Pinnacle posts one of these quarter/odd lines,
// these are the "safer step-down" European lines it's used to validate.
// Extend this table as you observe more Pinnacle line patterns.
const QUARTER_LINE_MAP: Record<number, string[]> = {
  2.25: ['Over 1.5'],
  2.75: ['Over 1.5', 'Over 2.5'],
  3.25: ['Over 2.5', 'Under 2.5'],
  3.75: ['Under 2.5', 'Under 3.5'],
};

// ─── PINNACLE EDGE (exact-match path — unchanged behavior) ──────────

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

  // ── LARGE DIVERGENCE ─────────────────────────────────────
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

  // ── STRONG AGREEMENT ─────────────────────────────────────
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

  // ── MODERATE AGREEMENT ─────────────────────────────────────
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

  // ── WEAK AGREEMENT ─────────────────────────────────────────
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

// ─── QUARTER-LINE INFERENCE (new) ─────────────────────────────────────

// Extracts the numeric line from a selection string like "Over 2.25".
function parseLine(selection: string): number | null {
  const match = selection.match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

function parseDirection(selection: string): 'Over' | 'Under' | null {
  if (selection.startsWith('Over')) return 'Over';
  if (selection.startsWith('Under')) return 'Under';
  return null;
}

// Scans allOdds for whichever Pinnacle totals lines actually exist on this
// match (2.25, 2.75, 3.25, whatever — discovered, not assumed), and checks
// whether any of them maps (per QUARTER_LINE_MAP) to the candidate
// selection we want to bet (e.g. "Over 1.5").
function findQuarterLineMatch(
  candidateSelection: string,
  allOdds: Odds[],
  market: string,
): { pinnacleLine: number; pinnacleSelection: string } | null {
  const pinnacleTotals = allOdds.filter(
    o => o.bookmaker === PINNACLE_BOOKMAKER && o.market === market,
  );
  if (!pinnacleTotals.length) return null;

  const linesPresent = new Set<number>();
  for (const o of pinnacleTotals) {
    const line = parseLine(o.selection);
    if (line !== null) linesPresent.add(line);
  }

  for (const line of linesPresent) {
    const candidates = QUARTER_LINE_MAP[line];
    if (candidates && candidates.includes(candidateSelection)) {
      // direction of the mapped candidate determines which side of
      // Pinnacle's quarter line we reference for the implied probability
      const direction = parseDirection(candidateSelection);
      const pinnacleSelection = `${direction} ${line}`;
      const exists = pinnacleTotals.some(o => o.selection === pinnacleSelection);
      if (exists) {
        return { pinnacleLine: line, pinnacleSelection };
      }
    }
  }

  return null;
}

/**
 * Quarter-line inference signal. Use when getPinnacleSignal() returns
 * hasPinnacle: false for a totals bet, before giving up on Pinnacle
 * validation entirely.
 *
 * Priority ladder this implements (as agreed):
 *   1. Exact Pinnacle match  -> handled by getPinnacleSignal(), not this fn
 *   2. No exact match, but a mapped quarter line exists -> THIS function
 *   3. Nothing at all -> caller falls through to no-Pinnacle tier
 *
 * The bet's actual trueProbability always comes from the model
 * (getTotalProbabilityAtLine in probabilityModel.ts), never from Pinnacle
 * directly. Pinnacle here only confirms or rejects — it doesn't set price.
 */
export function getQuarterLineSignal(
  candidateSelection: string,       // e.g. "Over 1.5" — the bet we actually want to place
  candidateTrueProbability: number, // model's own probability for candidateSelection
  allOdds: Odds[],
  market: string = 'totals',
): QuarterLineSignal {
  const base: QuarterLineSignal = {
    hasPinnacle: false,
    pinnacleImplied: null,
    modelDelta: null,
    sharpMoneySignal: 0.0,
    flagged: false,
    reason: 'No quarter-line match available',
    tier: 'none',
    pinnacleLine: null,
    inferredFrom: null,
  };

  // Gate 1: model itself has to believe in this bet before Pinnacle is
  // even consulted. A quarter-line agreement can't rescue a weak model read.
  if (candidateTrueProbability < MODEL_PROBABILITY_FLOOR) {
    return {
      ...base,
      tier: 'reject',
      reason: `Model probability ${(candidateTrueProbability * 100).toFixed(
        1,
      )}% below ${MODEL_PROBABILITY_FLOOR * 100}% floor — not eligible for quarter-line inference`,
    };
  }

  const match = findQuarterLineMatch(candidateSelection, allOdds, market);
  if (!match) {
    return base; // tier: 'none' — no usable Pinnacle quarter line for this bet
  }

  const devigged = devigPinnacle(market, match.pinnacleSelection, allOdds);
  if (devigged === null) {
    return {
      ...base,
      pinnacleLine: match.pinnacleLine,
      inferredFrom: `Pinnacle ${match.pinnacleSelection}`,
      reason: `Found Pinnacle ${match.pinnacleSelection} but could not devig it`,
    };
  }

  const modelDelta = candidateTrueProbability - devigged;

  // Gate 2: does Pinnacle's own probability at ITS line also lean the
  // same direction (>50%) as what we're inferring? If Pinnacle's quarter
  // line itself is weak/uncertain, it's not a confirming signal.
  const pinnacleLeansCorrectDirection = devigged > 0.5;

  if (!pinnacleLeansCorrectDirection) {
    return {
      hasPinnacle: true,
      pinnacleImplied: devigged,
      modelDelta,
      sharpMoneySignal: 0.0,
      flagged: false,
      reason: `Pinnacle ${match.pinnacleSelection} implied probability (${(devigged * 100).toFixed(
        1,
      )}%) doesn't confirm direction — no inference`,
      tier: 'reject',
      pinnacleLine: match.pinnacleLine,
      inferredFrom: `Pinnacle ${match.pinnacleSelection}`,
    };
  }

  const tier: 'high' | 'medium' =
    candidateTrueProbability >= HIGH_CONFIDENCE_FLOOR ? 'high' : 'medium';

  const sharpMoneySignal = tier === 'high' ? QUARTER_LINE_SIGNAL_CAP : QUARTER_LINE_SIGNAL_CAP * 0.7;

  return {
    hasPinnacle: true,
    pinnacleImplied: devigged,
    modelDelta,
    sharpMoneySignal,
    flagged: false,
    reason: `Quarter-line inference: Pinnacle ${match.pinnacleSelection} (${(devigged * 100).toFixed(
      1,
    )}%) confirms model's ${candidateSelection} read (${(candidateTrueProbability * 100).toFixed(1)}%) — ${tier} confidence`,
    tier,
    pinnacleLine: match.pinnacleLine,
    inferredFrom: `Pinnacle ${match.pinnacleSelection}`,
  };
}

// ─── DEVIG ─────────────────────────────────────────────────────
//
// FIX: previously this summed impliedProbability across EVERY Pinnacle
// selection in the market, regardless of line. For totals with multiple
// lines posted (e.g. Over/Under 2.5 AND Over/Under 3.25 on the same
// match), that produced a nonsense overround well above 100% and
// corrupted the devigged probability for every totals bet. Now it groups
// strictly by the same numeric line as the target selection (Over X /
// Under X pair only). Markets without a parseable line (moneyline,
// double_chance, btts) fall back to the original market-wide grouping,
// which is correct for them since there's only one line set.

function devigPinnacle(
  market: string,
  selection: string,
  allOdds: Odds[],
): number | null {
  const pinnacleLines = allOdds.filter(
    o => o.bookmaker === PINNACLE_BOOKMAKER && o.market === market,
  );

  if (pinnacleLines.length < 2) return null;

  const targetLine = parseLine(selection);

  const group = targetLine !== null
    ? pinnacleLines.filter(o => parseLine(o.selection) === targetLine)
    : pinnacleLines;

  if (group.length < 2) return null;

  const overround = group.reduce((s, o) => s + o.impliedProbability, 0);
  if (overround <= 0) return null;

  const target = group.find(o => o.selection === selection);
  if (!target) return null;

  return target.impliedProbability / overround;
}