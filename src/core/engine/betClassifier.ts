// src/core/engine/betClassifier.ts
export type BetTier = 'TIER_1_STRONG' | 'TIER_2_MEDIUM' | 'TIER_3_SPECULATIVE' | 'REJECT';

export interface ClassificationInput {
  edge: number;
  pinnacleDivergence: number;
  modelConfidence: number;
  market: string;
}

export interface BetDecision {
  tier: BetTier;
  action: 'PROCEED' | 'REJECT';
  stakeMultiplier: number;
  reason: string;
}

export class BetClassifier {
  private static readonly MAX_PINNACLE_DIVERGENCE = 0.08;
  private static readonly MIN_EDGE = 0.02;

  // Market-specific minimum edge overrides. Double Chance is
  // synthetically derived from the same h2h odds your model already
  // sees (not an independently-priced bookmaker line), and Handicap
  // relies on a quarter-line averaging approximation for split-stake
  // pricing — both carry extra imprecision beyond Totals/Moneyline's
  // direct bookmaker-vs-model comparison, so they need a larger margin
  // before an "edge" is trustworthy rather than noise from the
  // approximation itself. Markets not listed here fall back to
  // MIN_EDGE.
  private static readonly MARKET_MIN_EDGE: Record<string, number> = {
    double_chance: 0.05,
    handicap: 0.04,
  };

  private static minEdgeFor(market: string): number {
    return this.MARKET_MIN_EDGE[market] ?? this.MIN_EDGE;
  }

  public static classify(input: ClassificationInput): BetDecision {
    const { edge, pinnacleDivergence, modelConfidence, market } = input;
    const minEdge = this.minEdgeFor(market);

    // 1. Hard Guardrail Checks
    if (pinnacleDivergence > this.MAX_PINNACLE_DIVERGENCE) {
      return {
        tier: 'REJECT',
        action: 'REJECT',
        stakeMultiplier: 0,
        reason: `Pinnacle anomaly: Divergence (${(pinnacleDivergence * 100).toFixed(1)}%) exceeds 8% limit.`,
      };
    }

    if (edge < minEdge) {
      return {
        tier: 'REJECT',
        action: 'REJECT',
        stakeMultiplier: 0,
        reason: `Insufficient edge: ${(edge * 100).toFixed(2)}% is below minimum ${(minEdge * 100).toFixed(0)}% threshold for ${market}.`,
      };
    }

    // 2. Tier Classification — direct thresholds, no dead intermediate scoring
    // Tier boundaries scale off the market's own minEdge rather than a
    // flat number, so a stricter market's "strong" tier still means
    // something stronger than its own floor, not an absolute number
    // borrowed from a different market.
    const tier1Edge = Math.max(0.05, minEdge + 0.03);
    const tier2Edge = Math.max(0.03, minEdge + 0.01);

    if (edge >= tier1Edge && pinnacleDivergence <= 0.04 && modelConfidence >= 0.7) {
      return {
        tier: 'TIER_1_STRONG',
        action: 'PROCEED',
        stakeMultiplier: Math.min(1.2, 1.0 + (modelConfidence - 0.7)),
        reason: `Strong setup. Clean edge (${(edge * 100).toFixed(1)}%) supported by sharp validation.`,
      };
    }

    if (edge >= tier2Edge && pinnacleDivergence <= 0.06) {
      return {
        tier: 'TIER_2_MEDIUM',
        action: 'PROCEED',
        stakeMultiplier: 0.75,
        reason: `Balanced value. Sustainable edge (${(edge * 100).toFixed(1)}%) within safe limits.`,
      };
    }

    if (edge >= minEdge && pinnacleDivergence <= 0.08) {
      return {
        tier: 'TIER_3_SPECULATIVE',
        action: 'PROCEED',
        stakeMultiplier: 0.35,
        reason: `Speculative margin. Low edge or high market friction.`,
      };
    }

    return {
      tier: 'REJECT',
      action: 'REJECT',
      stakeMultiplier: 0,
      reason: `Edge ${(edge * 100).toFixed(2)}% or divergence ${(pinnacleDivergence * 100).toFixed(1)}% below tier thresholds.`,
    };
  }
}