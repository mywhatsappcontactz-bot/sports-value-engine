// src/data-bridge/proballersStatsMapper.ts
//
// Converts Proballers scraper output (ProballersGame/TeamFormEntry) into
// RawStats — the PRE-cleaning shape Cleaner.cleanStats() expects (see
// mockClient.ts's RawStats interface, confirmed via compiler error trace
// — same pattern mlbStatsMapper.ts follows for baseball).
//
// FIELD MAPPING NOTE: goalsFor/goalsAgainst (football-originated naming)
// already gets reused for points throughout this codebase's basketball
// paths — TeamFormEntry.pointsFor/pointsAgainst map directly onto them,
// same established convention as the NBA/WNBA mappers.
//
// referee/situational are REQUIRED (non-optional) fields on RawStats even
// though basketball has no real data for either — same problem baseball
// must solve. Using neutral placeholder values (0s, empty strings) rather
// than omitting them, since the type requires them present.
//
// FIX (2026-08-18): form and H2H now come from SEPARATE game lists, not
// one shared list. Root cause of a real bug: a brand-new season (e.g.
// ACB's 2026-27 season, which just started) has zero completed
// current-season games — correctly means "no real recent form exists
// yet" (matches the same reasoning behind scrape.ts's football
// FORM_RECENCY_WINDOW_DAYS fix: form must reflect THIS season, not be
// silently backfilled from an old one, or it's not real "recent form").
// But two specific teams may only meet 2-4 times a SEASON, so requiring
// 3+ H2H meetings from the current season alone could take most of a
// season to satisfy, or never be reachable for teams in different
// brackets/conferences — H2H is about how these two teams tend to match
// up, not a claim about current form, so looking back across multiple
// seasons for it is reasonable where doing the same for form is not.
// currentSeasonGames stays scoped to the current season only (unchanged
// behavior — will correctly be empty/thin right after a season starts).
// h2hHistoryGames is expected to span multiple seasons (built by the
// caller — see proballersFixturesSync.ts's H2H_LOOKBACK_SEASONS).

import {
  ProballersGame,
  buildTeamForm,
  averagePpg,
  headToHead,
  fatigueDays,
} from '../scrapers/basketball/Proballersscraper';
import { RawStats } from './mockClient';

/**
 * Builds RawStats for one upcoming matchup.
 *
 * @param currentSeasonGames Completed games from THIS season only — used
 *   for form/PPG/fatigue. Correctly thin or empty right after a new
 *   season starts; do not widen this to include prior seasons.
 * @param h2hHistoryGames Completed games spanning multiple seasons —
 *   used ONLY for head-to-head lookup between the two specific teams.
 * @param asOfDate ISO date — for fatigueDays calculation.
 */
export function proballersStatsToRawStats(
  externalMatchId: string,
  homeTeam: string,
  awayTeam: string,
  currentSeasonGames: ProballersGame[],
  h2hHistoryGames: ProballersGame[],
  asOfDate: string,
): RawStats {
  const homeForm = buildTeamForm(currentSeasonGames, homeTeam);
  const awayForm = buildTeamForm(currentSeasonGames, awayTeam);
  const meetings = headToHead(h2hHistoryGames, homeTeam, awayTeam);

  const homePpgFor = averagePpg(homeForm, 'pointsFor');
  const homePpgAgainst = averagePpg(homeForm, 'pointsAgainst');
  const awayPpgFor = averagePpg(awayForm, 'pointsFor');
  const awayPpgAgainst = averagePpg(awayForm, 'pointsAgainst');

  const homeFatigue = fatigueDays(homeForm, asOfDate);
  const awayFatigue = fatigueDays(awayForm, asOfDate);
  // RawStats.situational.fatigueDays is a single number, not per-side —
  // same convention modelBasketball() already reads (the SHORTER rest
  // period is the meaningful one — a team with fewer rest days is the
  // one potentially disadvantaged).
  const fatigueDaysValue = homeFatigue !== undefined && awayFatigue !== undefined
    ? Math.min(homeFatigue, awayFatigue)
    : 3; // neutral fallback

  const sampleSize = Math.min(homeForm.length, awayForm.length);
  const dataCompleteness = Math.min(1, 0.4 + sampleSize * 0.05); // 5+ games -> ~0.65, 10+ -> ~0.9

  return {
    externalMatchId,
    sport: 'basketball', // NOT a new sport value — see conversation for why (avoids the multi-file key-mismatch risk MLS hit)
    confidenceFactors: { dataCompleteness },
    h2h: meetings.map(g => ({
      date: g.date,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeScore: g.homeScore,
      awayScore: g.awayScore,
    })),
    homeForm: homeForm.map(entry => ({
      date: entry.date,
      opponent: entry.opponent,
      result: entry.result, // 'W' | 'L' — 'D' variant unused for basketball, fine
      goalsFor: entry.pointsFor,
      goalsAgainst: entry.pointsAgainst,
      venue: entry.venue,
    })),
    awayForm: awayForm.map(entry => ({
      date: entry.date,
      opponent: entry.opponent,
      result: entry.result,
      goalsFor: entry.pointsFor,
      goalsAgainst: entry.pointsAgainst,
      venue: entry.venue,
    })),
    // Required by RawStats but no real data exists for basketball —
    // neutral placeholders, same problem baseball's mapper must handle.
    referee: {
      name: '',
      avgYellowCards: 0,
      avgRedCards: 0,
      avgFouls: 0,
    },
    situational: {
      weather: '',
      temperature: 0,
      fatigueDays: fatigueDaysValue,
    },
    additionalContext: {
      homePpgFor,
      homePpgAgainst,
      awayPpgFor,
      awayPpgAgainst,
      // pace intentionally NOT set — same as NBA/WNBA's current gap
      // (realFetcher.ts comment confirms neither has real pace data
      // either), so this isn't a new limitation, just a consistent one.
    },
  };
}