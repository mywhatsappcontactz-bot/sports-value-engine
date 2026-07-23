// src/data-bridge/dartsFetch.ts
//
// Darts fetch orchestration — kept SEPARATE from RealFetcher.fetchSport()
// because darts has no odds/API dependency at all. Tip-scanner-only,
// never value-bet.
//
// SOURCES (two, each for a different purpose):
//   - live-darts.com (liveDartsScraper.ts) — fixtures (who's playing whom)
//     AND completed match results (feeds H2H). Requires Puppeteer (real
//     bot protection on this site — confirmed plain fetch() gets HTTP 403
//     even with full browser headers).
//   - dartsdatabase.co.uk (dartsDatabaseScraper.ts) — player career/
//     current-year stats (averages, win%) via player-profile-live.php.
//     Unrelated to fixtures; this endpoint was always confirmed working.
//
// SCOPE THIS PASS: majors only (via getActiveMajor() +
// LIVE_DARTS_MAJOR_SLUGS). Only 'World Matchplay' has a CONFIRMED slug —
// see liveDartsScraper.ts for the rest, still unverified. Regular Tour
// events (Players Championship etc.) have no working fixture source yet
// — this will simply find no active major most of the time until more
// majors' slugs are confirmed the same way.
//
// Integrate into your CLI/scheduler as its own command (e.g.
// `scan.ts darts`) rather than folding into RealFetcher.fetchAll().

import { logger } from '../core/utils/logger';
import { fetchPlayerStats, DartsPlayerStats } from '../scrapers/darts/dartsDatabaseScraper';
import {
  fetchMajorFixtures,
  filterUpcoming,
  LiveDartsMatch,
} from '../scrapers/darts/liveDartsScraper';
import { recordEventResults, getH2H, getRecentForm, DartsH2HResult } from '../scrapers/darts/dartsMatchStore';
import { isMajorInSession, getActiveMajor, fetchMajorSummary, parseMajorMatches } from '../scrapers/darts/dartsWikipediaScraper';

// ─── PLAYER ID MAP ────────────────────────────────────────────────────────────
// Static lookup since dartsdatabase.co.uk's player search is JS-rendered
// and not scrapable. Add pids here as new players are encountered.
export const PLAYER_ID_MAP: Record<string, string> = {
  'gabriel clemens': '3097',
  // add more as encountered, e.g.:
  // 'luke littler': 'XXXX',
  // 'michael van gerwen': 'XXXX',
};

function lookupPid(playerName: string): string | null {
  const key = playerName.toLowerCase().trim();
  return PLAYER_ID_MAP[key] ?? null;
}

// ─── RESULT SHAPE ─────────────────────────────────────────────────────────────

export interface DartsFixtureWithContext {
  fixture:       LiveDartsMatch;
  player1Stats:  DartsPlayerStats | null;
  player2Stats:  DartsPlayerStats | null;
  h2h:           DartsH2HResult;
  majorActive:   boolean;
  majorName:     string | null;
}

export interface DartsFetchResult {
  fixturesFound:   number;
  fixturesWithStats: number;
  eventsRecorded:  number;
  majorInSession:  string | null;
  contexts:        DartsFixtureWithContext[];
  errors:          number;
}

// ─── MAIN ORCHESTRATION ───────────────────────────────────────────────────────

