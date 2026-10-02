import 'dotenv/config';
import { getDb } from '../../core/database/db';
import { logger } from '../../core/utils/logger';
import { Repository } from '../../core/database/repository';
import { fetchTeamResultsByName } from '../../scrapers/football/teamResultsScraper';
import { SOCCERSTATS_LEAGUE_MAP } from '../../scrapers/football/soccerStatsLeagueMap';
import { fetchFDCOH2H, FDCO_LEAGUE_MAP } from '../../scrapers/football/footballDataScraper';
import { syncAllFallbackLeagues } from '../../data-bridge/soccerStatsFallbackFixturesSync';
import { syncAllConfiguredLeagues } from '../../data-bridge/soccerStatsFixturesSync';
import { aggregateCornersForMatch } from '../../core/engine/cornersAggregator';
import { syncCardsSotForLeague } from '../../core/engine/cardsSotSync';
import { aggregateCardsForMatch, aggregateSotForMatch } from '../../core/engine/cardssotaggregator';
import { Cleaner } from '../../data-bridge/cleaner';
import { FormRecord } from '../../core/database/schema';
import { v4 as uuidv4 } from 'uuid';

// FCStats (fcStatsScraper.ts) was the original source here — confirmed
// Cloudflare-blocked as of 2026-08-03, still blocked as of this rewrite
// (2026-08-04). Replaced entirely with soccerstats.com via
// teamResultsScraper.ts, which was already built and confirmed working
// in an earlier session today (see soccerStatsTeamSlugs.ts's period-in-
// slug fix, teamResultsScraper.ts's wrong-team-page safety check).
//
// This is a straight swap of the DATA SOURCE, not a redesign — the
// downstream shape (rawStats, stats table columns, dataCompleteness
// scoring) stays the same as before, except:
//   1. homeGoalsAvg/awayGoalsAvg now derived from recent-form goalsFor,
//      matching the convention realFetcher.ts already uses for its own
//      soccerstats-fallback path (footballStatsToRawStats) — NOT via
//      goalsAggregator.ts's season-aggregate approach, to stay
//      consistent with whichever pipeline last touched a given match's
//      stats.
//   2. Corners aggregation is now called here — this file never called
//      aggregateCornersForMatch before, only realFetcher.ts did. Since
//      scrape.ts is the actually-scheduled job (realFetcher.ts is not),
//      corners tips would never have populated without this addition.
//   3. Cards/SOT aggregation added (see conversation, 2026-09-24) —
//      same reasoning as corners: syncCardsSotForLeague/
//      aggregateCardsForMatch/aggregateSotForMatch existed but were
//      called from nowhere in the actually-scheduled job. Only covers
//      the 7 leagues present in TEAM_FBREF_IDS (fbrefCardsSotScraper.ts)
//      — see LEAGUE_NAME_TO_CARDS_SOT_KEY below for the real, confirmed
//      mapping between this file's league names and that file's keys.
//      Called ONCE PER LEAGUE (not per match) before the per-match loop
//      starts, since syncCardsSotForLeague is a heavy ~2-minute/~32-
//      request batch fetch of every team in a league — calling it per
//      match would re-fetch the same league's full data on every single
//      fixture, which would be catastrophically wasteful.
//
// FIX (2026-08-18): homeForm/awayForm are now filtered to only include
// results within the last FORM_RECENCY_WINDOW_DAYS days. Root cause of
// a real bug: soccerstats.com's teamstats.asp page returns a team's most
// recent match results with NO season-boundary awareness — at the very
// start of a new season, a team's page can still be dominated by (or
// entirely made of) LAST season's games. tipScanner.ts's MIN_GAMES_PLAYED
// gate only checks homeForm.length, not how recent those games actually
// are, so a team with plenty of old-season history but zero real games
// this season was sailing straight through that gate (confirmed live:
// Spain, day 1 of the new season, still generating confident tips off
// last season's form). A rolling window was chosen over a per-league
// season-start-date table because it needs no yearly maintenance and
// self-corrects as each new season fills in real recent games — it
// naturally converges on "this season's form" without ever having to
// know when a season officially started.

const cleaner = new Cleaner();
const db = getDb();
const repository = new Repository(db);

const FOOTBALL_LEAGUES = Object.keys(SOCCERSTATS_LEAGUE_MAP);

