// src/core/engine/valueEngine.ts
import { Repository } from '../database/repository';
import { Match, Stats, Odds, ValueBet } from '../database/schema';
import { Validator } from '../../data-bridge/validator';
import { getProbabilities, ModelInput } from './probabilityModel';
import { getPinnacleSignal } from './pinnacleEdge';
import { calculateKelly } from './kellyCalculator';
import { BetClassifier } from './betClassifier'; 
import { logger } from '../utils/logger';

export interface EngineResult {
  matchesProcessed: number;
  betsEvaluated: number;
  betsFound: number;
  betsFlagged: number;   
  betsRejected: number;  
  valueBets: ValueBet[];
  durationMs: number;
}

function buildDefaultStats(matchId: string, sport: string): Stats {
  return {
    id: 'default',
    matchId,
    sport,
    h2h: [],
    homeForm: [],
    awayForm: [],
    referee: {},
    situational: {},
    additionalContext: {},
    confidenceFactors: {
      dataCompleteness: 0.35,
      h2hSampleSize: 0,
      formSampleSize: 0,
    },
  } as any;
}

export class ValueEngine {
  private validator = new Validator();
  
  public minPinnacleSignal = 0.3;
  public skipOnPinnacleFlag = true;

  constructor(private repo: Repository) {}

  async run(sport?: string): Promise<EngineResult> {
    const start = Date.now();
    const result: EngineResult = {
      matchesProcessed: 0,
      betsEvaluated: 0,
      betsFound: 0,
      betsFlagged: 0,
      betsRejected: 0,
      valueBets: [],
      durationMs: 0,
    };

    const matches = this.repo.getUpcomingMatches(sport);
    logger.info('[Engine] Starting value scan', { matches: matches.length, sport: sport || 'all' });

    for (const match of matches) {
      const stats = this.repo.getStats(match.id) ?? buildDefaultStats(match.id, match.sport);

      const allOdds = this.repo.getLatestOdds(match.id);
      if (!allOdds.length) {
        logger.debug('[Engine] No odds — skipping', { matchId: match.id });
        continue;
      }

      result.matchesProcessed++;

      let marketProbs: ReturnType<typeof getProbabilities>;
      try {
        const input: ModelInput = {
          match: {
            id: match.id,
            sport: match.sport,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            startTime: match.startTime,
          },
          stats,
          odds: allOdds,
        };
        marketProbs = getProbabilities(input);
      } catch (err: any) {
        logger.error('[Engine] Probability model failed', { matchId: match.id, error: err.message });
        continue;
      }

      for (const prob of marketProbs) {
        const softLines = allOdds.filter(
          o => o.market === prob.market &&
               o.selection === prob.selection &&
               o.bookmaker !== 'Pinnacle',
        );

        for (const line of softLines) {
          result.betsEvaluated++;

          const bookmakerLines = allOdds.filter(
            o => o.bookmaker === line.bookmaker && o.market === line.market
          );
          const overround = bookmakerLines.reduce((s, o) => s + o.impliedProbability, 0);
          const impliedProbability = overround > 1
            ? line.impliedProbability / overround
            : line.impliedProbability;

          const edge = prob.trueProbability - impliedProbability;

          const pinnacle = getPinnacleSignal(
            prob.market,
            prob.selection,
            prob.trueProbability,
            allOdds,
            impliedProbability,
          );

        
          if (pinnacle.flagged) {
            result.betsFlagged++;
            logger.warn('[Engine] Pinnacle flag — skipping', {
              matchId: match.id,
              market: prob.market,
              selection: prob.selection,
              reason: pinnacle.reason,
            });
            if (this.skipOnPinnacleFlag) continue;
          }

          if (pinnacle.sharpMoneySignal < this.minPinnacleSignal) {
            logger.debug('[filter] Rejected: Pinnacle signal too low', {
              signal: pinnacle.sharpMoneySignal,
              market: prob.market,
            });
            continue;
          }

          const baseConfidence = stats.confidenceFactors.dataCompleteness;
          const confidence = Math.max(
            0,
            Math.min(1, baseConfidence * (0.85 + pinnacle.sharpMoneySignal * 0.30)),
          );

          const edgeValidation = this.validator.validateEdge(
            prob.trueProbability,
            impliedProbability,
            confidence,
          );

          if (!edgeValidation.valid) {
            result.betsRejected++;
            logger.debug('[filter] Edge rejected', {
              matchId: match.id,
              market: prob.market,
              selection: prob.selection,
              errors: edgeValidation.errors,
            });
            continue;
          }

          // ✅ FIX #17 — use real numeric modelDelta instead of regex-parsing the reason string
          const divergenceValue = pinnacle.modelDelta !== null
            ? Math.abs(pinnacle.modelDelta)
            : 0.02;

          const decision = BetClassifier.classify({
            edge,
            pinnacleDivergence: divergenceValue,
            modelConfidence: confidence,
            market: prob.market,
          });

          if (decision.action === 'REJECT') {
            result.betsRejected++;
            logger.info('[filter] Decision Layer Rejected Bet', {
              matchId: match.id,
              market: prob.market,
              reason: decision.reason,
            });
            continue;
          }

          const confidenceMultiplier =
            stats.confidenceFactors.dataCompleteness * edgeValidation.confidenceAdjustment;

          const kelly = calculateKelly(edge, line.odds, confidenceMultiplier);
          const optimizedKellyStake = parseFloat((kelly.kellyStake * decision.stakeMultiplier).toFixed(6));
          
          if (optimizedKellyStake <= 0) {
            result.betsRejected++;
            continue;
          }

         const bet: Omit<ValueBet, 'id' | 'createdAt'> & { homeTeam?: string; awayTeam?: string } = {
  matchId: match.id,
  homeTeam: match.homeTeam,
  awayTeam: match.awayTeam,
  market: prob.market,
  selection: prob.selection,
  bookmaker: line.bookmaker,
  bookmakerOdds: line.odds,
  trueProbability: parseFloat(prob.trueProbability.toFixed(6)),
  impliedProbability: parseFloat(impliedProbability.toFixed(6)),
  edge: parseFloat(edge.toFixed(6)),
  kellyStake: optimizedKellyStake, 
  confidence: parseFloat(confidence.toFixed(4)),
  status: 'pending',
};

          const id = this.repo.saveValueBet(bet);
          result.betsFound++;
          result.valueBets.push({ ...bet, id });

          logger.info(`[Engine] 🔥 VALUE FOUND [${decision.tier}]`, {
            matchId: match.id,
            home: match.homeTeam,
            away: match.awayTeam,
            market: prob.market,
            selection: prob.selection,
            bookmaker: line.bookmaker,
            odds: line.odds,
            edge: `${(edge * 100).toFixed(2)}%`,
            confidence: `${(confidence * 100).toFixed(1)}%`,
            adjustedKelly: `${(optimizedKellyStake * 100).toFixed(2)}% of bankroll`,
            multiplierApplied: `${decision.stakeMultiplier}x`,
            notes: decision.reason,
            method: prob.method,
          });
        }
      }
    }

    result.durationMs = Date.now() - start;
    return result;
  }
}