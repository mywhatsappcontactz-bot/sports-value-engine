// src/data-bridge/tennisFixturesSync.ts
//
// Writes tennisexplorer.com fixtures (ATP + WTA singles) into the
// matches table via Repository.upsertMatch(), then attaches H2H/form
// stats (via tennisH2HBridge.ts -> tennisAbstractScraper.ts) into the
// stats table via Repository.upsertStats() for any match where both
// players are in the top-200 rankings.
//
// NOTE: this only STORES h2h/form data — nothing in probabilityModel.ts
// or tipScanner.ts reads tennis stats yet (those are still
// football-shaped). Wiring tennis into the actual scoring/probability
// model is a separate, not-yet-done step. This sync makes the data
// available for that later; it doesn't make tips smarter today.
//
// Syncs BOTH today's and tomorrow's fixture pages for match discovery.
// Today-only syncing has a same-day race condition for majors: matches
// flip from scheduled ("s" rows) to result ("r" rows) on
// tennisexplorer.com as soon as they start, and disappear from
// fetchTodaysFixtures() output entirely. Confirmed live on 2026-08-31:
// US Open block had 0 scheduled rows, 22 already-resulted rows, by the
// time a same-day sync was tested. Pre-fetching tomorrow's page
// (nothing on it can have started yet) closes that gap regardless of
// what time the sync actually runs.
//
// DEDUP FIX (2026-09-01): near midnight UTC, tennisexplorer.com's
// "today" and "tomorrow" pages aren't cleanly partitioned — matches
// starting near the day boundary can appear on BOTH listings with the
// same sourceMatchId. Since upsertMatch() dedupes only on
// (externalId, source) with no date component, syncing today then
// tomorrow back-to-back let the tomorrow fetch silently re-upsert the
// same real match with a startTime stamped one day later, overwriting
// the correct value. Confirmed live: 122 total matchesSaved across
// both fetches, only 73 distinct DB rows — 49 matches got overwritten
// with a wrong date. Fix: fetch both days' fixtures per tour first,
// dedupe by sourceMatchId BEFORE any upsert happens (keeping the
// today-sourced copy, which carries the correct date), then upsert
// only the deduped set.
//
// H2H BRIDGE (2026-09-01): tested and confirmed working against real
// top-ranked players (Sinner vs Zverev, correct name reordering, real
// 11-4 H2H record returned) — but only validated directly against
// rankings data, not yet proven against a live in-schedule match, since
// testing happened at 2am UTC when no ranked player had a fixture on
// the board. Coverage in production (what fraction of real fixtures
// have both players ranked top-200) is still unmeasured — expect low
// coverage outside majors/tour-level events, since most daily fixtures
// on tennisexplorer.com are qualifying/futures/UTR-level matches
// between unranked players (confirmed live: 0/31 same-night fixtures
// had a single ranked player in either draw).
//
// KNOWN LIMITATIONS (be aware of these before relying on this data):
//   1. No real date on the source page — tennisFixturesScraper.ts only
//      gives a bare "HH:MM" time (the schedule page has no date column
//      at the row level). buildStartTimeIso() attaches the correct
//      calendar date via dayOffset (0 = today's page, 1 = tomorrow's
//      page) rather than always using `now`'s date — a fixture pulled
//      from tomorrow's page but stamped with today's date would be
//      silently wrong otherwise.
//   2. Timezone unconfirmed — tennisexplorer.com's kickoff times are
//      treated as UTC for consistency with the rest of this pipeline,
//      same known limitation soccerstats.com's legacy parser already
//      has (see soccerStatsFallbackFixturesScraper.ts comments).
//   3. tennisH2HBridge's reorderToGivenSurname() assumes exactly two
//      words in the rankings name — confirmed against several live
//      examples, but not tested against a multi-part surname (e.g.
//      "Van De Zandschulp"). If H2H silently comes back empty for a
//      player with an obviously compound name, check that first.
//   4. H2H fetches run sequentially with a courtesy delay between them
//      (see H2H_FETCH_DELAY_MS below) — no confirmed rate-limit
//      tolerance for tennisabstract.com, this delay is a precaution,
//      not a value confirmed safe by testing against their actual
//      limits.

