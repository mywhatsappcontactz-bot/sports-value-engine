// src/core/engine/dartsTipGenerator.ts
//
// Darts tip logic, kept as its own module rather than inlined directly
// into tipScanner.ts.
//
// Two markets, per your explicit scope from earlier:
//   1. match_winner_sets — ALWAYS active (any darts event, any format)
//      but only meaningful confidence-wise for SETS-format matches,
//      since legs-only formats have much higher variance.
//   2. most_180s — ONLY active when isMajorInSession() is true.

import { logger } from '../utils/logger';
import { DartsFixtureWithContext } from '../../data-bridge/dartsFetch';
import { isMajorInSession } from '../../scrapers/darts/dartsWikipediaScraper';

// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Thresholds below are STARTING POINTS, not validated/backtested values.

const MIN_AVG_DIFFERENCE_FOR_TIP = 4.0;
const MIN_H2H_MEETINGS_FOR_WEIGHT = 3;
const SETS_FORMAT_CONFIDENCE_BOOST = 0.10;
const BASE_CONFIDENCE = 0.55;

export interface DartsTip {
  market:         'match_winner_sets' | 'most_180s';
  player1:        string;
  player2:        string;
  favorite:       string;
  confidence:     number;
  reasoning:      string[];
  isSetsFormat:   boolean;
  majorContext:   string | null;
}

// ─── FORMAT DETECTION ─────────────────────────────────────────────────────────
// FIXED: originally checked fixture.eventName, a field that belonged to the
// old (broken) DartsFixture type from dartsdatabase.co.uk — LiveDartsMatch
// (the current fixture type, from liveDartsScraper.ts) has no eventName
// field at all, causing a real compile error. ctx.majorName is actually
// more reliable anyway — it comes directly from getActiveMajor().name in
// dartsFetch.ts, not from a fixtures endpoint that was confirmed broken.
// Since this whole module currently only runs for majors (see dartsFetch.ts
// — regular Tour events have no working fixture source yet), majorName is
// never null in practice when this function is actually called, but the
// fallback to '' keeps this safe if that changes later.

const KNOWN_SETS_FORMAT_EVENTS = [
  'world championship',
  'world matchplay',
  'world masters',
  'grand slam',
  'players championship finals',
  'premier league',
  'world cup of darts',
  'european championship',
];

function isSetsFormatEvent(eventName: string): boolean {
  const lower = eventName.toLowerCase();
  return KNOWN_SETS_FORMAT_EVENTS.some(name => lower.includes(name));
}

// ─── MATCH WINNER (SETS FORMAT) ──────────────────────────────────────────────

