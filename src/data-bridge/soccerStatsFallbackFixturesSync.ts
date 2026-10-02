// src/data-bridge/soccerStatsFallbackFixturesSync.ts
//
// For each of the 24 oddsClient leagues, fetches fixtures from
// soccerstats.com and creates a `matches` row ONLY if no existing row
// (from ANY source) already represents the same real fixture — checked
// by fuzzy team-name match + same-day date, not by league label or
// exact string equality, since oddsClient's match.league and team name
// spelling may differ from soccerstats.com's.
//
// This is deliberately a FALLBACK, not a parallel permanent source:
// - If oddsClient already ran and created a match for this fixture,
//   skip — the real odds-sourced row stays authoritative (value bets
//   need it; tips can use it too).
// - If oddsClient hasn't run (API exhausted, SportsScan disabled,
//   pre-season, etc.), this fills the gap so tipScanner.ts still has
//   a fixture to work with.
//
// FIXED (round 1): originally created matches with NO stats row at all.
// Now fetches form data via teamResultsScraper.ts after creating each
// match.
//
// FIXED (round 2): the round-1 fix only ran for NEWLY created matches —
// a duplicate match (already existing from an earlier run, before this
// fix, or from any other source) was skipped entirely, stats and all.
// Confirmed via real scan: 47 matches existed, but almost all were
// "skippedAsDuplicate" with statsPopulated staying 0 for them. Now
// checks whether an existing match ALSO lacks a stats row, and
// backfills it if so — instead of treating "duplicate fixture" and
// "already has stats" as the same condition.

import { getDb } from '../core/database/db';
import { Repository } from '../core/database/repository';
import { logger } from '../core/utils/logger';
import {
  fetchFallbackFixtures,
  FALLBACK_LEAGUE_MAP,
} from '../scrapers/football/soccerStatsFallbackFixturesScraper';
import { fetchTeamResultsByName } from '../scrapers/football/teamResultsScraper';
import { fetchFDCOH2H } from '../scrapers/football/footballDataScraper';
import { aggregateCornersForMatch } from '../core/engine/cornersAggregator';

// ─── FUZZY TEAM MATCH (same approach as soccerStatsCornersScraper.ts's fixed
// similarity() — generic words stripped to avoid false matches/misses on
// common name fragments) ─────────────────────────────────────────────────

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

const GENERIC_TEAM_WORDS = new Set([
  'city', 'united', 'fc', 'afc', 'town', 'rovers', 'athletic', 'albion',
  'wanderers', 'county', 'hotspur', 'academy', 'sporting', 'real', 'club',
  'deportivo', 'cf',
]);

function teamNamesLikelyMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;

  const strip = (s: string) => s.split(' ').filter((t) => !GENERIC_TEAM_WORDS.has(t));
  const ta = new Set(strip(na));
  const tb = new Set(strip(nb));
  if (ta.size === 0 || tb.size === 0) return false;

  const intersection = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return intersection / union >= 0.5;
}

// Checks whether ANY existing match (any source) already represents this
// same real fixture — same calendar day, both team names fuzzy-matching.
// Returns the matchId if found, so callers can check/backfill its stats.
function findExistingMatch(
  db: ReturnType<typeof getDb>,
  homeTeam: string,
  awayTeam: string,
  dateISO: string,
): string | null {
  const dayStart = dateISO.split('T')[0];

  const candidates = db.prepare(`
    SELECT id, homeTeam, awayTeam FROM matches
    WHERE sport = 'football'
    AND date(startTime) = date(?)
  `).all(dayStart) as { id: string; homeTeam: string; awayTeam: string }[];

  const match = candidates.find(
    (c) =>
      (teamNamesLikelyMatch(c.homeTeam, homeTeam) && teamNamesLikelyMatch(c.awayTeam, awayTeam)) ||
      (teamNamesLikelyMatch(c.homeTeam, awayTeam) && teamNamesLikelyMatch(c.awayTeam, homeTeam)),
  );

  return match ? match.id : null;
}

export interface FallbackSyncResult {
  leagueCode: string;
  fixturesFound: number;
  matchesCreated: number;
  skippedAsDuplicate: number;
  statsPopulated: number;
  statsBackfilled: number;
  errors: number;
}