import { getDb } from '../core/database/db';
import { Repository } from '../core/database/repository';
import { logger } from '../core/utils/logger';
import {
  fetchTodaysFixtures,
  fetchTomorrowsFixtures,
  TennisFixture,
  TennisTour,
} from '../scrapers/tennis/tennisFixturesScraper';
import { fetchRankingsBySlug, PlayerRanking } from '../scrapers/tennis/tennisRankingsScraper';
import { fetchH2HForFixture } from './tennisH2HBridge';

export interface TennisSyncResult {
  tour: TennisTour;
  fixturesFound: number;
  matchesSaved: number;
  errors: number;
  h2hAttached: number;
  h2hSkippedUnranked: number;
}

// Delay between successive H2H fetches within a tour's batch — each
// H2H fetch already makes up to 2 requests to tennisabstract.com
// (player1 + player2 stats). This is a courtesy precaution, not a
// confirmed-safe value; tighten or loosen once real behavior against
// tennisabstract.com's actual limits (if any) is observed.
const H2H_FETCH_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildStartTimeIso(timeRaw: string, dayOffset: number = 0): string {
  // timeRaw is "HH:MM". dayOffset shifts the calendar date to match
  // which page the fixture actually came from (0 = today's page,
  // 1 = tomorrow's page) — see KNOWN LIMITATIONS above re: timezone
  // and the date-attachment gap this replaces.
  const [hourStr, minuteStr] = timeRaw.split(':');
  const hour = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10);

  const now = new Date();
  const startTime = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + dayOffset,
    hour,
    minute,
  ));

  return startTime.toISOString();
}

/**
 * Fetches and saves fixtures for a single tour, today only. Still
 * exported for any external caller that wants a single isolated fetch,
 * with no H2H attachment. NOT used internally by syncAllTennisFixtures()
 * — that function needs both days' fixtures gathered BEFORE any upsert
 * so it can dedupe cross-day duplicates first.
 */
export async function syncTennisTour(
  tour: TennisTour,
  fixtureFetcher: (tour: TennisTour) => Promise<TennisFixture[]> = fetchTodaysFixtures,
  dayOffset: number = 0,
): Promise<TennisSyncResult> {
  const fixtures = await fixtureFetcher(tour);
  return syncTennisTourFixtures(tour, fixtures, dayOffset, null);
}

/**
 * Saves an already-fetched fixture array for a tour, and — if a
 * rankingsBySlug map is supplied — attempts to attach H2H/form stats
 * for each match via tennisH2HBridge. Pass null for rankingsBySlug to
 * skip H2H entirely (fixtures-only sync).
 */
async function syncTennisTourFixtures(
  tour: TennisTour,
  fixtures: TennisFixture[],
  dayOffset: number,
  rankingsBySlug: Map<string, PlayerRanking> | null,
): Promise<TennisSyncResult> {
  const repo = new Repository(getDb());
  const result: TennisSyncResult = {
    tour,
    fixturesFound: fixtures.length,
    matchesSaved: 0,
    errors: 0,
    h2hAttached: 0,
    h2hSkippedUnranked: 0,
  };

  for (const fx of fixtures) {
    let matchId: string;
    try {
      matchId = repo.upsertMatch({
        sport: 'tennis',
        league: fx.tournament,
        homeTeam: fx.player1Name,
        awayTeam: fx.player2Name,
        startTime: buildStartTimeIso(fx.startTimeRaw, dayOffset),
        status: 'upcoming',
        externalId: `tennisexplorer-${fx.sourceMatchId}`,
        source: 'tennisexplorer',
      } as any); // see file header re: Match type not directly imported/confirmed
      result.matchesSaved++;
    } catch (err: any) {
      result.errors++;
      logger.warn('[TennisFixturesSync] Failed to save match', {
        match: `${fx.player1Name} vs ${fx.player2Name}`,
        tournament: fx.tournament,
        error: err.message,
      });
      continue; // no matchId to attach stats to
    }

    if (!rankingsBySlug) continue; // fixtures-only mode, no H2H attempted

    try {
      const h2hResult = await fetchH2HForFixture(fx, rankingsBySlug);

      if (h2hResult.skippedReason) {
        result.h2hSkippedUnranked++;
      } else if (h2hResult.h2h) {
        repo.upsertStats({
          matchId,
          sport: 'tennis',
          h2h: h2hResult.h2h.matches,
          homeForm: h2hResult.h2h.player1Stats.recentForm,
          awayForm: h2hResult.h2h.player2Stats.recentForm,
          referee: {},
          situational: {},
          additionalContext: {
            player1CareerWinPct: h2hResult.h2h.player1Stats.careerWinPct,
            player2CareerWinPct: h2hResult.h2h.player2Stats.careerWinPct,
            player1YtdWinPct: h2hResult.h2h.player1Stats.ytdWinPct,
            player2YtdWinPct: h2hResult.h2h.player2Stats.ytdWinPct,
            player1SurfaceBest: h2hResult.h2h.player1Stats.surfaceBest,
            player2SurfaceBest: h2hResult.h2h.player2Stats.surfaceBest,
            h2hWins: h2hResult.h2h.h2hWins,
            h2hTotal: h2hResult.h2h.h2hTotal,
          },
          confidenceFactors: { dataCompleteness: 1.0 },
        } as any); // see file header re: Stats type interop, same pattern as upsertMatch above
        result.h2hAttached++;
      }
      // h2hResult.h2h === null with no skippedReason means the H2H
      // fetch itself failed (network error, parse failure) rather than
      // being skipped for unranked players — logged already inside
      // tennisAbstractScraper.ts / tennisH2HBridge.ts, nothing further
      // to do here beyond not incrementing h2hAttached.
    } catch (err: any) {
      logger.warn('[TennisFixturesSync] H2H attach failed', {
        match: `${fx.player1Name} vs ${fx.player2Name}`,
        error: err.message,
      });
    }

    await sleep(H2H_FETCH_DELAY_MS);
  }

  logger.info(`[TennisFixturesSync] ${tour} complete`, result);
  return result;
}