// Maps this file's league display names (SOCCERSTATS_LEAGUE_MAP keys) to
// fbrefCardsSotScraper.ts's TEAM_FBREF_IDS/DOMESTIC_LEAGUE_COMP_NAMES
// keys. CONFIRMED real values on both sides via direct grep (see
// conversation, 2026-09-24) — NOT assumed identical to the different
// naming convention used elsewhere in this project (e.g. the isotonic
// fit scripts' FOOTBALL_DATA_LEAGUE_MAP uses 'Netherlands - Eredivisie'
// and has no Portugal entry at all — genuinely different strings from
// this file's 'Dutch Eredivisie' / 'Portugal - Liga Portugal').
// Leagues absent from this map (Championship, League 1/2, Scotland,
// Sweden, Norway, etc.) have no FBref cards/SOT coverage and are
// correctly skipped — TEAM_FBREF_IDS only has 7 leagues.
const LEAGUE_NAME_TO_CARDS_SOT_KEY: Record<string, string> = {
  'EPL': 'EPL',
  'La Liga - Spain': 'LA_LIGA',
  'Bundesliga - Germany': 'BUNDESLIGA',
  'Serie A - Italy': 'SERIE_A',
  'Ligue 1 - France': 'LIGUE_1',
  'Dutch Eredivisie': 'EREDIVISIE',
  'Portugal - Liga Portugal': 'PRIMEIRA_LIGA',
};

// TODO: derive dynamically once a real season-detection convention
// exists elsewhere in this codebase — hardcoded for now, matching the
// season string confirmed working against real FBref table ids earlier
// today (results2026-2027..._overall).
const CARDS_SOT_SEASON = '2026-2027';

// Politeness delay between individual soccerstats.com requests. Chosen to
// be gentle given teamResultsScraper.ts has NO caching of its own (unlike
// the slug lookup, which soccerStatsTeamSlugs.ts caches for 24h) — every
// team fetch here is a live request, every run. Combined with running
// this job twice a week instead of every 30 minutes (the old FCStats
// cadence), this keeps total request volume low.
const REQUEST_DELAY_MS = 1500;
const LEAGUE_DELAY_MS = 3000;

// How far back a result can be and still count as "current form". 60
// days comfortably covers a normal in-season gap between matches (even
// with international breaks/postponements) while reliably excluding a
// prior season's tail-end games once a new season has genuinely started
// — most leagues have at least a 60-day gap between a season ending and
// the next one beginning. Not backtested/tuned against real data the way
// MIN_TIP_CONFIDENCE thresholds were — a reasoned default, revisit if a
// league with an unusually short off-season slips through.
const FORM_RECENCY_WINDOW_DAYS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Filters a FormRecord[] down to only results within
// FORM_RECENCY_WINDOW_DAYS of now. Records with an unparseable date are
// dropped rather than kept — an unknown date can't be verified as recent,
// and silently keeping it would reopen the exact bug this filter exists
// to close.
function filterToRecentForm(records: FormRecord[]): FormRecord[] {
  const cutoff = Date.now() - FORM_RECENCY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return records.filter(r => {
    const t = new Date(r.date).getTime();
    return !isNaN(t) && t >= cutoff;
  });
}

// Per-run cache — many teams appear in multiple upcoming fixtures within
// the same scan window (e.g. a team with 2 matches in the lookahead
// period). Without this, each appearance would trigger its own live
// fetch of the same team's results. Deliberately NOT persisted to disk —
// results genuinely change match-to-match as new games are played, and
// this job is already only run twice a week, so an in-memory-only cache
// scoped to a single run is the right lifetime for it.
const teamResultsCache = new Map<string, FormRecord[]>();

async function getTeamResultsCached(leagueCode: string, teamName: string): Promise<FormRecord[]> {
  const key = `${leagueCode}:${teamName}`;
  if (teamResultsCache.has(key)) {
    return teamResultsCache.get(key)!;
  }
  const results = await fetchTeamResultsByName(leagueCode, teamName);
  teamResultsCache.set(key, results);
  await sleep(REQUEST_DELAY_MS);
  return results;
}

