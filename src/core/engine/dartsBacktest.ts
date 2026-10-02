// src/core/engine/dartsBacktest.ts
//
// Backtest for dartsTipGenerator.ts's match_winner_sets market — the
// ONLY darts market covered here. most_180s is explicitly excluded (see
// shelving decision — it's a proxy market with a flat, sub-threshold
// 0.50 confidence, not worth validating before the underlying data
// source it needs even exists).
//
// SCOPE: World Grand Prix only, 2021-2025 (5 editions, ~31 matches
// each ≈ 150+ matches). Chosen because:
//   - WGP is the ONLY sets-format major with confirmed, indexed
//     historical eids on dartsdatabase.co.uk going back years (see
//     WORLD_GRAND_PRIX_HISTORICAL_EIDS in dartsDatabaseScraper.ts)
//   - 2021+ keeps the player pool close enough to today's PLAYER_ID_MAP
//     to be relevant (older editions exist back to 1998 but are mostly
//     retired players)
//   - WGP is always sets format, every edition, no exceptions — so
//     SETS_FORMAT_CONFIDENCE_BOOST applies uniformly across the whole
//     backtest population, no format-mixing to control for
//
// ============================================================================
// CRITICAL DESIGN NOTE — WHY THIS DOES NOT CALL fetchPlayerStats()
// ============================================================================
// generateMatchWinnerTip() in production reads player1Stats.currentAverage
// from fetchPlayerStats(pid) — a LIVE snapshot of the player's current-year
// average as it stands TODAY. There is no historical/point-in-time version
// of that endpoint: it cannot tell you what a player's average was on, say,
// 6 October 2021. Using TODAY's average to grade a 2021 match would be
// lookahead bias — the tip would effectively know the outcome of years of
// future form before "predicting" a past match. That backtest would be
// worthless even if it produced a great-looking hit rate.
//
// INSTEAD: this script builds its own isolated, chronological match
// history as it replays events in date order, and computes each player's
// "current average" at the time of a given match as the mean of that
// player's own per-match averages from STRICTLY EARLIER matches only
// (within this backtest's own history — never from matches processed
// later in the replay, and never from fetchPlayerStats()). This mirrors
// the spirit of dartsTipGenerator.ts's use of a "current average" signal
// without the lookahead problem — it is a considered proxy, not an exact
// replica of production's data source, and that gap is deliberate and
// documented here rather than hidden.
//
// This local history is 100% separate from dartsMatchStore.ts's real
// persistent cache (.cache/stats/darts-match-history.json) — running
// this backtest does NOT read from or write to that file. Contaminating
// the live match store with backtest data would corrupt real H2H/form
// results for the live pipeline, so this script keeps its own in-memory
// Map for the duration of the run only.
//
// COLD START CAVEAT: the very first matches in the 2021 edition (the
// earliest event in scope) have no prior data for most players and will
// be skipped — same behavior as generateMatchWinnerTip()'s real
// `if (!player1Stats || !player2Stats) return null` gate. This is
// expected and correct, not a bug: there's no way to know a player's
// "current form" before any recorded matches exist for them in this
// dataset.
// ============================================================================

import { fetchEventResults, DartsMatchResult, WORLD_GRAND_PRIX_HISTORICAL_EIDS } from '../../scrapers/darts/dartsDatabaseScraper';

// ─── CONFIG — MUST MATCH dartsTipGenerator.ts EXACTLY ────────────────────────
// These are copy-pasted, not imported, on purpose: dartsTipGenerator.ts's
// generateMatchWinnerTip() takes a DartsFixtureWithContext (live pipeline
// shape) as input, not raw historical data, so it can't be called
// directly against backtest data without a fair amount of adapter code.
// Replicating the exact formula here (and keeping the constants in sync
// by hand) is more transparent for a first-pass backtest than building
// that adapter — but it DOES mean: if dartsTipGenerator.ts's constants
// ever change, this file must be updated to match, or the backtest will
// silently validate a formula that's no longer the one actually running
// in production. Revisit this if/when a real adapter is worth building.
const MIN_AVG_DIFFERENCE_FOR_TIP = 4.0;
const MIN_H2H_MEETINGS_FOR_WEIGHT = 3;
const SETS_FORMAT_CONFIDENCE_BOOST = 0.10;
const BASE_CONFIDENCE = 0.55;