/**
 * Fixtures-only sync (today + tomorrow, deduped) with no H2H attachment
 * — fast, no tennisabstract.com calls. Use syncAllTennisFixturesWithH2H()
 * below when stats are needed too.
 */
export async function syncAllTennisFixtures(): Promise<TennisSyncResult[]> {
  const results: TennisSyncResult[] = [];

  for (const tour of ['atp', 'wta'] as TennisTour[]) {
    const [todayFixtures, tomorrowFixtures] = await Promise.all([
      fetchTodaysFixtures(tour),
      fetchTomorrowsFixtures(tour),
    ]);

    const todayIds = new Set(todayFixtures.map(fx => fx.sourceMatchId));
    const dedupedTomorrow = tomorrowFixtures.filter(fx => !todayIds.has(fx.sourceMatchId));

    const droppedCount = tomorrowFixtures.length - dedupedTomorrow.length;
    if (droppedCount > 0) {
      logger.info(`[TennisFixturesSync] Deduped ${droppedCount} matches appearing on both today and tomorrow pages (${tour})`);
    }

    results.push(await syncTennisTourFixtures(tour, todayFixtures, 0, null));
    results.push(await syncTennisTourFixtures(tour, dedupedTomorrow, 1, null));
  }

  return results;
}

/**
 * Fixtures + H2H sync (today + tomorrow, deduped, with H2H/form stats
 * attached for every ranked-vs-ranked match). Slower than
 * syncAllTennisFixtures() — makes up to 2 tennisabstract.com requests
 * per ranked match, with a courtesy delay between each. Run this less
 * frequently than the fixtures-only sync if it ends up mattering for
 * request volume; nothing currently measures how often that's needed.
 */
export async function syncAllTennisFixturesWithH2H(): Promise<TennisSyncResult[]> {
  const results: TennisSyncResult[] = [];

  for (const tour of ['atp', 'wta'] as TennisTour[]) {
    const rankingsBySlug = await fetchRankingsBySlug(tour);

    const [todayFixtures, tomorrowFixtures] = await Promise.all([
      fetchTodaysFixtures(tour),
      fetchTomorrowsFixtures(tour),
    ]);

    const todayIds = new Set(todayFixtures.map(fx => fx.sourceMatchId));
    const dedupedTomorrow = tomorrowFixtures.filter(fx => !todayIds.has(fx.sourceMatchId));

    const droppedCount = tomorrowFixtures.length - dedupedTomorrow.length;
    if (droppedCount > 0) {
      logger.info(`[TennisFixturesSync] Deduped ${droppedCount} matches appearing on both today and tomorrow pages (${tour})`);
    }

    results.push(await syncTennisTourFixtures(tour, todayFixtures, 0, rankingsBySlug));
    results.push(await syncTennisTourFixtures(tour, dedupedTomorrow, 1, rankingsBySlug));
  }

  return results;
}