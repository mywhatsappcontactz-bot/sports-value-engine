// src/core/engine/tipScanner.ts
import { getDb } from '../database/db';
import { logger } from '../utils/logger';

const db = getDb();

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface Tip {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: string;
  startTime: string;
  hoursToKickoff: number;
  pinnacleLineValue: number;
  pinnacleLineDirection: 'Over' | 'Under' | 'Home' | 'Away';
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

// ─── BRIDGE LOGIC (FOOTBALL TOTALS) ──────────────────────────────────────────

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

// ─── BRIDGE LOGIC (BASKETBALL TOTALS) ────────────────────────────────────────

function getBasketballBridgeTarget(
  lineValue: number,
  direction: 'Over' | 'Under'
): { targetSelection: string; signal: string } | null {

  // WNBA lines typically 155-175
  if (direction === 'Over') {
    if (lineValue >= 140 && lineValue <= 180) {
      return {
        targetSelection: `Over ${lineValue}`,
        signal: `Pinnacle Over ${lineValue} dropping — sharp money expects high-scoring game`,
      };
    }
  }

  if (direction === 'Under') {
    if (lineValue >= 140 && lineValue <= 180) {
      return {
        targetSelection: `Under ${lineValue}`,
        signal: `Pinnacle Under ${lineValue} dropping — sharp money expects low-scoring game`,
      };
    }
  }

  return null;
}

// ─── LINE VALUE PARSER ────────────────────────────────────────────────────────

function parseSelection(selection: string): { direction: 'Over' | 'Under'; lineValue: number } | null {
  const match = selection.match(/^(Over|Under)\s+([\d.]+)$/i);
  if (!match) return null;
  return {
    direction: match[1] as 'Over' | 'Under',
    lineValue: parseFloat(match[2]),
  };
}

// ─── DEVIG PINNACLE (TOTALS) ──────────────────────────────────────────────────

function calculateTrueProbability(
  overOdds: number,
  underOdds: number,
  direction: 'Over' | 'Under'
): number {
  const overImplied  = 1 / overOdds;
  const underImplied = 1 / underOdds;
  const total        = overImplied + underImplied;
  const overTrue     = overImplied / total;
  const underTrue    = underImplied / total;
  return direction === 'Over' ? overTrue : underTrue;
}

// ─── DEVIG PINNACLE (MONEYLINE) ───────────────────────────────────────────────

function calculateMoneylineTrueProbability(
  homeOdds: number,
  awayOdds: number,
  drawOdds: number | null,
  side: 'home' | 'away'
): number {
  const homeImplied = 1 / homeOdds;
  const awayImplied = 1 / awayOdds;
  const drawImplied = drawOdds ? 1 / drawOdds : 0;
  const total       = homeImplied + awayImplied + drawImplied;
  const homeTrue    = homeImplied / total;
  const awayTrue    = awayImplied / total;
  return side === 'home' ? homeTrue : awayTrue;
}

// ─── TENNIS MONEYLINE SCANNER ─────────────────────────────────────────────────

function scanTennisMoneyline(
  match: any,
  hoursToKickoff: number,
  tips: Tip[]
): void {
  const currentPinnacleOdds = db.prepare(`
    SELECT selection, odds
    FROM odds
    WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'moneyline'
  `).all(match.id) as any[];

  if (!currentPinnacleOdds.length) return;

  const previousSnapshot = db.prepare(`
    SELECT selection, odds, timestamp
    FROM odds_history
    WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'moneyline'
    ORDER BY timestamp ASC
    LIMIT 20
  `).all(match.id) as any[];

  if (!previousSnapshot.length) return;

  const currentBySelection = new Map<string, number>();
  for (const o of currentPinnacleOdds) currentBySelection.set(o.selection, o.odds);

  const previousBySelection = new Map<string, number>();
  for (const o of previousSnapshot) {
    if (!previousBySelection.has(o.selection)) previousBySelection.set(o.selection, o.odds);
  }

  const homeSelection = match.homeTeam;
  const awaySelection = match.awayTeam;

  const currentHome  = currentBySelection.get(homeSelection);
  const currentAway  = currentBySelection.get(awaySelection);
  const previousHome = previousBySelection.get(homeSelection);
  const previousAway = previousBySelection.get(awaySelection);

  if (!currentHome || !currentAway || !previousHome || !previousAway) return;

  const sides = [
    { selection: homeSelection, current: currentHome, previous: previousHome, side: 'home' as const },
    { selection: awaySelection, current: currentAway, previous: previousAway, side: 'away' as const },
  ];

  for (const { selection, current, previous, side } of sides) {
    const oddsDropPct = ((previous - current) / previous) * 100;
    if (oddsDropPct < 2) continue;
    function scanTennisMoneyline(
  match: any,
  hoursToKickoff: number,
  tips: Tip[]
): void {
  // ── STAT GATE — suppress if no stats or H2H win rate < 60% ──────────────
  const statsRow = db.prepare(`
    SELECT h2h, additionalContext FROM stats
    WHERE matchId = ? AND sport = 'tennis'
  `).get(match.id) as any;

  if (!statsRow) return; // no stats — suppress entirely

  const h2hRecords: { homeTeam: string; awayTeam: string; homeScore: number; awayScore: number }[] =
    JSON.parse(statsRow.h2h || '[]');

  const additionalContext = JSON.parse(statsRow.additionalContext || '{}');

  const currentPinnacleOdds = db.prepare(`
    SELECT selection, odds
    FROM odds
    WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'moneyline'
  `).all(match.id) as any[];

  if (!currentPinnacleOdds.length) return;

  const previousSnapshot = db.prepare(`
    SELECT selection, odds, timestamp
    FROM odds_history
    WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'moneyline'
    ORDER BY timestamp ASC
    LIMIT 20
  `).all(match.id) as any[];

  if (!previousSnapshot.length) return;

  const currentBySelection = new Map<string, number>();
  for (const o of currentPinnacleOdds) currentBySelection.set(o.selection, o.odds);

  const previousBySelection = new Map<string, number>();
  for (const o of previousSnapshot) {
    if (!previousBySelection.has(o.selection)) previousBySelection.set(o.selection, o.odds);
  }

  const homeSelection = match.homeTeam;
  const awaySelection = match.awayTeam;

  const currentHome  = currentBySelection.get(homeSelection);
  const currentAway  = currentBySelection.get(awaySelection);
  const previousHome = previousBySelection.get(homeSelection);
  const previousAway = previousBySelection.get(awaySelection);

  if (!currentHome || !currentAway || !previousHome || !previousAway) return;

  const sides = [
    { selection: homeSelection, current: currentHome, previous: previousHome, side: 'home' as const },
    { selection: awaySelection, current: currentAway, previous: previousAway, side: 'away' as const },
  ];

  for (const { selection, current, previous, side } of sides) {
    const oddsDropPct = ((previous - current) / previous) * 100;
    if (oddsDropPct < 2) continue;

    // ── H2H WIN RATE GATE ─────────────────────────────────────────────────
    if (h2hRecords.length > 0) {
      const tippedIsHome = side === 'home';
      const wins = h2hRecords.filter(g =>
        tippedIsHome ? g.homeScore > g.awayScore : g.awayScore > g.homeScore
      ).length;
      const winRate = wins / h2hRecords.length;
      if (winRate < 0.60) continue; // suppress if win rate below 60%
    } else {
      // No H2H records at all — use career win pct as fallback
      const careerWinPct = side === 'home'
        ? additionalContext.homeCareerWinPct
        : additionalContext.awayCareerWinPct;
      if (!careerWinPct || careerWinPct < 0.60) continue;
    }

    const trueProbability = calculateMoneylineTrueProbability(currentHome, currentAway, null, side);
    if (trueProbability < 0.62) continue;

    const localOdds = db.prepare(`
      SELECT bookmaker, odds
      FROM odds
      WHERE matchId = ?
      AND market = 'moneyline'
      AND selection = ?
      AND bookmaker != 'Pinnacle'
      AND odds >= 1.20
      ORDER BY odds DESC
      LIMIT 1
    `).get(match.id, selection) as any;

    if (!localOdds) continue;
    if (localOdds.odds < current) continue;

    const signal = `Pinnacle ${selection} dropping ${oddsDropPct.toFixed(1)}% — sharp money on ${side === 'home' ? match.homeTeam : match.awayTeam}`;

    tips.push({
      matchId:               match.id,
      homeTeam:              match.homeTeam,
      awayTeam:              match.awayTeam,
      league:                match.league,
      sport:                 match.sport,
      startTime:             match.startTime,
      hoursToKickoff:        parseFloat(hoursToKickoff.toFixed(1)),
      pinnacleLineValue:     current,
      pinnacleLineDirection: side === 'home' ? 'Home' : 'Away',
      previousOdds:          previous,
      currentOdds:           current,
      oddsDropPct:           parseFloat(oddsDropPct.toFixed(2)),
      trueProbability:       parseFloat(trueProbability.toFixed(4)),
      targetMarket:          'moneyline',
      targetSelection:       selection,
      localBookmaker:        localOdds.bookmaker,
      localOdds:             localOdds.odds,
      confidence:            parseFloat((trueProbability * 100).toFixed(1)),
      signal,
    });
  }
}

    const trueProbability = calculateMoneylineTrueProbability(currentHome, currentAway, null, side);
    if (trueProbability < 0.62) continue;

    const localOdds = db.prepare(`
      SELECT bookmaker, odds
      FROM odds
      WHERE matchId = ?
      AND market = 'moneyline'
      AND selection = ?
      AND bookmaker != 'Pinnacle'
      AND odds >= 1.20
      ORDER BY odds DESC
      LIMIT 1
    `).get(match.id, selection) as any;

    if (!localOdds) continue;
    if (localOdds.odds < current) continue;

    const signal = `Pinnacle ${selection} dropping ${oddsDropPct.toFixed(1)}% — sharp money on ${side === 'home' ? match.homeTeam : match.awayTeam}`;

    tips.push({
      matchId:              match.id,
      homeTeam:             match.homeTeam,
      awayTeam:             match.awayTeam,
      league:               match.league,
      sport:                match.sport,
      startTime:            match.startTime,
      hoursToKickoff:       parseFloat(hoursToKickoff.toFixed(1)),
      pinnacleLineValue:    current,
      pinnacleLineDirection: side === 'home' ? 'Home' : 'Away',
      previousOdds:         previous,
      currentOdds:          current,
      oddsDropPct:          parseFloat(oddsDropPct.toFixed(2)),
      trueProbability:      parseFloat(trueProbability.toFixed(4)),
      targetMarket:         'moneyline',
      targetSelection:      selection,
      localBookmaker:       localOdds.bookmaker,
      localOdds:            localOdds.odds,
      confidence:           parseFloat((trueProbability * 100).toFixed(1)),
      signal,
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

  logger.info(`[TipScanner] Scanning ${matches.length} matches within ${hoursWindow}h window`);

  for (const match of matches) {
    const hoursToKickoff = (new Date(match.startTime).getTime() - now.getTime()) / (1000 * 60 * 60);

    // ── TENNIS: moneyline scanner ─────────────────────────────────────────
    if (match.sport === 'tennis') {
      scanTennisMoneyline(match, hoursToKickoff, tips);
      continue;
    }

    // ── FOOTBALL + BASKETBALL: totals scanner ─────────────────────────────

    const currentPinnacleOdds = db.prepare(`
      SELECT selection, odds, impliedProbability
      FROM odds
      WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'totals'
    `).all(match.id) as any[];

    if (!currentPinnacleOdds.length) continue;

    const previousSnapshot = db.prepare(`
      SELECT selection, odds, timestamp
      FROM odds_history
      WHERE matchId = ? AND bookmaker = 'Pinnacle' AND market = 'totals'
      ORDER BY timestamp ASC
      LIMIT 50
    `).all(match.id) as any[];

    if (!previousSnapshot.length) continue;

    const currentBySelection = new Map<string, number>();
    for (const o of currentPinnacleOdds) currentBySelection.set(o.selection, o.odds);

    const previousBySelection = new Map<string, number>();
    for (const o of previousSnapshot) {
      if (!previousBySelection.has(o.selection)) previousBySelection.set(o.selection, o.odds);
    }

    for (const [selection, currentOdds] of currentBySelection) {
      const parsed = parseSelection(selection);
      if (!parsed) continue;

      const previousOdds = previousBySelection.get(selection);
      if (!previousOdds) continue;

      const oddsDropPct = ((previousOdds - currentOdds) / previousOdds) * 100;
      if (oddsDropPct < 2) continue;

      const { direction, lineValue } = parsed;

      const oppositeSelection = direction === 'Over' ? `Under ${lineValue}` : `Over ${lineValue}`;
      const oppositeOdds      = currentBySelection.get(oppositeSelection);
      if (!oppositeOdds) continue;

      const overOdds        = direction === 'Over' ? currentOdds : oppositeOdds;
      const underOdds       = direction === 'Under' ? currentOdds : oppositeOdds;
      const trueProbability = calculateTrueProbability(overOdds, underOdds, direction);

      // Sport-specific bridge logic
      const bridge = match.sport === 'basketball'
        ? getBasketballBridgeTarget(lineValue, direction)
        : getBridgeTarget(lineValue, direction);
      if (!bridge) continue;

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

      // Push protection — skip flat integer lines for football only
      if (match.sport === 'football' && Number.isInteger(lineValue) && oddsDropPct < 5) continue;

      tips.push({
        matchId:              match.id,
        homeTeam:             match.homeTeam,
        awayTeam:             match.awayTeam,
        league:               match.league,
        sport:                match.sport,
        startTime:            match.startTime,
        hoursToKickoff:       parseFloat(hoursToKickoff.toFixed(1)),
        pinnacleLineValue:    lineValue,
        pinnacleLineDirection: direction,
        previousOdds,
        currentOdds,
        oddsDropPct:          parseFloat(oddsDropPct.toFixed(2)),
        trueProbability:      parseFloat(trueProbability.toFixed(4)),
        targetMarket:         'totals',
        targetSelection:      bridge.targetSelection,
        localBookmaker:       localOdds.bookmaker,
        localOdds:            localOdds.odds,
        confidence:           parseFloat((trueProbability * 100).toFixed(1)),
        signal:               bridge.signal,
      });
    }
  }

  tips.sort((a, b) => b.confidence - a.confidence);
  logger.info(`[TipScanner] Found ${tips.length} qualifying tips`);
  return tips;
}