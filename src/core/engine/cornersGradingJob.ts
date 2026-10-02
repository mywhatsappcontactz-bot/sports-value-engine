// src/core/engine/cornersGradingJob.ts
//
// Run this once daily (separate Task Scheduler job from the 30-min scanner).
// Pulls a budget-limited batch of pending corners tips whose matches have
// already kicked off, looks up the real fixture on API-Football, fetches
// final corner stats, and grades hit/miss + Brier score.
//
// This is DELIBERATELY not real-time. A tip from Saturday might not get
// graded until Tuesday if the queue is backed up — that's fine, nothing
// here needs same-day settlement. The queue exists specifically so a busy
// weekend's tip volume doesn't need to fit inside a single day's API budget.
//
// UPDATED to support the corners_winner market (Home/Draw/Away on corner
// count) alongside the existing corners_totals (Over X.X) market. Two
// changes drove this:
//   1. extractTotalCorners() used to sum both teams into one blind total —
//      fine for grading an Over/Under line, useless for deciding which side
//      had more corners. Replaced with extractCornersBySide(), which keeps
//      each team's corner count separate.
//   2. evaluateSelection() used to only recognize "Over X.X" and silently
//      returned `false` (a graded MISS, not "unresolvable") for anything
//      else — including every "Home"/"Draw"/"Away" corners_winner
//      selection. That would have corrupted Brier-score tracking for the
//      new market from day one. Now dispatches on selection shape.
//
// FIXED (this pass): team_corners_over tips ("Home Over 3.5", "Away Over
// 4.5" — from modelFootballTeamCornersOver in probabilityModel.ts) were
// being silently matched by the generic totals regex (/Over\s+([\d.]+)/,
// which matches inside "Home Over 3.5" too) and graded against
// sumCorners(bySide) — the COMBINED match total — instead of the one
// team's own corner count, which is what that market actually predicts.
// Since combined corners almost always clears a single-team line, this
// was grading nearly every team_corners_over tip as a hit regardless of
// whether it actually was one, corrupting hit-rate/Brier tracking for
// that market from its introduction. Fixed by adding
// evaluateTeamCornersOverSelection(), checked BEFORE the generic totals
// check, with selections matched via an anchored ^...$ regex against the
// exact shape modelFootballTeamCornersOver produces.

import 'dotenv/config';
import { getDb } from '../database/db';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';
import { CornersGradingQueueEntry } from '../database/schema';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

// Leave headroom below the 100/day free-tier cap — other jobs may also use
// this key, and a lookup call plus a stats call can both be needed per tip.
const DAILY_BUDGET = 40;

if (!API_FOOTBALL_KEY) {
  throw new Error('[CornersGradingJob] API_FOOTBALL_KEY not set in .env');
}

async function apiFootballGet(path: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API_FOOTBALL_BASE}${path}?${query}`, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY! },
  });
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status} for ${path}`);
  return res.json();
}

// Finds the API-Football fixture ID for a given match. This is a best-effort
// name match — API-Football team names won't line up perfectly with your
// internal names any more than FCStats/SoccerStats did, so this reuses the
// same normalize-and-compare approach as the other scrapers rather than
// assuming exact string equality.
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function findFixtureId(entry: CornersGradingQueueEntry): Promise<number | null> {
  const dateOnly = entry.startTime.split('T')[0];
  const data = await apiFootballGet('/fixtures', { date: dateOnly, status: 'FT' });

  const homeKey = normalize(entry.homeTeam);
  const awayKey = normalize(entry.awayTeam);

  for (const fixture of data.response ?? []) {
    const fHome = normalize(fixture.teams?.home?.name ?? '');
    const fAway = normalize(fixture.teams?.away?.name ?? '');
    if (
      (fHome.includes(homeKey) || homeKey.includes(fHome)) &&
      (fAway.includes(awayKey) || awayKey.includes(fAway))
    ) {
      return fixture.fixture.id;
    }
  }
  return null;
}

interface CornersBySide {
  home: number;
  away: number;
}

