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
// ctx.majorName comes directly from getActiveMajor().name in
// dartsFetch.ts — reliable since this module currently only runs for
// majors (regular Tour events have no working fixture source yet).
//
// CORRECTED this session — this list was audited tournament-by-tournament
// against real Wikipedia infobox data (each checked across multiple
// years, not just assumed from the tournament's reputation), after
// 'world grand prix' was found missing entirely and 'world matchplay'
// was found to be WRONGLY included. Full audit result:
//
//   world championship   -> CONFIRMED sets (every year, best-of-N sets
//                            escalating by round)
//   world grand prix     -> CONFIRMED sets, double-in/double-out (added
//                            this session — was missing)
//   world masters        -> CONFIRMED sets, but ONLY for the 2025
//                            edition onward — 2013-2024 editions were
//                            LEGS format (the tournament was completely
//                            revamped for 2025). Since MAJOR_TOURNAMENTS
//                            in dartsWikipediaScraper.ts only lists the
//                            current/future edition (2026), this is safe
//                            for the LIVE pipeline as-is — but a future
//                            backtest expansion touching pre-2025 World
//                            Masters data would need to exclude it from
//                            this list for those years specifically.
//
// REMOVED — confirmed LEGS format via real Wikipedia infobox checks
// across multiple years each (these were WRONGLY treated as sets-format
// before this session, meaning any live match at these tournaments would
// have incorrectly received SETS_FORMAT_CONFIDENCE_BOOST and the
// misleading "Sets format — variance suppressed" reasoning line):
//   world matchplay              -> legs (confirmed 1998-2020, 5 editions)
//   grand slam                   -> legs (confirmed 2007-2025), also a
//                                    group-stage format, not a straight
//                                    knockout bracket like World Grand Prix
//   players championship finals  -> legs (confirmed 2010-2025, 6 editions)
//   premier league                -> legs (confirmed via infobox + 2
//                                    independent sources), also a weekly
//                                    league table over months, not a
//                                    bracket at all
//   world cup of darts           -> legs (confirmed 2012-2023, 6
//                                    editions), also a DOUBLES/TEAMS
//                                    event (national pairs), not 1v1
//                                    singles — this generator's
//                                    player1/player2 model doesn't map
//                                    onto it even setting format aside
//   european championship        -> legs (confirmed 2014-2022, 5 editions)

const KNOWN_SETS_FORMAT_EVENTS = [
  'world championship',
  'world grand prix',
  'world masters', // current/future editions only — see comment above
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
//
// STATUS: shelved pending a real data source. This is currently a proxy
// that reuses the average-difference signal from match_winner_sets with
// a flat, non-varying 0.50 confidence — it does NOT use actual 180s
// counts at all (no confirmed per-match 180s source exists yet — see
// dartsWikipediaScraper.ts's fetchMajorSummary comments). 0.50 sits
// below even THRESHOLDS.MIN_CONFIDENCE (0.55) used elsewhere in this
// codebase, let alone any sport's real practical bar — this market
// cannot clear a real confidence threshold as currently built. Kept in
// the code (not deleted) since the function is harmless when unused,
// but should not be wired into any live tip consumer until a real 180s
// data source exists.

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