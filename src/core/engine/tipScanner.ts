// src/core/engine/tipScanner.ts
import { getDb } from '../database/db';
import { logger } from '../utils/logger';

const db = getDb();

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface Tip {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: string;
  startTime: string;
  hoursToKickoff: number;
  pinnacleLineValue: number;
  pinnacleLineDirection: 'Over' | 'Under';
  previousOdds: number;
  currentOdds: number;
  oddsDropPct: number;
  trueProbability: number;
  targetMarket: string;
  targetSelection: string;
  localBookmaker: string;
  localOdds: number;
  confidence: number;
  signal: string;
}

// ─── BRIDGE LOGIC ────────────────────────────────────────────────────────────

function getBridgeTarget(
  pinnacleLineValue: number,
  direction: 'Over' | 'Under'
): { targetSelection: string; signal: string } | null {

  if (direction === 'Over') {
    if (pinnacleLineValue === 2.5) {
      return { targetSelection: 'Over 2.5', signal: 'Pinnacle Over 2.5 dropping — direct confidence play' };
    }
    if (pinnacleLineValue === 2.75 || pinnacleLineValue === 3.0) {
      return { targetSelection: 'Over 1.5', signal: `Pinnacle Over ${pinnacleLineValue} dropping — expects 3+ goals, Over 1.5 near certain` };
    }
    if (pinnacleLineValue === 3.25 || pinnacleLineValue === 3.5) {
      return { targetSelection: 'Over 2.5', signal: `Pinnacle Over ${pinnacleLineValue} dropping — goal fest expected, Over 2.5 highly probable` };
    }
  }

  if (direction === 'Under') {
    if (pinnacleLineValue === 2.5) {
      return { targetSelection: 'Under 2.5', signal: 'Pinnacle Under 2.5 dropping — direct confidence play' };
    }
    if (pinnacleLineValue === 2.75 || pinnacleLineValue === 3.0) {
      return { targetSelection: 'Under 3.5', signal: `Pinnacle Under ${pinnacleLineValue} dropping — low scoring expected, Under 3.5 protected` };
    }
    if (pinnacleLineValue === 3.25 || pinnacleLineValue === 3.5) {
      return { targetSelection: 'Under 3.5', signal: `Pinnacle Under ${pinnacleLineValue} dropping — sharp money on under, Under 3.5 safe` };
    }
  }

  return null;
}

// ─── LINE VALUE PARSER ───────────────────────────────────────────────────────

function parseSelection(selection: string): { direction: 'Over' | 'Under'; lineValue: number } | null {
  const match = selection.match(/^(Over|Under)\s+([\d.]+)$/i);
  if (!match) return null;
  return {
    direction: match[1] as 'Over' | 'Under',
    lineValue: parseFloat(match[2]),
  };
}

// ─── DEVIG PINNACLE ──────────────────────────────────────────────────────────

function calculateTrueProbability(
  overOdds: number,
  underOdds: number,
  direction: 'Over' | 'Under'
): number {
  const overImplied = 1 / overOdds;
  const underImplied = 1 / underOdds;
  const total = overImplied + underImplied;
  const overTrue = overImplied / total;
  const underTrue = underImplied / total;
  return direction === 'Over' ? overTrue : underTrue;
}

// ─── MAIN SCANNER ────────────────────────────────────────────────────────────

export function runTipScanner(hoursWindow: number = 6): Tip[] {
  const tips: Tip[] = [];
  const now = new Date();
  const kickoffCutoff = new Date(now.getTime() + hoursWindow * 60 * 60 * 1000).toISOString();

  // Get upcoming matches within time window
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

  logger.info(`[TipScanner] Scanning ${matches.length} matches within ${hoursWindow}h window`);

  for (const match of matches) {
    const hoursToKickoff = (new Date(match.startTime).getTime() - now.getTime()) / (1000 * 60 * 60);

    // Get current Pinnacle odds for this match
    const currentPinnacleOdds = db.prepare(`
      SELECT selection, odds, impliedProbability
      FROM odds
      WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'totals'
    `).all(match.id) as any[];

    if (!currentPinnacleOdds.length) continue;

    // Get previous Pinnacle odds snapshot
    const previousSnapshot = db.prepare(`
      SELECT selection, odds, timestamp
      FROM odds_history
      WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'totals'
      ORDER BY timestamp ASC
      LIMIT 50
    `).all(match.id) as any[];

    if (!previousSnapshot.length) continue;

    // Group current odds by selection
    const currentBySelection = new Map<string, number>();
    for (const o of currentPinnacleOdds) {
      currentBySelection.set(o.selection, o.odds);
    }

    // Group previous odds by selection (earliest snapshot)
    const previousBySelection = new Map<string, number>();
    for (const o of previousSnapshot) {
      if (!previousBySelection.has(o.selection)) {
        previousBySelection.set(o.selection, o.odds);
      }
    }

    // Detect line movement
    for (const [selection, currentOdds] of currentBySelection) {
      const parsed = parseSelection(selection);
      if (!parsed) continue;

      const previousOdds = previousBySelection.get(selection);
      if (!previousOdds) continue;

      // Odds dropped = implied probability increased = sharp money came in
      const oddsDropPct = ((previousOdds - currentOdds) / previousOdds) * 100;
      if (oddsDropPct < 2) continue; // minimum 2% drop to signal movement

      const { direction, lineValue } = parsed;

      // Get opposite side for devig
      const oppositeSelection = direction === 'Over'
        ? `Under ${lineValue}`
        : `Over ${lineValue}`;
      const oppositeOdds = currentBySelection.get(oppositeSelection);
      if (!oppositeOdds) continue;

      // Calculate true probability
      const overOdds = direction === 'Over' ? currentOdds : oppositeOdds;
      const underOdds = direction === 'Under' ? currentOdds : oppositeOdds;
      const trueProbability = calculateTrueProbability(overOdds, underOdds, direction);

      // Apply bridge logic
      const bridge = getBridgeTarget(lineValue, direction);
      if (!bridge) continue;

      // Find local bookmaker odds for target selection
      const localOdds = db.prepare(`
        SELECT bookmaker, odds
        FROM odds
        WHERE matchId = ?
        AND market = 'totals'
        AND selection = ?
        AND bookmaker != 'Pinnacle'
        AND odds >= 1.20
        ORDER BY odds DESC
        LIMIT 1
      `).get(match.id, bridge.targetSelection) as any;

      if (!localOdds) continue;

      // Minimum confidence threshold
      if (trueProbability < 0.72) continue;

      // Push protection — skip flat integer lines
      if (Number.isInteger(lineValue) && oddsDropPct < 5) continue;

      tips.push({
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        sport: match.sport,
        startTime: match.startTime,
        hoursToKickoff: parseFloat(hoursToKickoff.toFixed(1)),
        pinnacleLineValue: lineValue,
        pinnacleLineDirection: direction,
        previousOdds,
        currentOdds,
        oddsDropPct: parseFloat(oddsDropPct.toFixed(2)),
        trueProbability: parseFloat(trueProbability.toFixed(4)),
        targetMarket: 'totals',
        targetSelection: bridge.targetSelection,
        localBookmaker: localOdds.bookmaker,
        localOdds: localOdds.odds,
        confidence: parseFloat((trueProbability * 100).toFixed(1)),
        signal: bridge.signal,
      });
    }
  }

  // Sort by confidence descending
  tips.sort((a, b) => b.confidence - a.confidence);
  logger.info(`[TipScanner] Found ${tips.length} qualifying tips`);
  return tips;
}