// Splits the fixture statistics response into home/away corner counts
// instead of blindly summing them. API-Football's /fixtures/statistics
// response is an array of per-team blocks, each carrying a `team` object
// (id/name/logo) alongside that team's `statistics` array — so we match
// each block back to home/away by team name, the same normalize-and-compare
// approach used everywhere else in this pipeline (API-Football names won't
// line up exactly with internal names any more than soccerstats.com's do).
//
// Returns null if either side is missing a Corner Kicks stat, or if a
// block can't be matched to home or away at all — better to mark the tip
// unresolvable than silently grade it against a guessed side.
function extractCornersBySide(
  statsResponse: any,
  homeTeamName: string,
  awayTeamName: string
): CornersBySide | null {
  const homeKey = normalize(homeTeamName);
  const awayKey = normalize(awayTeamName);

  let home: number | null = null;
  let away: number | null = null;

  for (const teamStats of statsResponse.response ?? []) {
    const teamName = normalize(teamStats.team?.name ?? '');
    const cornerStat = (teamStats.statistics ?? []).find(
      (s: any) => s.type === 'Corner Kicks'
    );
    if (!cornerStat || cornerStat.value == null) continue;

    const corners = Number(cornerStat.value);

    if (teamName.includes(homeKey) || homeKey.includes(teamName)) {
      home = corners;
    } else if (teamName.includes(awayKey) || awayKey.includes(teamName)) {
      away = corners;
    }
  }

  if (home == null || away == null) return null;
  return { home, away };
}

// Kept for any other caller that still wants a combined total (e.g. if a
// future corners_totals grading path wants just the sum) — now derived
// from the split rather than being the only thing computed.
function sumCorners(bySide: CornersBySide): number {
  return bySide.home + bySide.away;
}

// NEW: matches team_corners_over selections specifically — "Home Over X.X"
// or "Away Over X.X" (see modelFootballTeamCornersOver in
// probabilityModel.ts, the only place that produces this exact selection
// shape). MUST be checked before evaluateTotalsSelection below, since
// "Home Over 3.5" would otherwise also match that function's plain
// /Over\s+([\d.]+)/ regex and get graded against the wrong number — this
// was the bug this pass fixes. Anchored (^...$) to the exact shape
// modelFootballTeamCornersOver produces, unlike the totals/winner checks
// below, since we're fixing a real production bug here and want no
// ambiguity about what this matches.
function evaluateTeamCornersOverSelection(selection: string, bySide: CornersBySide): boolean | null {
  const homeMatch = selection.match(/^Home Over\s+([\d.]+)$/i);
  if (homeMatch) return bySide.home > parseFloat(homeMatch[1]);

  const awayMatch = selection.match(/^Away Over\s+([\d.]+)$/i);
  if (awayMatch) return bySide.away > parseFloat(awayMatch[1]);

  return null; // not a team-corners-over-shaped selection
}

function evaluateTotalsSelection(selection: string, totalCorners: number): boolean | null {
  // selection shaped like "Over 9.5" or "Under 9.5" — no Home/Away prefix.
  // Checked AFTER evaluateTeamCornersOverSelection above, so a
  // "Home Over 3.5" selection never reaches here in the first place.
  const overMatch = selection.match(/Over\s+([\d.]+)/);
  if (overMatch) return totalCorners > parseFloat(overMatch[1]);

  const underMatch = selection.match(/Under\s+([\d.]+)/);
  if (underMatch) return totalCorners < parseFloat(underMatch[1]);

  return null; // not a totals-shaped selection
}

// corners_winner selections are exactly "Home", "Draw", or "Away" (see
// modelFootballCornersWinner in probabilityModel.ts) — compare the split
// corner counts directly rather than parsing a line out of the string.
function evaluateWinnerSelection(selection: string, bySide: CornersBySide): boolean | null {
  const normalized = selection.trim().toLowerCase();

  if (normalized === 'home') return bySide.home > bySide.away;
  if (normalized === 'away') return bySide.away > bySide.home;
  if (normalized === 'draw') return bySide.home === bySide.away;

  return null; // not a winner-shaped selection
}

