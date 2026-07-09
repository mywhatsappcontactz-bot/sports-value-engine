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
  localBookmaker: string;
  localOdds: number;
  pinnacleAvailable: boolean;
  pinnacleAgrees: boolean | null;
  signal: string;
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const MIN_TIP_CONFIDENCE = 0.70; // model probability floor to qualify as a tip

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
    // Consistent with valueEngine.ts: Draw is never a bettable tip.
    if (prob.market === 'moneyline' && prob.selection === 'Draw') continue;

    if (prob.trueProbability < MIN_TIP_CONFIDENCE) continue;

    const softLines = findMatchingSoftLines(prob, allOdds, match);
    if (!softLines.length) continue;

    // Pick the best available local price among matching soft lines
    const best = softLines.reduce((a, b) => (a.odds > b.odds ? a : b));
    const localOdds = { bookmaker: best.bookmaker, odds: best.odds };

    // Pinnacle is optional context, never a requirement to qualify.
    const pinnacle = getPinnacleSignal(
      prob.market,
      prob.selection,
      prob.trueProbability,
      allOdds,
      1 / localOdds.odds,
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
      localBookmaker:    localOdds.bookmaker,
      localOdds:         localOdds.odds,
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
  deduped.sort((a, b) => b.confidence - a.confidence);

  logger.info(`[TipScanner] Found ${deduped.length} qualifying tips`);
  return deduped;
}