export function generateMatchWinnerTip(ctx: DartsFixtureWithContext): DartsTip | null {
  const { fixture, player1Stats, player2Stats, h2h } = ctx;

  if (!player1Stats || !player2Stats) {
    logger.debug('[DartsTips] Skipping match_winner tip — missing stats for one or both players', {
      match: `${fixture.player1} vs ${fixture.player2}`,
    });
    return null;
  }

  const isSets = isSetsFormatEvent(ctx.majorName ?? '');
  const reasoning: string[] = [];

  const avg1 = player1Stats.currentAverage;
  const avg2 = player2Stats.currentAverage;
  const avgDiff = avg1 - avg2;

  let favorite = avgDiff >= 0 ? fixture.player1 : fixture.player2;
  let confidence = BASE_CONFIDENCE;

  const absAvgDiff = Math.abs(avgDiff);
  if (absAvgDiff < MIN_AVG_DIFFERENCE_FOR_TIP) {
    logger.debug('[DartsTips] Average difference too small to tip', {
      match: `${fixture.player1} vs ${fixture.player2}`,
      avgDiff: absAvgDiff.toFixed(2),
    });
    return null;
  }

  reasoning.push(`Average gap: ${player1Stats.name} ${avg1.toFixed(2)} vs ${player2Stats.name} ${avg2.toFixed(2)}`);

  const avgConfidenceBoost = Math.min(absAvgDiff / 20, 0.20);
  confidence += avgConfidenceBoost;

  const winPct1 = player1Stats.currentWinPct;
  const winPct2 = player2Stats.currentWinPct;
  const favoredByAvg = favorite === fixture.player1;
  const winPctAgrees = favoredByAvg ? winPct1 > winPct2 : winPct2 > winPct1;

  if (winPctAgrees) {
    confidence += 0.05;
    reasoning.push(`Win% agrees: ${player1Stats.name} ${winPct1.toFixed(1)}% vs ${player2Stats.name} ${winPct2.toFixed(1)}%`);
  } else {
    confidence -= 0.05;
    reasoning.push(`Win% conflicts with average favorite (weighting down slightly)`);
  }

  if (h2h.totalMeetings >= MIN_H2H_MEETINGS_FOR_WEIGHT) {
    const h2hFavorsPlayer1 = h2h.player1Wins > h2h.player2Wins;
    const h2hFavorsFavorite = favoredByAvg ? h2hFavorsPlayer1 : !h2hFavorsPlayer1;

    if (h2hFavorsFavorite) {
      confidence += 0.08;
      reasoning.push(`H2H supports favorite: ${h2h.player1Wins}-${h2h.player2Wins} over ${h2h.totalMeetings} meetings`);
    } else {
      confidence -= 0.08;
      reasoning.push(`H2H favors underdog: ${h2h.player1Wins}-${h2h.player2Wins} over ${h2h.totalMeetings} meetings (weighting down)`);
    }
  } else {
    reasoning.push(`H2H sample too small to weight (${h2h.totalMeetings} meetings)`);
  }

  if (isSets) {
    confidence += SETS_FORMAT_CONFIDENCE_BOOST;
    reasoning.push('Sets format — variance suppressed relative to legs-only');
  } else {
    reasoning.push('Legs-only format — higher variance, confidence not boosted');
  }

  confidence = Math.max(0, Math.min(1, confidence));

  return {
    market: 'match_winner_sets',
    player1: fixture.player1,
    player2: fixture.player2,
    favorite,
    confidence: parseFloat(confidence.toFixed(3)),
    reasoning,
    isSetsFormat: isSets,
    majorContext: ctx.majorName,
  };
}

// ─── MOST 180s (MAJORS ONLY) ─────────────────────────────────────────────────

export function generateMost180sTip(ctx: DartsFixtureWithContext): DartsTip | null {
  if (!isMajorInSession()) {
    return null;
  }

  const { fixture, player1Stats, player2Stats } = ctx;

  if (!player1Stats || !player2Stats) {
    return null;
  }

  const avg1 = player1Stats.currentAverage;
  const avg2 = player2Stats.currentAverage;

  if (Math.abs(avg1 - avg2) < MIN_AVG_DIFFERENCE_FOR_TIP) {
    return null;
  }

  const favorite = avg1 > avg2 ? fixture.player1 : fixture.player2;

  return {
    market: 'most_180s',
    player1: fixture.player1,
    player2: fixture.player2,
    favorite,
    confidence: 0.50,
    reasoning: [
      `PROXY TIP: no confirmed per-match 180s source yet — using average as a rough stand-in`,
      `Average: ${player1Stats.name} ${avg1.toFixed(2)} vs ${player2Stats.name} ${avg2.toFixed(2)}`,
      `Major tournament in session: ${ctx.majorName}`,
    ],
    isSetsFormat: true,
    majorContext: ctx.majorName,
  };
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

export function generateDartsTips(contexts: DartsFixtureWithContext[]): DartsTip[] {
  const tips: DartsTip[] = [];

  for (const ctx of contexts) {
    const matchWinnerTip = generateMatchWinnerTip(ctx);
    if (matchWinnerTip) tips.push(matchWinnerTip);

    const most180sTip = generateMost180sTip(ctx);
    if (most180sTip) tips.push(most180sTip);
  }

  logger.info('[DartsTips] Generated tips', {
    totalFixtures: contexts.length,
    tipsGenerated: tips.length,
    matchWinnerTips: tips.filter(t => t.market === 'match_winner_sets').length,
    most180sTips: tips.filter(t => t.market === 'most_180s').length,
  });

  return tips;
}