// Dispatches on the shape of the selection string rather than requiring a
// separate `market` column on the queue entry. Order matters:
// team-corners-over is checked FIRST since its selection shape ("Home
// Over X.X") is a strict superset of what the generic totals regex would
// also match — checking totals first was the bug. If none of the three
// shapes match, this is a genuinely unrecognized selection and the caller
// should mark the entry unresolvable rather than silently grading it as a
// miss.
function evaluateSelection(selection: string, bySide: CornersBySide): boolean | null {
  const teamOverResult = evaluateTeamCornersOverSelection(selection, bySide);
  if (teamOverResult !== null) return teamOverResult;

  const totalsResult = evaluateTotalsSelection(selection, sumCorners(bySide));
  if (totalsResult !== null) return totalsResult;

  const winnerResult = evaluateWinnerSelection(selection, bySide);
  if (winnerResult !== null) return winnerResult;

  return null;
}

export async function runCornersGradingJob(): Promise<void> {
  const db = getDb();
  const repository = new Repository(db);

  const pending = repository.getPendingCornersGrading(DAILY_BUDGET);
  if (!pending.length) {
    logger.info('[CornersGradingJob] No pending corners tips to grade');
    return;
  }

  logger.info(`[CornersGradingJob] Grading ${pending.length} pending tips (budget: ${DAILY_BUDGET}/day)`);

  let graded = 0;
  let unresolved = 0;

  for (const entry of pending) {
    try {
      const fixtureId = entry.apiFootballFixtureId ?? (await findFixtureId(entry));

      if (!fixtureId) {
        logger.warn('[CornersGradingJob] Could not match fixture', {
          matchId: entry.matchId,
          homeTeam: entry.homeTeam,
          awayTeam: entry.awayTeam,
        });
        repository.markCornersUnresolvable(entry.id);
        unresolved++;
        continue;
      }

      const statsResponse = await apiFootballGet('/fixtures/statistics', {
        fixture: String(fixtureId),
      });

      const bySide = extractCornersBySide(statsResponse, entry.homeTeam, entry.awayTeam);

      if (bySide == null) {
        logger.warn('[CornersGradingJob] Could not extract per-side corners from response', {
          matchId: entry.matchId,
          fixtureId,
        });
        repository.markCornersUnresolvable(entry.id);
        unresolved++;
        continue;
      }

      const hitResult = evaluateSelection(entry.targetSelection, bySide);

      if (hitResult === null) {
        logger.warn('[CornersGradingJob] Unrecognized selection shape — not totals, winner, or team over', {
          matchId: entry.matchId,
          selection: entry.targetSelection,
        });
        repository.markCornersUnresolvable(entry.id);
        unresolved++;
        continue;
      }

      const actualCorners = sumCorners(bySide);
      const actualOutcome = hitResult ? 1 : 0;
      const brierScore = Math.pow(entry.predictedProbability - actualOutcome, 2);

      repository.markCornersGraded(entry.id, actualCorners, hitResult, brierScore);
      graded++;

      logger.info('[CornersGradingJob] Graded', {
        matchId: entry.matchId,
        selection: entry.targetSelection,
        homeCorners: bySide.home,
        awayCorners: bySide.away,
        actualCorners,
        hit: hitResult,
        brierScore: brierScore.toFixed(4),
      });
    } catch (err: any) {
      logger.error('[CornersGradingJob] Failed to grade entry', {
        matchId: entry.matchId,
        error: err.message,
      });
      // Leave as 'pending' — will retry on next run, not marked unresolvable
      // for a transient error (network, rate limit, etc.).
    }
  }

  logger.info(`[CornersGradingJob] Done — graded: ${graded}, unresolvable: ${unresolved}`);

  const summary = repository.getCornersGradingSummary();
  logger.info('[CornersGradingJob] Running summary', {
    totalGraded: summary.totalGraded,
    hitRate: (summary.hitRate * 100).toFixed(1) + '%',
    avgBrierScore: summary.avgBrierScore.toFixed(4),
  });
}

// Allow running directly: npx ts-node src/core/engine/cornersGradingJob.ts
if (require.main === module) {
  runCornersGradingJob()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[CornersGradingJob] Fatal error', { error: err.message });
      process.exit(1);
    });
}