// Minimum prior matches (in this backtest's own local history) before a
// player's rolling average is trusted enough to grade a tip on — NOT a
// constant from dartsTipGenerator.ts (production has no equivalent gate
// for its live current-year average, since dartsdatabase.co.uk's
// current-year average is presumed reliable regardless of sample size).
// This is a backtest-specific safeguard against grading matches off a
// rolling average built from only 1-2 prior games, which would be noisy
// almost by definition.
const MIN_PRIOR_MATCHES_FOR_ROLLING_AVG = 3;

// ─── LOCAL, ISOLATED MATCH HISTORY (backtest-only, in-memory) ────────────────

interface LocalMatchRecord {
  year: number;
  roundOrder: number;
  player1: string;
  player2: string;
  player1Avg: number;
  player2Avg: number;
  winner: string; // normalized name
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

class LocalHistory {
  private records: LocalMatchRecord[] = [];

  // All matches involving this player, STRICTLY BEFORE the given
  // (year, roundOrder) point in the replay — never matches at or after it.
  priorMatchesFor(player: string, year: number, roundOrder: number): LocalMatchRecord[] {
    const n = normalize(player);
    return this.records.filter(r => {
      const isEarlier = r.year < year || (r.year === year && r.roundOrder < roundOrder);
      return isEarlier && (normalize(r.player1) === n || normalize(r.player2) === n);
    });
  }

  // This player's own average, per prior match, regardless of opponent.
  rollingAverage(player: string, year: number, roundOrder: number): { avg: number | null; sampleSize: number } {
    const prior = this.priorMatchesFor(player, year, roundOrder);
    const n = normalize(player);
    const ownAvgs = prior.map(r => (normalize(r.player1) === n ? r.player1Avg : r.player2Avg));
    if (ownAvgs.length === 0) return { avg: null, sampleSize: 0 };
    const avg = ownAvgs.reduce((s, v) => s + v, 0) / ownAvgs.length;
    return { avg, sampleSize: ownAvgs.length };
  }

  // This player's own win rate across prior matches (any opponent).
  rollingWinRate(player: string, year: number, roundOrder: number): { winRate: number | null; sampleSize: number } {
    const prior = this.priorMatchesFor(player, year, roundOrder);
    if (prior.length === 0) return { winRate: null, sampleSize: 0 };
    const n = normalize(player);
    const wins = prior.filter(r => normalize(r.winner) === n).length;
    return { winRate: wins / prior.length, sampleSize: prior.length };
  }

  // H2H between these two specific players, prior matches only.
  h2h(player1: string, player2: string, year: number, roundOrder: number): { player1Wins: number; player2Wins: number; totalMeetings: number } {
    const n1 = normalize(player1);
    const n2 = normalize(player2);
    const meetings = this.records.filter(r => {
      const isEarlier = r.year < year || (r.year === year && r.roundOrder < roundOrder);
      if (!isEarlier) return false;
      const rp1 = normalize(r.player1);
      const rp2 = normalize(r.player2);
      return (rp1 === n1 && rp2 === n2) || (rp1 === n2 && rp2 === n1);
    });
    let p1Wins = 0, p2Wins = 0;
    for (const m of meetings) {
      if (normalize(m.winner) === n1) p1Wins++; else p2Wins++;
    }
    return { player1Wins: p1Wins, player2Wins: p2Wins, totalMeetings: meetings.length };
  }

