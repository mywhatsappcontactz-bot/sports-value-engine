// src/core/engine/tipScanner.ts

import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { Validator } from '../../data-bridge/validator';
import { getProbabilities, ModelInput, MarketProbability } from './probabilityModel';
import { getPinnacleSignal } from './pinnacleEdge';
import {
  findMatchingSoftLines,
  injectSyntheticDoubleChance,
} from './valueEngine';
import { Repository } from '../database/repository';

const db = getDb();
const validator = new Validator();
const repository = new Repository(db);

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
// Corners now uses this same global floor (see modelFootballCorners in
// probabilityModel.ts) — an earlier 60-70% "sweet spot" version needed its
// own lower threshold, but simulation against real EPL data showed that
// band barely filtered anything (91% tip rate), so corners was moved to
// the same single 0.80 bar as every other market instead.

const ALLOWED_TIP_MARKETS: Record<string, string[]> = {
  football:   ['totals', 'corners_totals'],
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
    SELECT h2h, homeForm, awayForm, referee, situational, additionalContext, confidenceFactors,
           homeGoalsAvg, awayGoalsAvg, homeCornersAvg, awayCornersAvg
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
    homeGoalsAvg:      row.homeGoalsAvg ?? undefined,
    awayGoalsAvg:      row.awayGoalsAvg ?? undefined,
    homeCornersAvg:    row.homeCornersAvg ?? undefined,
    awayCornersAvg:    row.awayCornersAvg ?? undefined,
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
  if (!statsRow) return;

  const stats = parseStats(statsRow);

  const completeness = stats.confidenceFactors?.dataCompleteness ?? 0;
  if (completeness < 0.5) return;

  let allOdds = db.prepare(`
    SELECT id, matchId, bookmaker, market, selection, odds, impliedProbability, timestamp, source
    FROM odds
    WHERE matchId = ?
  `).all(match.id) as any[];

  if (!allOdds.length) return;

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
    if (!isAllowedTipMarket(match.sport, prob.market)) continue;

    if (prob.market === 'moneyline' && prob.selection === 'Draw') continue;

    if (prob.trueProbability < MIN_TIP_CONFIDENCE) continue;

    const softLines = findMatchingSoftLines(prob, allOdds, match);
    const best = softLines.length
      ? softLines.reduce((a, b) => (a.odds > b.odds ? a : b))
      : null;
    const localOdds = best ? { bookmaker: best.bookmaker, odds: best.odds } : null;

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

    // Corners tips get queued for grading here, at creation time — see
    // corners_grading_queue in schema.ts and cornersGradingJob.ts for the
    // separate daily job that actually resolves these against API-Football.
    if (prob.market === 'corners_totals') {
      repository.enqueueCornersGrading({
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        startTime: match.startTime,
        targetSelection: prob.selection,
        predictedProbability: prob.trueProbability,
      });
    }

    // Goals totals tips (football only) get queued for grading the same
    // way — see goals_grading_queue in schema.ts and goalsGradingJob.ts.
    // Only football 'totals' tips qualify; basketball also uses market
    // 'totals' but is points, not goals, so it's excluded here.
    if (match.sport === 'football' && prob.market === 'totals') {
      repository.enqueueGoalsGrading({
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        startTime: match.startTime,
        targetSelection: prob.selection,
        predictedProbability: prob.trueProbability,
      });
    }
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

  const bestPerMatchMarket = new Map<string, Tip>();
  for (const tip of tips) {
    const key = `${tip.matchId}:${tip.targetMarket}`;
    const existing = bestPerMatchMarket.get(key);
    if (!existing || tip.confidence > existing.confidence) {
      bestPerMatchMarket.set(key, tip);
    }
  }

  const deduped = Array.from(bestPerMatchMarket.values());
  deduped.sort((a, b) => a.hoursToKickoff - b.hoursToKickoff);

  logger.info(`[TipScanner] Found ${deduped.length} qualifying tips`);
  return deduped;
}

// ─── ACCUMULATOR SUGGESTER ─────────────────────────────────────────────────

export interface SuggestedAccumulator {
  legs: Tip[];
  combinedOdds: number;
  combinedProbability: number;
  usesLivePricesOnly: boolean;
}

function tipOdds(tip: Tip): number {
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

  results.sort((a, b) => {
    if (a.usesLivePricesOnly !== b.usesLivePricesOnly) {
      return a.usesLivePricesOnly ? -1 : 1;
    }
    return b.combinedProbability - a.combinedProbability;
  });

  return results.slice(0, maxSuggestions);
}