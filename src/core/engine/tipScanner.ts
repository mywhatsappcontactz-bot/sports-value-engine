// src/core/engine/tipScanner.ts
//
// REDESIGNED: tips are now pure stats-driven predictions, not a
// Pinnacle-line-movement signal. The old version devigged Pinnacle's
// own price and called that "trueProbability" — circular, since it
// was just trusting Pinnacle to validate Pinnacle. This version pulls
// trueProbability straight from probabilityModel.ts (the same
// Poisson/Elo model valueEngine.ts uses), gated by the same data
// completeness validator, across ALL sports (football, basketball,
// tennis, hockey) — not just football/basketball totals + tennis
// moneyline like before.
//
// Distinction from valueEngine.ts: tips do NOT require an edge against
// a bookmaker price. A tip is "what does my model believe will happen,
// with high confidence" — meant for building accumulators — regardless
// of whether the bookmaker's price also happens to be mispriced.
// Pinnacle is optional context (shown if available) rather than a
// requirement, so a match with no Pinnacle coverage can still tip.
// Draw is excluded as a bettable outcome, consistent with the value
// engine.

import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { Validator } from '../../data-bridge/validator';
import { getProbabilities, ModelInput, MarketProbability } from './probabilityModel';
import { getPinnacleSignal } from './pinnacleEdge';
import {
  findMatchingSoftLines,
  injectSyntheticDoubleChance,
} from './valueEngine';

