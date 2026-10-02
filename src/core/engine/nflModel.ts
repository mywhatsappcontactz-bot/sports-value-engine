// src/core/engine/nflModel.ts
//
// Low-variance NFL moneyline model. Pure model logic only — no fetching,
// no backtest loop (see nflBacktest.ts for that, same split pattern as
// backtestModel.ts / basketballBacktest1.ts).
//
// ARCHITECTURE (mirrors patterns already proven in this codebase):
//   1. Yardage differential, opponent-adjusted — same attack-strength /
//      defense-weakness ratio pattern as computeFootballLambdas() in
//      probabilityModel.ts and computeExpectedCorners() in
//      cornersAggregator.ts. Just a new sport, same formula shape.
//   2. Turnover regression toward league average — same blending technique
//      already used for h2h (lambdaHome*0.8 + h2hHomeGoals*0.2 pattern).
//   3. Deviation-from-0.5 AMPLIFICATION (not compression) for the final
//      win probability. See CONFIDENCE_AMPLIFICATION comment below for
//      why this differs from basketball's compression approach.
//
// CONFIDENCE_AMPLIFICATION — IMPORTANT DESIGN NOTE:
// Basketball's moneyline formula compresses strengthRatio toward 0.5
// (via *0.85+offset) because real team-strength gaps there are wide, and
// compression prevented overconfidence. NFL is structurally different —
// the league is deliberately built for parity (salary cap, draft order),
// so strengthRatio naturally sits close to 0.5 even for real mismatches.
// The 2024+2025 backtest (see conversation) confirmed this concretely:
// predictions the OLD compressed formula rated as "50-55% confidence"
// actually hit 60.9% of the time — real signal was being squashed out.
// So here we AMPLIFY the deviation from 0.5 instead of compressing it.
// AMPLIFICATION_FACTOR is a starting value, not empirically tuned yet —
// re-run nflBacktest.ts after changing it and check the confidence-bucket
// table to see if predicted vs actual hit rate lines up better or worse.
//
// FIELD-NAME QUIRKS CONFIRMED FROM REAL ESPN DATA (see conversation —
// game 401873271, ARI vs CAR):
//   - totalYards, completionAttempts, sacksYardsLost, turnovers all have
//     "value": "-" — the real number is ONLY in displayValue as a string.
//     Must parse displayValue for these specific fields, not value.
//   - "interceptions" appears TWICE in the stats array (thrown, listed
//     redundantly) — de-dupe by name, take the first occurrence.
//   - thirdDownEff and redZoneAttempts DO have usable numeric `value`
//     fields already as fractions (e.g. 0.6428571429) — no displayValue
//     parsing needed for those two.

import { fetchGameSummary, NflGame } from '../../scrapers/football-nfl/nflScraper';

// ─── CONFIG ─────────────────────────────────────────────────────────────

export const MIN_PRIOR_GAMES = 3; // NFL has far fewer games/season than football/basketball — lower bar needed
export const FORM_LOOKBACK = 5;   // rolling window, per original plan
export const TURNOVER_REGRESSION_WEIGHT = 0.7; // 70% league-average / 30% team-specific

// See CONFIDENCE_AMPLIFICATION note above — starting value, needs
// empirical tuning via nflBacktest.ts's confidence-bucket check.
export const AMPLIFICATION_FACTOR = 3.0;

// ─── TYPES ──────────────────────────────────────────────────────────────

export interface NflTeamGameStats {
  totalYards: number;
  netPassingYards: number;
  rushingYards: number;
  yardsPerPlay: number;
  turnovers: number;
  firstDowns: number;
  thirdDownEff: number;   // fraction 0-1
  redZoneEff: number;     // fraction 0-1
  possessionSeconds: number;
}

export interface NflBoxscoreResult {
  gameId: string;
  home: NflTeamGameStats;
  away: NflTeamGameStats;
}

export interface TeamGameRecord {
  date: string;
  opponent: string;
  won: boolean;
  yardsPerPlay: number;
  oppYardsPerPlay: number;
  turnovers: number;
  thirdDownEff: number;
  venue: 'home' | 'away';
}

export interface LeagueAverages {
  avgYardsPerPlay: number;
  avgTurnovers: number;
}

