// src/core/engine/valueEngine.ts
import { Repository } from '../database/repository';
import { Match, Stats, Odds, ValueBet } from '../database/schema';
import { Validator } from '../../data-bridge/validator';
import { getProbabilities, ModelInput } from './probabilityModel';
import { getPinnacleSignal, getQuarterLineSignal, PinnacleSignal, QuarterLineSignal } from './pinnacleEdge';
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

// ─── ROLE-BASED SELECTION MATCHING ──────────────────────────────────
//
// The model outputs generic selections ("Home", "Away", "Draw",
// "Home -1.5") but real odds data uses actual team names ("Malmo FF",
// "Malmo FF -1.5"). Exact string matching only ever worked for totals
// (both sides say "Over 2.5") and Draw (both sides happen to say
// "Draw"). Home/Away moneyline and handicap bets were silently
// invisible to the engine. This resolves both sides to a common
// role + optional line before comparing.

export type Role = 'home' | 'away' | 'draw' | 'other';

export function modelSelectionRole(
  selection: string,
  market: string,
): { role: Role; line?: number } {
  if (market === 'moneyline') {
    if (selection === 'Home') return { role: 'home' };
    if (selection === 'Away') return { role: 'away' };
    if (selection === 'Draw') return { role: 'draw' };
  }
  if (market === 'handicap') {
    const m = selection.match(/^(Home|Away)\s*([+-]?[\d.]+)$/);
    if (m) {
      return { role: m[1] === 'Home' ? 'home' : 'away', line: parseFloat(m[2]) };
    }
  }
  return { role: 'other' };
}

export function oddsSelectionRole(
  selection: string,
  market: string,
  match: { homeTeam: string; awayTeam: string },
): { role: Role; line?: number } {
  if (market === 'moneyline') {
    if (selection === match.homeTeam) return { role: 'home' };
    if (selection === match.awayTeam) return { role: 'away' };
    if (selection.toLowerCase() === 'draw') return { role: 'draw' };
  }
  if (market === 'handicap') {
    // e.g. "Malmo FF -1.5" -> team + line
    const m = selection.match(/^(.+?)\s+([+-]?[\d.]+)$/);
    if (m) {
      const team = m[1].trim();
      const line = parseFloat(m[2]);
      if (team === match.homeTeam) return { role: 'home', line };
      if (team === match.awayTeam) return { role: 'away', line };
    }
  }
  return { role: 'other' };
}

// Finds odds rows matching a model prob's selection by role (and line,
// for handicap), rather than exact string equality. Falls back to
// plain string equality for markets that already align naturally
// (totals: "Over 2.5" on both sides; double_chance: "1X"/"X2"/"12" on
// both sides once synthetic rows are injected; btts: "Yes"/"No").
export function findMatchingSoftLines(
  prob: { market: string; selection: string },
  allOdds: Odds[],
  match: { homeTeam: string; awayTeam: string },
): Odds[] {
  if (prob.market === 'moneyline' || prob.market === 'handicap') {
    const modelRole = modelSelectionRole(prob.selection, prob.market);
    if (modelRole.role === 'other') return []; // unparseable, skip safely

    return allOdds.filter(o => {
      if (o.market !== prob.market || o.bookmaker === 'Pinnacle') return false;
      const oddsRole = oddsSelectionRole(o.selection, o.market, match);
      if (oddsRole.role !== modelRole.role) return false;
      if (prob.market === 'handicap') {
        // lines must match exactly (both already home-perspective convention)
        return oddsRole.line !== undefined
          && modelRole.line !== undefined
          && Math.abs(oddsRole.line - modelRole.line) < 1e-9;
      }
      return true;
    });
  }

  // totals, btts, double_chance — exact match already works
  return allOdds.filter(
    o => o.market === prob.market &&
         o.selection === prob.selection &&
         o.bookmaker !== 'Pinnacle',
  );
}