  record(match: LocalMatchRecord): void {
    this.records.push(match);
  }
}

// ─── ROUND ORDERING ───────────────────────────────────────────────────────────
// WGP round names, mapped to a strict chronological order WITHIN a single
// edition. Actual per-match dates aren't available from fetchEventResults()
// (it returns one date for the whole event, not per match) — round order
// is a safe proxy since later rounds always happen after earlier ones by
// tournament structure, regardless of exact day/time.
const ROUND_ORDER: Record<string, number> = {
  'last 32': 1,
  'last 16': 2,
  'quarter final': 3,
  'semi final': 4,
  'final': 5,
};

function roundOrderFor(round: string | null): number | null {
  if (!round) return null;
  const key = round.toLowerCase().trim();
  return ROUND_ORDER[key] ?? null;
}

// ─── PREDICTION LOGIC (mirrors generateMatchWinnerTip exactly) ───────────────

interface BacktestPrediction {
  year: number;
  round: string;
  player1: string;
  player2: string;
  predictedFavorite: string;
  confidence: number;
  actualWinner: string;
  hit: boolean;
}

function computeConfidence(
  avg1: number, avg2: number,
  winRate1: number | null, winRate2: number | null,
  h2h: { player1Wins: number; player2Wins: number; totalMeetings: number },
): { favoredIsPlayer1: boolean; confidence: number } | null {
  const avgDiff = avg1 - avg2;
  const absAvgDiff = Math.abs(avgDiff);

  if (absAvgDiff < MIN_AVG_DIFFERENCE_FOR_TIP) return null; // no tip — matches production's skip

  const favoredIsPlayer1 = avgDiff >= 0;
  let confidence = BASE_CONFIDENCE;

  confidence += Math.min(absAvgDiff / 20, 0.20);

  if (winRate1 !== null && winRate2 !== null) {
    const winRateAgrees = favoredIsPlayer1 ? winRate1 > winRate2 : winRate2 > winRate1;
    confidence += winRateAgrees ? 0.05 : -0.05;
  }
  // If win-rate data isn't available for one/both players yet (early in
  // the replay), production's generateMatchWinnerTip() doesn't have this
  // gap — it always has a currentWinPct from fetchPlayerStats(). This
  // backtest's rolling proxy can genuinely be null early on; when it is,
  // this adjustment is simply skipped rather than guessed at.

  if (h2h.totalMeetings >= MIN_H2H_MEETINGS_FOR_WEIGHT) {
    const h2hFavorsPlayer1 = h2h.player1Wins > h2h.player2Wins;
    const h2hFavorsFavorite = favoredIsPlayer1 ? h2hFavorsPlayer1 : !h2hFavorsPlayer1;
    confidence += h2hFavorsFavorite ? 0.08 : -0.08;
  }

  // WGP is sets format, every edition, no exceptions — SETS_FORMAT_CONFIDENCE_BOOST
  // always applies within this backtest's scope.
  confidence += SETS_FORMAT_CONFIDENCE_BOOST;

  confidence = Math.max(0, Math.min(1, confidence));

  return { favoredIsPlayer1, confidence };
}

// ─── MAIN BACKTEST ────────────────────────────────────────────────────────────

export async function runDartsBacktest(): Promise<void> {
  const history = new LocalHistory();
  const predictions: BacktestPrediction[] = [];

  // Fetch all events first, sorted oldest-to-newest — this is what makes
  // the chronological replay valid. Sorting is on `year`, ascending.
  const events = [...WORLD_GRAND_PRIX_HISTORICAL_EIDS].sort((a, b) => a.year - b.year);

  for (const { year, eid } of events) {
    const result = await fetchEventResults(eid, 'World Grand Prix', String(year));
    if (!result) {
      console.warn(`[DartsBacktest] Could not fetch WGP ${year} (eid=${eid}) — skipping`);
      continue;
    }

    // Sort this event's own matches by round order so within-tournament
    // replay is also chronologically valid (Last 32 before Last 16, etc.)
    const withRoundOrder = result.matches
      .map(m => ({ ...m, roundOrder: roundOrderFor(m.round) }))
      .filter((m): m is DartsMatchResult & { roundOrder: number } => m.roundOrder !== null);

    const skippedForUnknownRound = result.matches.length - withRoundOrder.length;
    if (skippedForUnknownRound > 0) {
      console.warn(`[DartsBacktest] WGP ${year}: ${skippedForUnknownRound} match(es) had an unrecognized round label and were skipped entirely (not counted as a graded miss)`);
    }

    withRoundOrder.sort((a, b) => a.roundOrder - b.roundOrder);

    for (const match of withRoundOrder) {
      const { player1, player2, player1Avg, player2Avg, roundOrder, round } = match;
      if (player1Avg === null || player2Avg === null) continue; // shouldn't happen for WGP, defensive only

      const actualWinner = match.player1Legs > match.player2Legs ? player1 : player2;

      // ── GRADE THIS MATCH FIRST, using only strictly-prior history ──
      const p1Rolling = history.rollingAverage(player1, year, roundOrder);
      const p2Rolling = history.rollingAverage(player2, year, roundOrder);

      if (
        p1Rolling.avg !== null && p1Rolling.sampleSize >= MIN_PRIOR_MATCHES_FOR_ROLLING_AVG &&
        p2Rolling.avg !== null && p2Rolling.sampleSize >= MIN_PRIOR_MATCHES_FOR_ROLLING_AVG
      ) {
        const p1WinRate = history.rollingWinRate(player1, year, roundOrder);
        const p2WinRate = history.rollingWinRate(player2, year, roundOrder);
        const h2h = history.h2h(player1, player2, year, roundOrder);

        const result = computeConfidence(
          p1Rolling.avg, p2Rolling.avg,
          p1WinRate.winRate, p2WinRate.winRate,
          h2h,
        );

        if (result) {
          const predictedFavorite = result.favoredIsPlayer1 ? player1 : player2;
          predictions.push({
            year,
            round: round ?? 'unknown',
            player1,
            player2,
            predictedFavorite,
            confidence: result.confidence,
            actualWinner,
            hit: normalize(predictedFavorite) === normalize(actualWinner),
          });
        }
      }

      // ── THEN record this match into history for FUTURE matches ──
      history.record({
        year,
        roundOrder,
        player1,
        player2,
        player1Avg,
        player2Avg,
        winner: actualWinner,
      });
    }
  }

  // ─── REPORT ──────────────────────────────────────────────────────────────

  console.log(`\n[DartsBacktest] Total graded predictions: ${predictions.length}`);
  console.log(`[DartsBacktest] (Matches skipped due to insufficient prior data or below the ${MIN_AVG_DIFFERENCE_FOR_TIP}-average-gap tip threshold are NOT counted above — this is expected, not a data loss bug.)\n`);

  if (predictions.length === 0) {
    console.log('[DartsBacktest] No predictions were graded — insufficient historical depth or a parsing issue. Check event fetch warnings above.');
    return;
  }

  const overallHits = predictions.filter(p => p.hit).length;
  const overallAvgConfidence = predictions.reduce((s, p) => s + p.confidence, 0) / predictions.length;
  console.log(`[DartsBacktest] OVERALL: ${overallHits}/${predictions.length} correct (${(100 * overallHits / predictions.length).toFixed(1)}%) — average stated confidence ${(100 * overallAvgConfidence).toFixed(1)}%\n`);

  // Confidence-band breakdown — same idea as every other sport's isotonic
  // fit input data: does real accuracy track stated confidence, or is
  // there a gap (like corners_winner's 85.4% stated vs 67.6% actual)?
  const bands: { label: string; min: number; max: number }[] = [
    { label: '0.72-0.80', min: 0.72, max: 0.80 },
    { label: '0.80-0.88', min: 0.80, max: 0.88 },
    { label: '0.88-0.95', min: 0.88, max: 0.95 },
    { label: '0.95-1.00', min: 0.95, max: 1.01 },
  ];

  console.log('[DartsBacktest] Confidence band breakdown:');
  for (const band of bands) {
    const inBand = predictions.filter(p => p.confidence >= band.min && p.confidence < band.max);
    if (inBand.length === 0) {
      console.log(`  ${band.label}: no predictions in this band`);
      continue;
    }
    const hits = inBand.filter(p => p.hit).length;
    const avgStated = inBand.reduce((s, p) => s + p.confidence, 0) / inBand.length;
    const actualRate = hits / inBand.length;
    const gap = (actualRate - avgStated) * 100;
    console.log(
      `  ${band.label}: n=${inBand.length}, stated avg=${(avgStated * 100).toFixed(1)}%, actual=${(actualRate * 100).toFixed(1)}%, gap=${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp` +
      (inBand.length < 20 ? '  ⚠️ small sample — treat with caution' : '')
    );
  }

  console.log('\n[DartsBacktest] Reminder: this validates the FORMULA structure using a rolling-average proxy, not production\'s exact fetchPlayerStats() data source (see design note at top of file). Treat results as directional evidence for whether this approach is worth pursuing further — not as a finished, production-ready calibration.');
}

// Run directly if invoked as a script (e.g. `ts-node dartsBacktest.ts`)
if (require.main === module) {
  runDartsBacktest().catch(err => {
    console.error('[DartsBacktest] Fatal error', err);
    process.exit(1);
  });
}