const db = getDb();
const validator = new Validator();

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface Tip {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: string;
  startTime: string;
  hoursToKickoff: number;
  targetMarket: string;
  targetSelection: string;
  trueProbability: number;
  confidence: number;
  impliedFairOdds: number;
  localBookmaker: string | null;
  localOdds: number | null;
  pinnacleAvailable: boolean;
  pinnacleAgrees: boolean | null;
  signal: string;
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const MIN_TIP_CONFIDENCE = 0.80; // model probability floor to qualify as a tip

// Per-sport allowed markets for tips — matches exactly what's fetched
// in oddsClient.ts's SPORT_MARKETS, so tips never try to surface a
// market that has no odds coverage for that sport (e.g. tennis has no
// totals model at all, so it must stay moneyline-only or tips would
// permanently be zero for tennis).
const ALLOWED_TIP_MARKETS: Record<string, string[]> = {
  football:   ['totals'],
  basketball: ['moneyline', 'totals'],
  tennis:     ['moneyline'],
  hockey:     ['moneyline'],
};

function isAllowedTipMarket(sport: string, market: string): boolean {
  return ALLOWED_TIP_MARKETS[sport]?.includes(market) ?? false;
}

// ─── STATS HELPERS ─────────────────────────────────────────────────────────

function buildStatsRow(matchId: string, sport: string): any {
  return db.prepare(`
    SELECT h2h, homeForm, awayForm, referee, situational, additionalContext, confidenceFactors
    FROM stats
    WHERE matchId = ? AND sport = ?
  `).get(matchId, sport);
}

function parseStats(row: any): any {
  return {
    h2h:               JSON.parse(row.h2h || '[]'),
    homeForm:          JSON.parse(row.homeForm || '[]'),
    awayForm:          JSON.parse(row.awayForm || '[]'),
    referee:           JSON.parse(row.referee || '{}'),
    situational:       JSON.parse(row.situational || '{}'),
    additionalContext: JSON.parse(row.additionalContext || '{}'),
    confidenceFactors: JSON.parse(row.confidenceFactors || '{"dataCompleteness":0.35}'),
  };
}

// ─── LOCAL ODDS LOOKUP ─────────────────────────────────────────────────────

function findLocalOdds(matchId: string, market: string, selection: string): { bookmaker: string; odds: number } | null {
  const row = db.prepare(`
    SELECT bookmaker, odds
    FROM odds
    WHERE matchId = ?
    AND market = ?
    AND selection = ?
    AND bookmaker != 'Pinnacle'
    AND odds >= 1.20
    ORDER BY odds DESC
    LIMIT 1
  `).get(matchId, market, selection) as any;
  return row ? { bookmaker: row.bookmaker, odds: row.odds } : null;
}

// ─── SIGNAL TEXT ────────────────────────────────────────────────────────────

function buildSignal(
  prob: MarketProbability,
  pinnacleAvailable: boolean,
  pinnacleAgrees: boolean | null,
): string {
  const base = `Model gives ${prob.selection} a ${(prob.trueProbability * 100).toFixed(1)}% chance (${prob.method})`;
  if (!pinnacleAvailable) return `${base} — no Pinnacle line to cross-check`;
  if (pinnacleAgrees) return `${base} — confirmed by Pinnacle`;
  return `${base} — Pinnacle diverges, model-only confidence`;
}

// ─── PER-MATCH SCAN ─────────────────────────────────────────────────────────

function scanMatch(match: any, hoursToKickoff: number, tips: Tip[]): void {
  const statsRow = buildStatsRow(match.id, match.sport);
  if (!statsRow) return; // no stats at all — nothing to predict from

  const stats = parseStats(statsRow);

  // Same data-quality bar used by the value engine — a prediction is
  // only as good as the stats behind it.
  const completeness = stats.confidenceFactors?.dataCompleteness ?? 0;
  if (completeness < 0.5) return; // require a real, decent stats picture for a TIP specifically (stricter than value engine's edge-based gate, since tips have no bookmaker-price cross-check to lean on)

  let allOdds = db.prepare(`
    SELECT id, matchId, bookmaker, market, selection, odds, impliedProbability, timestamp, source
    FROM odds
    WHERE matchId = ?
  `).all(match.id) as any[];

  if (!allOdds.length) return; // nothing to bet on locally, skip

  if (match.sport === 'football') {
    allOdds = injectSyntheticDoubleChance(allOdds, match);
  }

  let marketProbs: MarketProbability[];
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
    logger.debug('[TipScanner] Probability model failed', { matchId: match.id, error: err.message });
    return;
  }

  for (const prob of marketProbs) {
    // Per-sport market restriction (see ALLOWED_TIP_MARKETS above):
    // football = totals only, basketball = moneyline+totals,
    // tennis/hockey = moneyline only.
    if (!isAllowedTipMarket(match.sport, prob.market)) continue;

    // Draw is never a bettable tip, consistent with valueEngine.ts.
    if (prob.market === 'moneyline' && prob.selection === 'Draw') continue;

    if (prob.trueProbability < MIN_TIP_CONFIDENCE) continue;

    // Odds are shown when available but no longer required to qualify
    // as a tip — this is a pure stats prediction, not a "can you bet
    // this right now" check. William Hill (via the free-tier Odds API)
    // often only posts one main line per match, which was silently
    // dropping legitimate high-confidence predictions like Under 3.5
    // just because there was nothing to match against.
    const softLines = findMatchingSoftLines(prob, allOdds, match);
    const best = softLines.length
      ? softLines.reduce((a, b) => (a.odds > b.odds ? a : b))
      : null;
    const localOdds = best ? { bookmaker: best.bookmaker, odds: best.odds } : null;

    // Pinnacle is optional context, never a requirement to qualify.
    // Use the model's own probability as the soft-comparison baseline
    // when no local odds exist, since getPinnacleSignal needs some
    // reference point — we only read hasPinnacle/flagged from the
    // result here, not the full signal strength, so this is safe.
    const softBaseline = localOdds ? 1 / localOdds.odds : prob.trueProbability;
    const pinnacle = getPinnacleSignal(
      prob.market,
      prob.selection,
      prob.trueProbability,
      allOdds,
      softBaseline,
    );
    const pinnacleAvailable = pinnacle.hasPinnacle;
    const pinnacleAgrees = pinnacle.hasPinnacle ? !pinnacle.flagged : null;

    tips.push({
      matchId:           match.id,
      homeTeam:          match.homeTeam,
      awayTeam:          match.awayTeam,
      league:            match.league,
      sport:             match.sport,
      startTime:         match.startTime,
      hoursToKickoff:    parseFloat(hoursToKickoff.toFixed(1)),
      targetMarket:      prob.market,
      targetSelection:   prob.selection,
      trueProbability:   parseFloat(prob.trueProbability.toFixed(4)),
      confidence:        parseFloat((prob.trueProbability * 100).toFixed(1)),
      impliedFairOdds:   parseFloat((1 / prob.trueProbability).toFixed(2)),
      localBookmaker:    localOdds ? localOdds.bookmaker : null,
      localOdds:         localOdds ? localOdds.odds : null,
      pinnacleAvailable,
      pinnacleAgrees,
      signal:            buildSignal(prob, pinnacleAvailable, pinnacleAgrees),
    });
  }
}

// ─── MAIN SCANNER ─────────────────────────────────────────────────────────────