async function scrapeFootball(): Promise<void> {
  // FBref FIRST: the cf_clearance cookie only lasts ~30-45 min, so all FBref
  // requests run up front, before the slow fixture syncs and soccerstats
  // fetches. Results are cached here and reused by the per-league loop below.
  const prefetchedCardsSot = new Map<string, Awaited<ReturnType<typeof syncCardsSotForLeague>>>();
  for (const key of Object.values(LEAGUE_NAME_TO_CARDS_SOT_KEY)) {
    try {
      logger.info('[Scrape] Prefetching cards/SOT (FBref first)', { key });
      prefetchedCardsSot.set(key, await syncCardsSotForLeague(CARDS_SOT_SEASON, key));
    } catch (err: any) {
      logger.warn('[Scrape] Cards/SOT prefetch failed', { key, error: err.message });
    }
  }

  // Populate/refresh the matches table BEFORE processing any league —
  // scrape.ts previously assumed matches already existed, which they
  // didn't on a fresh run (see conversation, 2026-09-25: every league
  // showed "Processing 0 matches"). Reuses the exact same fixtures-sync
  // functions Tips.ts already calls, wrapped the same defensive way —
  // one source failing shouldn't block the other or the rest of the run.
  try {
    logger.info('[Scrape] Syncing fallback fixtures...');
    await syncAllFallbackLeagues();
  } catch (err: any) {
    logger.warn('[Scrape] Fallback fixtures sync failed — continuing with whatever matches already exist', { error: err.message });
  }

  try {
    logger.info('[Scrape] Syncing configured (gap) fixtures...');
    await syncAllConfiguredLeagues();
  } catch (err: any) {
    logger.warn('[Scrape] Configured fixtures sync failed — continuing with whatever matches already exist', { error: err.message });
  }

  let totalStatsSaved = 0;
  let totalCornersSaved = 0;
  let totalCardsSaved = 0;
  let totalSotSaved = 0;
  let totalFailed = 0;
  let totalH2HFound = 0;

  for (const leagueName of FOOTBALL_LEAGUES) {
    const soccerStatsCode = SOCCERSTATS_LEAGUE_MAP[leagueName];
    logger.info(`[Scrape] Fetching league stats via soccerstats.com`, { leagueName, soccerStatsCode });

    // FDCO only covers a subset of leagues (see FDCO_LEAGUE_MAP) — check
    // once per league rather than per match to avoid a wasted lookup on
    // every single fixture in leagues FDCO doesn't cover.
    const hasFDCOSource = !!FDCO_LEAGUE_MAP[leagueName];

    // Cards/SOT: fetched ONCE per league here, before the per-match loop
    // — see file header for why this can't be called per-match. null
    // when this league has no FBref coverage (most leagues) or the sync
    // itself fails; either way, the per-match loop below just skips
    // cards/SOT for this league entirely rather than failing the whole
    // league's run.
    const cardsSotLeagueKey = LEAGUE_NAME_TO_CARDS_SOT_KEY[leagueName];
    let cardsSotLeagueData: Awaited<ReturnType<typeof syncCardsSotForLeague>> = null;
    if (cardsSotLeagueKey) {
      try {
        logger.info(`[Scrape] Syncing cards/SOT for league`, { leagueName, cardsSotLeagueKey });
        cardsSotLeagueData = prefetchedCardsSot.get(cardsSotLeagueKey) ?? null;
        if (!cardsSotLeagueData) {
          logger.warn(`[Scrape] Cards/SOT sync returned no usable data — continuing without cards/SOT for this league`, { leagueName });
        }
      } catch (cardsSotSyncErr: any) {
        logger.warn(`[Scrape] Cards/SOT sync failed for league — continuing without cards/SOT`, {
          leagueName,
          error: cardsSotSyncErr.message,
        });
      }
    }

    const matches = db.prepare(`
      SELECT id, homeTeam, awayTeam, externalId
      FROM matches
      WHERE sport = 'football'
      AND league = ?
      AND status = 'upcoming'
    `).all(leagueName) as { id: string; homeTeam: string; awayTeam: string; externalId: string }[];

    logger.info(`[Scrape] Processing ${matches.length} matches for ${leagueName}`);

    for (const match of matches) {
      try {
        const homeResults = await getTeamResultsCached(soccerStatsCode, match.homeTeam);
        const awayResults = await getTeamResultsCached(soccerStatsCode, match.awayTeam);

        if (!homeResults.length || !awayResults.length) {
          logger.warn(`[Scrape] No soccerstats.com results for one or both teams`, {
            home:        match.homeTeam,
            away:        match.awayTeam,
            homeFound:   homeResults.length > 0,
            awayFound:   awayResults.length > 0,
          });
          continue;
        }

        // Same shape teamResultsScraper.ts / FCStats both used —
        // opponent, result, goalsFor, goalsAgainst, venue, date. Filtered
        // to FORM_RECENCY_WINDOW_DAYS — see fix comment at top of file.
        const homeForm = filterToRecentForm(homeResults.map(r => ({
          date:         r.date,
          opponent:     r.opponent,
          result:       r.result,
          goalsFor:     r.goalsFor,
          goalsAgainst: r.goalsAgainst,
          venue:        r.venue,
        })));

        const awayForm = filterToRecentForm(awayResults.map(r => ({
          date:         r.date,
          opponent:     r.opponent,
          result:       r.result,
          goalsFor:     r.goalsFor,
          goalsAgainst: r.goalsAgainst,
          venue:        r.venue,
        })));

        if (homeForm.length < homeResults.length || awayForm.length < awayResults.length) {
          logger.info(`[Scrape] Filtered out stale (>${FORM_RECENCY_WINDOW_DAYS}d) form results`, {
            match: `${match.homeTeam} vs ${match.awayTeam}`,
            homeRaw: homeResults.length, homeRecent: homeForm.length,
            awayRaw: awayResults.length, awayRecent: awayForm.length,
          });
        }

        // Derived from recent-form goalsFor — matches realFetcher.ts's
        // footballStatsToRawStats convention for its soccerstats
        // fallback path, so a match's stats look the same regardless of
        // which pipeline last touched it. Now correctly based on the
        // recency-filtered arrays, not raw ones.
        const homeGoalsAvg = homeForm.length > 0
          ? parseFloat((homeForm.reduce((s, r) => s + (r.goalsFor ?? 0), 0) / homeForm.length).toFixed(2))
          : 0;
        const awayGoalsAvg = awayForm.length > 0
          ? parseFloat((awayForm.reduce((s, r) => s + (r.goalsFor ?? 0), 0) / awayForm.length).toFixed(2))
          : 0;

        // ── H2H via FDCO ──────────────────────────────────────────────
        let h2h: { date: string; homeTeam: string; awayTeam: string; homeScore: number; awayScore: number }[] = [];

        if (hasFDCOSource) {
          try {
            const h2hStats = await fetchFDCOH2H(match.homeTeam, match.awayTeam, leagueName);
            if (h2hStats && h2hStats.recentMatches.length > 0) {
              h2h = h2hStats.recentMatches;
              totalH2HFound++;
            }
          } catch (h2hErr: any) {
            logger.warn(`[Scrape] FDCO H2H lookup failed`, {
              match: `${match.homeTeam} vs ${match.awayTeam}`,
              error: h2hErr.message,
            });
          }
        }

        const hasForm  = homeForm.length >= 3 && awayForm.length >= 3;
        const hasGoals = homeGoalsAvg > 0 && awayGoalsAvg > 0;
        const hasH2H   = h2h.length >= 3;
        const completeness = [hasForm, hasGoals, hasH2H].filter(Boolean).length / 3;

        const rawStats = {
          externalMatchId: match.externalId,
          sport:           'football',
          homeGoalsAvg,
          awayGoalsAvg,
          h2h,
          homeForm,
          awayForm,
          referee: {
            name:           '',
            avgYellowCards: 0,
            avgRedCards:    0,
            avgFouls:       0,
          },
          situational: {
            weather:     'unknown',
            temperature: 15,
            fatigueDays: 5,
            surfaceType: 'grass',
          },
          confidenceFactors: {
            dataCompleteness: parseFloat(completeness.toFixed(2)),
          },
          additionalContext: {
            source:       'soccerstats',
            homeGoalsAvg,
            awayGoalsAvg,
          },
        };

        const cleanedStats = cleaner.cleanStats(rawStats, match.id, 'football');
        if (!cleanedStats) {
          logger.warn(`[Scrape] Stats cleaning failed`, { match: `${match.homeTeam} vs ${match.awayTeam}` });
          continue;
        }

        db.prepare(`
          INSERT INTO stats (
            id, matchId, sport, h2h, homeForm, awayForm,
            referee, situational, additionalContext, confidenceFactors, lastUpdated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(matchId) DO UPDATE SET
            h2h               = excluded.h2h,
            homeForm          = excluded.homeForm,
            awayForm          = excluded.awayForm,
            additionalContext = excluded.additionalContext,
            confidenceFactors = excluded.confidenceFactors,
            lastUpdated       = datetime('now')
        `).run(
          uuidv4(),
          match.id,
          'football',
          JSON.stringify(cleanedStats.h2h),
          JSON.stringify(cleanedStats.homeForm),
          JSON.stringify(cleanedStats.awayForm),
          JSON.stringify(cleanedStats.referee),
          JSON.stringify(cleanedStats.situational),
          JSON.stringify({ ...cleanedStats.additionalContext, homeGoalsAvg, awayGoalsAvg }),
          JSON.stringify(cleanedStats.confidenceFactors),
        );

        totalStatsSaved++;
        logger.info(`[Scrape] Stats saved`, {
          match:       `${match.homeTeam} vs ${match.awayTeam}`,
          homeGoalsAvg,
          awayGoalsAvg,
          formCount:   homeForm.length,
          h2hCount:    h2h.length,
          completeness,
        });

        // ── Corners aggregation ─────────────────────────────────────
        // Previously ABSENT from this file entirely — only
        // realFetcher.ts called this. Since scrape.ts is the job that's
        // actually scheduled, corners tips would never populate without
        // this. Wrapped in try/catch so a corners failure never takes
        // down the goals stats that already saved successfully above —
        // same pattern realFetcher.ts already uses for this exact call.
        try {
          const cornersResult = await aggregateCornersForMatch(
            repository,
            match.id,
            leagueName,
            match.homeTeam,
            match.awayTeam,
          );
          if (cornersResult) totalCornersSaved++;
        } catch (cornersErr: any) {
          logger.warn(`[Scrape] Corners aggregation failed — continuing without corners data`, {
            match: `${match.homeTeam} vs ${match.awayTeam}`,
            error: cornersErr.message,
          });
        }

        // ── Cards/SOT aggregation ────────────────────────────────────
        // NEW (see conversation, 2026-09-24) — previously the whole
        // cards/SOT pipeline (scraper → season-totals → aggregator →
        // sync) was built but called from nowhere. Only runs when this
        // match's league had usable cardsSotLeagueData synced above
        // (7-league FBref coverage, see LEAGUE_NAME_TO_CARDS_SOT_KEY).
        // Wrapped in try/catch, same pattern as corners — a cards/SOT
        // failure on one match must never take down goals/corners data
        // that already saved successfully.
        if (cardsSotLeagueData) {
          try {
            const cardsResult = await aggregateCardsForMatch(
              repository,
              cardsSotLeagueData.cardData,
              match.id,
              leagueName,
              match.homeTeam,
              match.awayTeam,
            );
            if (cardsResult) totalCardsSaved++;

            const sotResult = await aggregateSotForMatch(
              repository,
              cardsSotLeagueData.sotData,
              match.id,
              leagueName,
              match.homeTeam,
              match.awayTeam,
            );
            if (sotResult) totalSotSaved++;
          } catch (cardsSotErr: any) {
            logger.warn(`[Scrape] Cards/SOT aggregation failed — continuing without cards/SOT data`, {
              match: `${match.homeTeam} vs ${match.awayTeam}`,
              error: cardsSotErr.message,
            });
          }
        }

      } catch (err: any) {
        totalFailed++;
        logger.error(`[Scrape] Match failed`, {
          match: `${match.homeTeam} vs ${match.awayTeam}`,
          error: err.message,
        });
      }
    }

    await sleep(LEAGUE_DELAY_MS);
  }

  logger.info(`[Scrape] Complete`, { totalStatsSaved, totalCornersSaved, totalCardsSaved, totalSotSaved, totalFailed, totalH2HFound });
  console.log(`\nScrape complete — stats saved: ${totalStatsSaved}, corners saved: ${totalCornersSaved}, cards saved: ${totalCardsSaved}, SOT saved: ${totalSotSaved}, failed: ${totalFailed}, matches with H2H: ${totalH2HFound}`);
}

const sport = process.argv[2] || 'football';
if (sport === 'football') {
  scrapeFootball()
    .catch(console.error);
} else {
  // Only football is wired up in this file — basketball/tennis/hockey
  // stats currently only flow through realFetcher.ts, which is a
  // separate pipeline. If that pipeline isn't also scheduled somewhere,
  // those sports aren't getting fresh stats at all right now — worth
  // checking separately from this football-specific fix.
  console.log(`Sport ${sport} not yet supported for scraping`);
}