export interface MoneylinePrediction {
  homeWinProb: number;
  favoredSide: 'Home' | 'Away';
  confidence: number;
}

// ─── BOXSCORE PARSING (handles the value/displayValue quirks) ───────────

const DISPLAY_VALUE_ONLY_FIELDS = new Set(['totalYards', 'turnovers']);

function extractStat(stats: any[], name: string): number {
  const stat = stats.find((s: any) => s.name === name); // de-dupe: first occurrence only
  if (!stat) return 0;

  if (DISPLAY_VALUE_ONLY_FIELDS.has(name)) {
    const parsed = parseFloat(stat.displayValue);
    return isNaN(parsed) ? 0 : parsed;
  }

  const val = stat.value;
  if (typeof val === 'number') return val;
  const parsed = parseFloat(stat.displayValue);
  return isNaN(parsed) ? 0 : parsed;
}

function parseTeamStats(teamBlock: any): NflTeamGameStats {
  const stats = teamBlock.statistics ?? [];
  return {
    totalYards: extractStat(stats, 'totalYards'),
    netPassingYards: extractStat(stats, 'netPassingYards'),
    rushingYards: extractStat(stats, 'rushingYards'),
    yardsPerPlay: extractStat(stats, 'yardsPerPlay'),
    turnovers: extractStat(stats, 'turnovers'),
    firstDowns: extractStat(stats, 'firstDowns'),
    thirdDownEff: extractStat(stats, 'thirdDownEff'),
    redZoneEff: extractStat(stats, 'redZoneAttempts'),
    possessionSeconds: extractStat(stats, 'possessionTime'),
  };
}

export function parseBoxscore(gameId: string, summaryJson: any): NflBoxscoreResult | null {
  const teams = summaryJson?.boxscore?.teams;
  if (!teams || teams.length !== 2) return null;

  const homeBlock = teams.find((t: any) => t.homeAway === 'home');
  const awayBlock = teams.find((t: any) => t.homeAway === 'away');
  if (!homeBlock || !awayBlock) return null;

  return {
    gameId,
    home: parseTeamStats(homeBlock),
    away: parseTeamStats(awayBlock),
  };
}

// ─── TEAM HISTORY BUILDER ─────────────────────────────────────────────────

/**
 * Fetches boxscores for every completed game in the list and builds a
 * team -> chronological-game-record-history map. This is the expensive
 * part (one fetch per completed game) — callers should fetch ONCE and
 * reuse the result, slicing it in-memory per prediction rather than
 * re-fetching (see nflBacktest.ts for the correct pattern).
 */
export async function buildHistoryFromGames(games: NflGame[]): Promise<Map<string, TeamGameRecord[]>> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(team: string, rec: TeamGameRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }

  const completed = games.filter(g => g.completed).sort((a, b) => a.date.localeCompare(b.date));

  let processed = 0;
  for (const game of completed) {
    try {
      const summary = await fetchGameSummary(game.gameId);
      const box = parseBoxscore(game.gameId, summary);
      if (box) {
        push(game.homeTeam, {
          date: game.date, opponent: game.awayTeam,
          won: (game.homeScore ?? 0) > (game.awayScore ?? 0),
          yardsPerPlay: box.home.yardsPerPlay, oppYardsPerPlay: box.away.yardsPerPlay,
          turnovers: box.home.turnovers, thirdDownEff: box.home.thirdDownEff, venue: 'home',
        });
        push(game.awayTeam, {
          date: game.date, opponent: game.homeTeam,
          won: (game.awayScore ?? 0) > (game.homeScore ?? 0),
          yardsPerPlay: box.away.yardsPerPlay, oppYardsPerPlay: box.home.yardsPerPlay,
          turnovers: box.away.turnovers, thirdDownEff: box.away.thirdDownEff, venue: 'away',
        });
      }
    } catch (err: any) {
      console.warn(`[NflModel] Boxscore fetch failed for game ${game.gameId}: ${err.message}`);
    }

    processed++;
    if (processed % 20 === 0 || processed === completed.length) {
      console.log(`  ...fetched ${processed}/${completed.length} boxscores`);
    }
  }

  return map;
}