export async function syncFallbackFixturesForLeague(leagueName: string): Promise<FallbackSyncResult> {
  const result: FallbackSyncResult = {
    leagueCode: '',
    fixturesFound: 0,
    matchesCreated: 0,
    skippedAsDuplicate: 0,
    statsPopulated: 0,
    statsBackfilled: 0,
    errors: 0,
  };

  const leagueCode = FALLBACK_LEAGUE_MAP[leagueName];
  if (!leagueCode) {
    logger.warn('[FallbackSync] Unknown league name — not in FALLBACK_LEAGUE_MAP', { leagueName });
    return result;
  }
  result.leagueCode = leagueCode;

  const db = getDb();
  const repo = new Repository(db);

  const fixtures = await fetchFallbackFixtures(leagueCode);
  result.fixturesFound = fixtures.length;

  for (const fixture of fixtures) {
    try {
      const existingMatchId = findExistingMatch(db, fixture.homeTeam, fixture.awayTeam, fixture.startTime);
      let matchId: string;
      let isBackfill = false;

      if (existingMatchId) {
        result.skippedAsDuplicate++;
        matchId = existingMatchId;

        // Match already exists — but may still be missing stats (created
        // before this fix, or by a pipeline that doesn't populate stats).
        // Check and backfill instead of skipping entirely.
        const hasStats = db.prepare(`SELECT id FROM stats WHERE matchId = ?`).get(matchId);
        if (hasStats) continue; // already has stats — nothing to do
        isBackfill = true;
      } else {
        matchId = repo.upsertMatch({
          sport: 'football',
          league: leagueName,
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          startTime: fixture.startTime,
          status: 'upcoming',
          externalId: fixture.sourceMatchId,
          source: 'soccerstats-fallback',
        });
        result.matchesCreated++;
      }

      // ── STATS: form data via soccerstats.com, same source as fixtures ──
      // Runs for both newly created matches AND existing matches found
      // to be missing stats.
      try {
        const [homeResults, awayResults] = await Promise.all([
          fetchTeamResultsByName(leagueCode, fixture.homeTeam),
          fetchTeamResultsByName(leagueCode, fixture.awayTeam),
        ]);

        if (homeResults.length && awayResults.length) {
          const h2h = await fetchFDCOH2H(fixture.homeTeam, fixture.awayTeam, leagueName);

          const homeGoalsAvg = homeResults.reduce((s, r) => s + (r.goalsFor ?? 0), 0) / homeResults.length;
          const awayGoalsAvg = awayResults.reduce((s, r) => s + (r.goalsFor ?? 0), 0) / awayResults.length;

          repo.upsertStats({
            matchId,
            sport: 'football',
            h2h: h2h ? h2h.recentMatches.map(m => ({
              date: m.date,
              homeTeam: m.homeTeam,
              awayTeam: m.awayTeam,
              homeScore: m.homeScore,
              awayScore: m.awayScore,
              winner: (m.homeScore > m.awayScore ? 'home' : m.homeScore < m.awayScore ? 'away' : 'draw') as 'home' | 'away' | 'draw',
            })) : [],
            homeForm: homeResults,
            awayForm: awayResults,
            referee: {},
            situational: {},
            additionalContext: { homeGoalsAvg, awayGoalsAvg },
            confidenceFactors: {
              dataCompleteness: h2h ? 0.65 : 0.5,
              h2hSampleSize: h2h?.recentMatches.length ?? 0,
              formSampleSize: homeResults.length,
            },
          });

          if (isBackfill) result.statsBackfilled++;
          else result.statsPopulated++;

          // Corners aggregation — only meaningful for leagues also in
          // SOCCERSTATS_LEAGUE_MAP (a separate, smaller map used inside
          // cornersAggregator.ts). Leagues outside that map (e.g. Brazil
          // Serie A/B, confirmed via real scan) will log a warning and
          // no-op here — expected, not an error.
          try {
            await aggregateCornersForMatch(repo, matchId, leagueName, fixture.homeTeam, fixture.awayTeam);
          } catch (cornersErr: any) {
            logger.warn('[FallbackSync] Corners aggregation failed', {
              match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
              error: cornersErr.message,
            });
          }
        } else {
          logger.debug('[FallbackSync] No form data found for one or both teams — match created without stats', {
            match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
            leagueCode,
            homeResults: homeResults.length,
            awayResults: awayResults.length,
          });
        }
      } catch (statsErr: any) {
        logger.warn('[FallbackSync] Stats fetch failed — match created without stats', {
          match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
          error: statsErr.message,
        });
      }

    } catch (err: any) {
      result.errors++;
      logger.error('[FallbackSync] Failed to sync fixture', {
        leagueName,
        match: `${fixture.homeTeam} vs ${fixture.awayTeam}`,
        error: err.message,
      });
    }
  }

  logger.info('[FallbackSync] Complete', result);
  return result;
}

export async function syncAllFallbackLeagues(): Promise<FallbackSyncResult[]> {
  const results: FallbackSyncResult[] = [];
  for (const leagueName of Object.keys(FALLBACK_LEAGUE_MAP)) {
    const result = await syncFallbackFixturesForLeague(leagueName);
    results.push(result);
    await new Promise((r) => setTimeout(r, 2000)); // be polite to soccerstats.com
  }
  return results;
}