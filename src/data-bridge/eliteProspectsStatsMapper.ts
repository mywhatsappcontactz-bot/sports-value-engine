// src/data-bridge/eliteProspectsStatsMapper.ts
//
// Converts EliteProspects scraper output (EPGame/TeamFormEntry) into
// RawStats — mirrors proballersStatsMapper.ts's structure and reasoning
// exactly. See that file's header for the full explanation of why
// form/H2H come from SEPARATE game lists (current season only for form,
// multi-season for H2H) — same reasoning applies here unchanged.
//
// UNLIKE proballersStatsMapper.ts: sport is set to the REAL 'hockey'
// value, not reused from another sport. Hockey is already a fully
// recognized sport value throughout this codebase (probabilityModel.ts
// has a modelHockey() case, cleaner.ts normalizes hockey variants,
// discover-leagues.ts has it registered) — confirmed via grep before
// writing this, not assumed. No schema/type work was needed.
//
// FIELD MAPPING NOTE: goalsFor/goalsAgainst map directly from
// TeamFormEntry.scoreFor/scoreAgainst — hockey goals ARE goals, no
// repurposing-from-another-sport comment needed here (unlike Proballers'
// points-as-goalsFor reuse).
//
// referee/situational are REQUIRED (non-optional) RawStats fields even
// though hockey has no real data for either yet — same neutral
// placeholder approach as every other mapper in this codebase.

import {
  EPGame,
  buildTeamForm,
  averageGoals,
  headToHead,
  fatigueDays,
} from '../scrapers/hockey/eliteProspectsScraper';
import { RawStats } from './mockClient';

/**
 * Builds RawStats for one upcoming matchup.
 *
 * @param currentSeasonGames Completed games from THIS season only — used
 *   for form/goals-per-game/fatigue. Correctly thin or empty right after
 *   a new season starts; do not widen this to include prior seasons.
 * @param h2hHistoryGames Completed games spanning multiple seasons —
 *   used ONLY for head-to-head lookup between the two specific teams.
 * @param asOfDate ISO date — for fatigueDays calculation.
 */
export function eliteProspectsStatsToRawStats(
  externalMatchId: string,
  homeTeam: string,
  awayTeam: string,
  currentSeasonGames: EPGame[],
  h2hHistoryGames: EPGame[],
  asOfDate: string,
): RawStats {
  const homeForm = buildTeamForm(currentSeasonGames, homeTeam);
  const awayForm = buildTeamForm(currentSeasonGames, awayTeam);
  const meetings = headToHead(h2hHistoryGames, homeTeam, awayTeam);

  const homeGoalsFor = averageGoals(homeForm, 'scoreFor');
  const homeGoalsAgainst = averageGoals(homeForm, 'scoreAgainst');
  const awayGoalsFor = averageGoals(awayForm, 'scoreFor');
  const awayGoalsAgainst = averageGoals(awayForm, 'scoreAgainst');

  const homeFatigue = fatigueDays(homeForm, asOfDate);
  const awayFatigue = fatigueDays(awayForm, asOfDate);
  // Same convention as proballersStatsMapper.ts: the SHORTER rest period
  // is the meaningful one for a single fatigueDays number.
  const fatigueDaysValue = homeFatigue !== undefined && awayFatigue !== undefined
    ? Math.min(homeFatigue, awayFatigue)
    : 3; // neutral fallback

  const sampleSize = Math.min(homeForm.length, awayForm.length);
  const dataCompleteness = Math.min(1, 0.4 + sampleSize * 0.05); // same formula as proballersStatsMapper.ts

  return {
    externalMatchId,
    sport: 'hockey',
    confidenceFactors: { dataCompleteness },
    h2h: meetings.map(g => ({
      date: g.date,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      homeScore: g.homeScore ?? 0, // homeScore is number|null on EPGame; meetings are filtered to isCompleted in headToHead(), so this should always be a real number in practice — ?? 0 is a type-safety fallback, not expected to fire
      awayScore: g.awayScore ?? 0,
    })),
    homeForm: homeForm.map(entry => ({
      date: entry.date,
      opponent: entry.opponent,
      result: entry.result, // 'W' | 'L' — hockey has no ties (OT/SO decide it), so 'D' variant is correctly unused, same as basketball
      goalsFor: entry.scoreFor,
      goalsAgainst: entry.scoreAgainst,
      venue: entry.venue,
    })),
    awayForm: awayForm.map(entry => ({
      date: entry.date,
      opponent: entry.opponent,
      result: entry.result,
      goalsFor: entry.scoreFor,
      goalsAgainst: entry.scoreAgainst,
      venue: entry.venue,
    })),
    // Required by RawStats but no real data exists for hockey yet —
    // neutral placeholders, same as every other sport's mapper.
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
      homeGoalsFor,
      homeGoalsAgainst,
      awayGoalsFor,
      awayGoalsAgainst,
      // pace/possession-style metrics intentionally NOT set — no
      // equivalent data source yet, same gap as NBA/WNBA's pace and
      // Proballers' pace.
    },
  };
}