export async function fetchDartsFixturesAndStats(): Promise<DartsFetchResult> {
  const result: DartsFetchResult = {
    fixturesFound: 0,
    fixturesWithStats: 0,
    eventsRecorded: 0,
    majorInSession: null,
    contexts: [],
    errors: 0,
  };

  const activeMajor = getActiveMajor(new Date());
  result.majorInSession = activeMajor?.name ?? null;

  logger.info('[DartsFetch] Starting darts fetch', {
    majorInSession: result.majorInSession,
  });

  if (!activeMajor) {
    logger.info('[DartsFetch] No major tournament in session — nothing to fetch (regular Tour events not yet supported)');
    return result;
  }

  // ── 1. FIXTURES + COMPLETED MATCHES (both from one live-darts.com fetch) ──
  const allMatches = await fetchMajorFixtures(activeMajor.name);

  if (allMatches.length === 0) {
    logger.warn('[DartsFetch] No matches parsed for active major — slug may be unconfirmed/wrong, or Puppeteer fetch failed', {
      major: activeMajor.name,
    });
    return result;
  }

  const upcomingFixtures = filterUpcoming(allMatches);
  result.fixturesFound = upcomingFixtures.length;

  // ── 2. FEED COMPLETED MATCHES INTO MATCH HISTORY STORE (builds self-H2H) ──
  // Uses the tournament name + today's date as a stand-in event key since
  // live-darts.com's URL slug isn't a numeric eventId like dartsdatabase's —
  // recordEventResults just needs a stable, unique-per-event identifier.
  const completedMatches = allMatches.filter((m) => m.status === 'completed');
  if (completedMatches.length > 0) {
    const eventKey = `livedarts-${activeMajor.slug}`;
    const today = new Date().toISOString().split('T')[0];
    const added = recordEventResults(
      eventKey,
      activeMajor.name,
      today,
      completedMatches.map((m) => ({
        player1: m.player1,
        player2: m.player2,
        player1Avg: null, // live-darts.com's schedule page doesn't include averages, only legs
        player2Avg: null,
        player1Legs: m.player1Legs ?? 0,
        player2Legs: m.player2Legs ?? 0,
        round: m.round || null,
      })),
    );
    result.eventsRecorded = added;
  }

  // ── 3. PER-FIXTURE STATS + H2H ───────────────────────────────────────────
  for (const fixture of upcomingFixtures) {
    try {
      const pid1 = lookupPid(fixture.player1);
      const pid2 = lookupPid(fixture.player2);

      const player1Stats = pid1 ? await fetchPlayerStats(pid1) : null;
      const player2Stats = pid2 ? await fetchPlayerStats(pid2) : null;

      if (!player1Stats) {
        logger.warn('[DartsFetch] No pid mapped for player — add to PLAYER_ID_MAP', { player: fixture.player1 });
      }
      if (!player2Stats) {
        logger.warn('[DartsFetch] No pid mapped for player — add to PLAYER_ID_MAP', { player: fixture.player2 });
      }

      const h2h = getH2H(fixture.player1, fixture.player2);

      if (player1Stats || player2Stats) result.fixturesWithStats++;

      result.contexts.push({
        fixture,
        player1Stats,
        player2Stats,
        h2h,
        majorActive: true,
        majorName: activeMajor.name,
      });

    } catch (err: any) {
      result.errors++;
      logger.error('[DartsFetch] Failed to process fixture', {
        fixture: `${fixture.player1} vs ${fixture.player2}`,
        error: err.message,
      });
    }
  }

  // ── 4. MAJOR TOURNAMENT SUPPLEMENT (180s aggregate) ──────────────────────
  // Logged for visibility only — actual most_180s tip logic lives in
  // tipScanner.ts, gated the same way via isMajorInSession().
  try {
    const html = await fetchMajorSummary(activeMajor.slug);
    if (html) {
      const majorMatches = parseMajorMatches(html);
      logger.info('[DartsFetch] Wikipedia major data available', {
        tournament: activeMajor.name,
        matchesParsed: majorMatches.length,
      });
    }
  } catch (err: any) {
    logger.warn('[DartsFetch] Wikipedia major fetch failed — continuing without it', {
      tournament: activeMajor.name,
      error: err.message,
    });
  }

  logger.info('[DartsFetch] Fetch complete', {
    fixturesFound: result.fixturesFound,
    fixturesWithStats: result.fixturesWithStats,
    eventsRecorded: result.eventsRecorded,
    errors: result.errors,
  });

  return result;
}