// src/data-bridge/nflStatsMapper.ts
//
// Converts nflModel.ts's TeamGameRecord history into RawStats — the
// pre-cleaning shape Cleaner.cleanStats() expects (same RawStats
// interface used by proballersStatsMapper.ts / mlbStatsMapper.ts).
//
// KEY DESIGN POINT: NFL's actual predictive signal (yards/play, turnover
// rate) has no natural home in RawStats.homeForm/awayForm (those only
// carry goalsFor/goalsAgainst — a football/basketball points convention).
// Same pattern as basketball's PPG: the computed numbers go into
// additionalContext instead, and modelNfl() (to be added to
// probabilityModel.ts) reads them from there.
//
// Reuses nflModel.ts's exported computeTeamStrengthFactor() directly —
// does NOT reimplement the yardage/turnover formula. One source of
// truth, avoiding the class of bug that caused the basketball home-court
// centering issue earlier tonight (two copies of the same math drifting
// apart).

import { RawStats } from './mockClient';
import {
  TeamGameRecord,
  LeagueAverages,
  computeTeamStrengthFactor,
  MIN_PRIOR_GAMES,
  FORM_LOOKBACK,
} from '../core/engine/nflModel';

/**
 * Builds RawStats for one upcoming NFL matchup, given each team's
 * pre-computed game-record history (already fetched by the sync job —
 * passed in, not re-fetched here, same "fetch once" discipline as every
 * other sync job tonight).
 */
export function nflStatsToRawStats(
  externalMatchId: string,
  homeTeam: string,
  awayTeam: string,
  fullHistory: Map<string, TeamGameRecord[]>,
  leagueAvg: LeagueAverages,
): RawStats | null {
  const homeRecords = (fullHistory.get(homeTeam) ?? []).slice(-FORM_LOOKBACK);
  const awayRecords = (fullHistory.get(awayTeam) ?? []).slice(-FORM_LOOKBACK);

  // Not enough data for either team — same MIN_PRIOR_GAMES gate the
  // model itself uses, so the sync job and the model agree on what
  // counts as "enough history" rather than silently disagreeing.
  if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) {
    return null;
  }

  const homeStrengthFactor = computeTeamStrengthFactor(homeRecords, leagueAvg);
  const awayStrengthFactor = computeTeamStrengthFactor(awayRecords, leagueAvg);

  const homeAvgYardsPerPlay = average(homeRecords.map(r => r.yardsPerPlay));
  const awayAvgYardsPerPlay = average(awayRecords.map(r => r.yardsPerPlay));

  const sampleSize = Math.min(homeRecords.length, awayRecords.length);
  // Same shape as Proballers mapper's confidence scaling — more games of
  // real history = more trust, capped at 1.0. NFL's small FORM_LOOKBACK
  // (5) means this saturates faster than basketball's did.
  const dataCompleteness = Math.min(1, 0.4 + sampleSize * 0.10);

  return {
    externalMatchId,
    sport: 'nfl',
    confidenceFactors: { dataCompleteness },

    // NFL H2H is exempted in validator.ts (minH2H: 0) — division rivals
    // may meet 1-2x/season, others go years without meeting, so this
    // isn't a useful signal the way it is for football/basketball. Left
    // empty rather than half-built, since nflModel.ts's predictMoneyline
    // doesn't use H2H at all.
    h2h: [],

    homeForm: recordsToFormEntries(homeRecords),
    awayForm: recordsToFormEntries(awayRecords),

    // Required by RawStats but not meaningful for NFL — same neutral
    // placeholder approach proballersStatsMapper.ts uses for basketball.
    referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
    situational: { weather: '', temperature: 0, fatigueDays: 7 }, // 7 = typical NFL bye-week rest, neutral default

    additionalContext: {
      homeStrengthFactor,
      awayStrengthFactor,
      homeYardsPerPlayAvg: homeAvgYardsPerPlay,
      awayYardsPerPlayAvg: awayAvgYardsPerPlay,
      leagueAvgYardsPerPlay: leagueAvg.avgYardsPerPlay,
      leagueAvgTurnovers: leagueAvg.avgTurnovers,
    },
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// Converts TeamGameRecord (nflModel.ts's shape — yardsPerPlay/turnovers
// focused) into RawStats' generic FormRecord shape (goalsFor/goalsAgainst
// naming). Points aren't the real signal here, but W/L and venue are
// still meaningful and cheap to carry through, and validator.ts's NFL
// branch checks homeForm/awayForm venue counts regardless.
function recordsToFormEntries(records: TeamGameRecord[]): RawStats['homeForm'] {
  return records.map(r => ({
    date: r.date,
    opponent: r.opponent,
    result: r.won ? 'W' : 'L',
    venue: r.venue,
    // goalsFor/goalsAgainst intentionally omitted — NFL's real signal
    // (yardsPerPlay, turnovers) lives in additionalContext instead, not
    // here. See file header.
  }));
}