// ─── SYNTHETIC DOUBLE CHANCE ──────────────────────────────────────
//
// The Odds API's double_chance market requires per-event calls and
// has uncertain coverage on lower leagues / free tier — not worth the
// extra API cost right now. Double Chance is mathematically derivable
// from a bookmaker's own 3-way moneyline (1X = P(Home)+P(Draw), etc),
// so we synthesize it locally from h2h odds already being fetched.
// This costs zero extra API credits.
export function injectSyntheticDoubleChance(
  allOdds: Odds[],
  match: { homeTeam: string; awayTeam: string },
): Odds[] {
  const bookmakers = new Set(
    allOdds.filter(o => o.market === 'moneyline' && o.bookmaker !== 'Pinnacle').map(o => o.bookmaker),
  );

  const synthetic: Odds[] = [];

  for (const bookmaker of bookmakers) {
    const homeOdds = allOdds.find(o => o.market === 'moneyline' && o.bookmaker === bookmaker && o.selection === match.homeTeam);
    const awayOdds = allOdds.find(o => o.market === 'moneyline' && o.bookmaker === bookmaker && o.selection === match.awayTeam);
    const drawOdds = allOdds.find(o => o.market === 'moneyline' && o.bookmaker === bookmaker && o.selection.toLowerCase() === 'draw');

    if (!homeOdds || !awayOdds || !drawOdds) continue; // need all three sides

    const pHome = homeOdds.impliedProbability;
    const pDraw = drawOdds.impliedProbability;
    const pAway = awayOdds.impliedProbability;

    const combos: { selection: string; prob: number }[] = [
      { selection: '1X', prob: pHome + pDraw },
      { selection: 'X2', prob: pDraw + pAway },
      { selection: '12', prob: pHome + pAway },
    ];

    for (const combo of combos) {
      if (combo.prob <= 0 || combo.prob >= 1) continue;
      synthetic.push({
        id: `synthetic-dc-${bookmaker}-${combo.selection}`,
        matchId: homeOdds.matchId,
        bookmaker,
        market: 'double_chance',
        selection: combo.selection,
        odds: parseFloat((1 / combo.prob).toFixed(4)),
        impliedProbability: combo.prob,
        timestamp: homeOdds.timestamp,
        source: 'synthetic',
      } as Odds);
    }
  }

  return [...allOdds, ...synthetic];
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

      let allOdds = this.repo.getLatestOdds(match.id);
      if (!allOdds.length) {
        logger.debug('[Engine] No odds — skipping', { matchId: match.id });
        continue;
      }

      // Add synthetic double_chance rows derived from h2h, before any
      // market matching happens.
      allOdds = injectSyntheticDoubleChance(allOdds, match);

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
        // User does not want Draw as a bettable moneyline outcome, ever.
        // Draw probability is still computed internally (needed for
        // double_chance derivation and the 1X2 model itself) — it's
        // just never evaluated as its own standalone bet.
        if (prob.market === 'moneyline' && prob.selection === 'Draw') continue;

        const softLines = findMatchingSoftLines(prob, allOdds, match);

        for (const line of softLines) {
          result.betsEvaluated++;

          // BUG FIX: the overround-normalization below assumes a market's
          // selections are mutually exclusive and sum to ~100% (true for
          // moneyline: Home+Draw+Away, and totals: Over+Under). Double
          // Chance selections OVERLAP by design (1X and X2 both include
          // Draw; 1X and 12 both include Home) — summing all three
          // naturally comes out to ~200%, not ~100%. Treating that as an
          // "overround" and dividing by it silently HALVED every Double
          // Chance implied probability, producing fake 30-50% edges.
          // The synthetic derivation already bakes in the bookmaker's
          // margin correctly (from the raw h2h implied probabilities it
          // was built from) — no further normalization needed here.
          let impliedProbability: number;
          if (prob.market === 'double_chance') {
            impliedProbability = line.impliedProbability;
          } else {
            const bookmakerLines = allOdds.filter(
              o => o.bookmaker === line.bookmaker && o.market === line.market
            );
            const overround = bookmakerLines.reduce((s, o) => s + o.impliedProbability, 0);
            impliedProbability = overround > 1
              ? line.impliedProbability / overround
              : line.impliedProbability;
          }

          const edge = prob.trueProbability - impliedProbability;

          // ── PINNACLE VALIDATION ────────────────────────────────
          let pinnacle: PinnacleSignal | QuarterLineSignal = getPinnacleSignal(
            prob.market,
            prob.selection,
            prob.trueProbability,
            allOdds,
            impliedProbability,
          );

          let quarterLineTier: string | null = null;
          let quarterLineSource: string | null = null;

          if (!pinnacle.hasPinnacle && prob.market === 'totals') {
            const quarterSignal = getQuarterLineSignal(
              prob.selection,
              prob.trueProbability,
              allOdds,
              prob.market,
            );

            if (quarterSignal.tier === 'high' || quarterSignal.tier === 'medium') {
              pinnacle = quarterSignal;
              quarterLineTier = quarterSignal.tier;
              quarterLineSource = quarterSignal.inferredFrom;

              logger.info('[Engine] Quarter-line inference applied', {
                matchId: match.id,
                selection: prob.selection,
                inferredFrom: quarterSignal.inferredFrom,
                tier: quarterSignal.tier,
                modelProbability: `${(prob.trueProbability * 100).toFixed(1)}%`,
                pinnacleImplied: quarterSignal.pinnacleImplied
                  ? `${(quarterSignal.pinnacleImplied * 100).toFixed(1)}%`
                  : null,
              });
            }
          }

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
              quarterLineTier,
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
            quarterLineInference: quarterLineTier
              ? { tier: quarterLineTier, source: quarterLineSource }
              : undefined,
          });
        }
      }
    }

    result.durationMs = Date.now() - start;
    return result;
  }
}