export function computeLeagueAverages(history: Map<string, TeamGameRecord[]>): LeagueAverages {
  let ypSum = 0, toSum = 0, count = 0;
  for (const records of history.values()) {
    for (const r of records) {
      ypSum += r.yardsPerPlay;
      toSum += r.turnovers;
      count++;
    }
  }
  return {
    avgYardsPerPlay: count > 0 ? ypSum / count : 5.5,
    avgTurnovers: count > 0 ? toSum / count : 1.2,
  };
}

// ─── CORE MODEL ─────────────────────────────────────────────────────────

function recentForm(history: Map<string, TeamGameRecord[]>, team: string): TeamGameRecord[] {
  const records = history.get(team) ?? [];
  return records.slice(-FORM_LOOKBACK);
}

export function yardageStrength(records: TeamGameRecord[], leagueAvg: LeagueAverages): number { 
  if (!records.length) return 1.0;
  const avgYPP = records.reduce((s, r) => s + r.yardsPerPlay, 0) / records.length;
  return leagueAvg.avgYardsPerPlay > 0 ? avgYPP / leagueAvg.avgYardsPerPlay : 1.0;
}

export function regressedTurnoverRate(records: TeamGameRecord[], leagueAvg: LeagueAverages): number {
  if (!records.length) return leagueAvg.avgTurnovers;
  const teamRate = records.reduce((s, r) => s + r.turnovers, 0) / records.length;
  return leagueAvg.avgTurnovers * TURNOVER_REGRESSION_WEIGHT + teamRate * (1 - TURNOVER_REGRESSION_WEIGHT);
}

/**
 * Combines yardage strength and turnover-rate adjustment into one
 * per-team factor — the exact same calculation predictMoneyline() used
 * to do inline. Exported so nflStatsMapper.ts can precompute and store
 * this same number at sync time, rather than duplicating the formula
 * (same class of bug as the basketball centering issue earlier tonight —
 * one source of truth, not two copies that can drift apart).
 */
export function computeTeamStrengthFactor(records: TeamGameRecord[], leagueAvg: LeagueAverages): number {
  const yardStrength = yardageStrength(records, leagueAvg);
  const toRate = regressedTurnoverRate(records, leagueAvg);
  const toAdj = Math.max(0.85, 1 - (toRate - leagueAvg.avgTurnovers) * 0.05);
  return yardStrength * toAdj;
}
/**
 * Core prediction: yardage strength differential, with turnovers as a
 * secondary dampener. Final probability AMPLIFIES the deviation from 0.5
 * rather than compressing it — see CONFIDENCE_AMPLIFICATION note at top
 * of file for why this differs from the basketball model's approach.
 */
export function predictMoneyline(
  homeHistory: Map<string, TeamGameRecord[]>,
  homeTeam: string,
  awayTeam: string,
  leagueAvg: LeagueAverages,
): MoneylinePrediction | null {
  const homeRecords = recentForm(homeHistory, homeTeam);
  const awayRecords = recentForm(homeHistory, awayTeam);

  if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) return null;

  const homeStrength = computeTeamStrengthFactor(homeRecords, leagueAvg);
  const awayStrength = computeTeamStrengthFactor(awayRecords, leagueAvg);

  const total = homeStrength + awayStrength || 1;
  const strengthRatio = homeStrength / total; // 0.5 = evenly matched

  // AMPLIFY deviation from 0.5 instead of compressing it — see note at
  // top of file. deviation * AMPLIFICATION_FACTOR, added back to 0.5,
  // then clamped. This is algebraically guaranteed to stay centered at
  // exactly 0.5 for an even matchup (deviation=0 -> homeWinProb=0.5),
  // same centering discipline as the Proballers basketball fix.
  const deviation = strengthRatio - 0.5;
  let homeWinProb = 0.5 + deviation * AMPLIFICATION_FACTOR;
  homeWinProb = Math.max(0.05, Math.min(0.95, homeWinProb));

  const favoredSide = homeWinProb >= 0.5 ? 'Home' : 'Away';
  const confidence = Math.max(homeWinProb, 1 - homeWinProb);

  return { homeWinProb, favoredSide, confidence };
}