export function runTipScanner(hoursWindow: number = 6): Tip[] {
  const tips: Tip[] = [];
  const now           = new Date();
  const kickoffCutoff = new Date(now.getTime() + hoursWindow * 60 * 60 * 1000).toISOString();

  const matches = db.prepare(`
    SELECT id, homeTeam, awayTeam, league, sport, startTime
    FROM matches
    WHERE status = 'upcoming'
    AND startTime <= ?
    AND startTime > ?
    ORDER BY startTime ASC
  `).all(kickoffCutoff, now.toISOString()) as any[];

  if (!matches.length) {
    logger.info('[TipScanner] No matches within time window');
    return [];
  }

  logger.info(`[TipScanner] Scanning ${matches.length} matches within ${hoursWindow}h window (all sports)`);

  for (const match of matches) {
    const hoursToKickoff = (new Date(match.startTime).getTime() - now.getTime()) / (1000 * 60 * 60);
    scanMatch(match, hoursToKickoff, tips);
  }

  // One tip per match+market at most, keep the highest-confidence
  // selection if multiple qualify (e.g. avoid tipping both Over 1.5
  // AND Over 2.5 on the same match — redundant for accumulator building).
  const bestPerMatchMarket = new Map<string, Tip>();
  for (const tip of tips) {
    const key = `${tip.matchId}:${tip.targetMarket}`;
    const existing = bestPerMatchMarket.get(key);
    if (!existing || tip.confidence > existing.confidence) {
      bestPerMatchMarket.set(key, tip);
    }
  }

  const deduped = Array.from(bestPerMatchMarket.values());
  // Sorted by kickoff time (soonest first) rather than confidence —
  // matches how the person actually wants to act on these, in the
  // order games are played, not ranked by an abstract score.
  deduped.sort((a, b) => a.hoursToKickoff - b.hoursToKickoff);

  logger.info(`[TipScanner] Found ${deduped.length} qualifying tips`);
  return deduped;
}

// ─── ACCUMULATOR SUGGESTER ─────────────────────────────────────────────────
//
// With 20+ qualifying tips per scan, manually finding a combo that lands
// in the 1.80-2.00 target range is tedious. This automatically searches
// 2-4 leg combinations and surfaces the best few — ranked by combined
// confidence — so the person gets ready-made suggestions instead of a
// wall of raw picks to sift through themselves.

export interface SuggestedAccumulator {
  legs: Tip[];
  combinedOdds: number;
  combinedProbability: number;
  usesLivePricesOnly: boolean;
}

function tipOdds(tip: Tip): number {
  // Prefer a real bookmaker price when available; fall back to the
  // model's implied fair odds otherwise (clearly flagged via
  // usesLivePricesOnly so the caller knows which combos are fully
  // verified vs partly theoretical).
  return tip.localOdds ?? tip.impliedFairOdds;
}

export function suggestAccumulators(
  tips: Tip[],
  targetMin: number = 1.80,
  targetMax: number = 2.00,
  maxLegs: number = 3,
  maxSuggestions: number = 5,
): SuggestedAccumulator[] {
  const results: SuggestedAccumulator[] = [];

  // Avoid correlated legs — never combine two picks from the same match.
  function combos(pool: Tip[], size: number): Tip[][] {
    if (size === 0) return [[]];
    if (pool.length < size) return [];
    const [first, ...rest] = pool;
    const withFirst = combos(
      rest.filter(t => t.matchId !== first.matchId),
      size - 1,
    ).map(c => [first, ...c]);
    const withoutFirst = combos(rest, size);
    return [...withFirst, ...withoutFirst];
  }

  for (let legs = 2; legs <= maxLegs; legs++) {
    for (const combo of combos(tips, legs)) {
      const combinedOdds = combo.reduce((acc, t) => acc * tipOdds(t), 1);
      if (combinedOdds < targetMin || combinedOdds > targetMax) continue;

      const combinedProbability = combo.reduce((acc, t) => acc * t.trueProbability, 1);
      const usesLivePricesOnly = combo.every(t => t.localOdds !== null);

      results.push({
        legs: combo,
        combinedOdds: parseFloat(combinedOdds.toFixed(3)),
        combinedProbability: parseFloat(combinedProbability.toFixed(4)),
        usesLivePricesOnly,
      });
    }
  }

  // Rank: real-price combos first, then by highest combined confidence
  results.sort((a, b) => {
    if (a.usesLivePricesOnly !== b.usesLivePricesOnly) {
      return a.usesLivePricesOnly ? -1 : 1;
    }
    return b.combinedProbability - a.combinedProbability;
  });

  return results.slice(0, maxSuggestions);
}