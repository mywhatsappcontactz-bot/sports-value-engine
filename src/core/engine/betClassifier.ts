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

  public static classify(input: ClassificationInput): BetDecision {
    const { edge, pinnacleDivergence, modelConfidence } = input;

    // 1. Hard Guardrail Checks
    if (pinnacleDivergence > this.MAX_PINNACLE_DIVERGENCE) {
      return {
        tier: 'REJECT',
        action: 'REJECT',
        stakeMultiplier: 0,
        reason: `Pinnacle anomaly: Divergence (${(pinnacleDivergence * 100).toFixed(1)}%) exceeds 8% limit.`,
      };
    }

    if (edge < this.MIN_EDGE) {
      return {
        tier: 'REJECT',
        action: 'REJECT',
        stakeMultiplier: 0,
        reason: `Insufficient edge: ${(edge * 100).toFixed(2)}% is below minimum 2% threshold.`,
      };
    }

    // 2. Tier Classification — direct thresholds, no dead intermediate scoring
    if (edge >= 0.05 && pinnacleDivergence <= 0.04 && modelConfidence >= 0.7) {
      return {
        tier: 'TIER_1_STRONG',
        action: 'PROCEED',
        stakeMultiplier: Math.min(1.2, 1.0 + (modelConfidence - 0.7)),
        reason: `Strong setup. Clean edge (${(edge * 100).toFixed(1)}%) supported by sharp validation.`,
      };
    }

    if (edge >= 0.03 && pinnacleDivergence <= 0.06) {
      return {
        tier: 'TIER_2_MEDIUM',
        action: 'PROCEED',
        stakeMultiplier: 0.75,
        reason: `Balanced value. Sustainable edge (${(edge * 100).toFixed(1)}%) within safe limits.`,
      };
    }

    if (edge >= 0.02 && pinnacleDivergence <= 0.08) {
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