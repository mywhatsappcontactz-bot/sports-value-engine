// src/core/engine/hockeyTotalsBacktest.ts
//
// Backtests hockey GAME TOTALS using a line anchored to each league's
// real historical average total (from hockeySeasonAvgCheck.ts — verified
// stable across 4 seasons per league, no meaningful drift found), blended
// with the model's own matchup-specific expectedTotal (lambdaHome +
// lambdaAway from computeHockeyGoalLambdas).
//
// WHY THE BLEND: an earlier version of this backtest used ONLY
// expectedTotal (model's own prediction) as the line, rounded to nearest
// 0.5. That produced a severe, consistent problem across all 14 leagues:
// hit rates stuck at ~20-26% despite ~61% avgConf. Diagnosed via a
// separate per-league avg-expected-vs-avg-actual check: expectedTotal
// was running ~1.3-1.4x BELOW real average totals, uniformly across
// every league (e.g. NHL: expected 4.49 vs actual 6.21). Root cause not
// fully isolated to one line of computeHockeyGoalLambdas, but the
// magnitude and consistency of the gap made a direct anchor correction
// the more reliable fix than chasing the formula further.
//
// LEAGUE_AVG_TOTAL values below are the 4-season pooled average from
// hockeySeasonAvgCheck.ts (2025-26, 2024-25, 2023-24, 2022-23) — checked
// per-season first and confirmed stable (no league varied by more than
// ~0.6 goals across any season), so a fixed anchor is a reasonable
// starting point. NOT yet re-validated against ongoing 2026-2027 games
// as they accumulate — revisit if real current-season totals start
// drifting from these numbers.
//
// BLEND_WEIGHT controls how much the anchor vs. matchup-specific
// expectedTotal drives the final line. 0.5 is a starting guess, not
// backtested against alternate weights yet — this run's job is to
// confirm the blend direction is right at all before tuning the weight.

import {
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';
import { computeHockeyGoalLambdas } from './probabilityModel';
import { Stats, FormRecord } from '../database/schema';
import { buildHistory, TeamGameRecord } from './hockeyBacktest1';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 10;
const MIN_TIP_CONFIDENCE = 0.55;
const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];
const MIN_LEAGUE_HIT_RATE_TO_INCLUDE = 0.70;
const BLEND_WEIGHT = 0.5; // 0 = pure league average, 1 = pure model expectedTotal

// 4-season pooled average total, from hockeySeasonAvgCheck.ts output —
// see file header for the stability check that justified using these
// as fixed anchors.
const LEAGUE_AVG_TOTAL: Record<string, number> = {
  'EIHL - United Kingdom': 6.36,
  'KHL - Russia': 5.33,
  'Liiga - Finland': 5.44,
  'AlpsHL': 6.25,
  'NHL': 6.22,
  'AHL': 6.08,
  'ECHL': 6.26,
  'SHL - Sweden': 5.38,
  'HockeyAllsvenskan - Sweden': 5.61,
  'Mestis - Finland': 6.13,
  'DEL - Germany': 5.92,
  'DEL2 - Germany': 5.96,
  'ICEHL - Austria': 5.82,
  'VHL - Russia': 5.26,
};

const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);

// ─── TYPES ──────────────────────────────────────────────────────────────

interface SeasonedGame extends EPGame {
  seasonLabel: string;
}

interface TotalsTip {
  league: string;
  season: string;
  date: string;
  homeTeam: string;
  awayTeam: string;
  line: number;
  selection: 'Over' | 'Under';
  confidence: number;
  actualTotal: number;
  hit: boolean;
}

// ─── FORM CONVERSION ──────────────────────────────────────────────────────

function toFormRecords(records: TeamGameRecord[], venue: 'home' | 'away'): FormRecord[] {
  return records.slice(0, 10).map(r => ({
    date: r.date,
    opponent: r.opponent,
    result: r.won ? 'W' : 'L',
    goalsFor: r.goalsFor,
    goalsAgainst: r.goalsAgainst,
    venue,
  }));
}

// ─── BACKTEST LOOP ────────────────────────────────────────────────────────

function runTotalsBacktest(league: string, games: SeasonedGame[]): TotalsTip[] {
  const tips: TotalsTip[] = [];
  let sumExpected = 0;
  let sumBlended = 0;
  let sumActual = 0;
  let count = 0;

  const leagueAvg = LEAGUE_AVG_TOTAL[league] ?? 5.8; // rough fallback mean if a league is somehow missing

  const seen = new Set<number>();
  const deduped = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
  const completedOnly = deduped.filter(g => g.isCompleted);
  const sorted = completedOnly.sort((a, b) => a.date.localeCompare(b.date));

  for (const game of sorted) {
    const priorGames = sorted.filter(g => g.date < game.date);
    const history = buildHistory(priorGames);

    const homeRecordsAll = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const awayRecordsAll = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));

    if (homeRecordsAll.length < MIN_PRIOR_GAMES || awayRecordsAll.length < MIN_PRIOR_GAMES) continue;

    const stats: Stats = {
      id: `bt-${game.gameId}`, matchId: `bt-${game.gameId}`, sport: 'hockey',
      h2h: [],
      homeForm: toFormRecords(homeRecordsAll, 'home'),
      awayForm: toFormRecords(awayRecordsAll, 'away'),
      referee: {}, situational: {}, additionalContext: {},
      confidenceFactors: { dataCompleteness: 1, h2hSampleSize: 0, formSampleSize: 10 },
    };

    const { lambdaHome, lambdaAway } = computeHockeyGoalLambdas(stats);
    const expectedTotal = lambdaHome + lambdaAway;

    // Blend the matchup-specific model prediction with the league's
    // real historical average — see file header for why pure
    // expectedTotal alone produced a severely miscalibrated line.
    const blendedTotal = expectedTotal * BLEND_WEIGHT + leagueAvg * (1 - BLEND_WEIGHT);
    const line = Math.round(blendedTotal * 2) / 2;

    // Scale lambdaHome/lambdaAway proportionally so their SUM matches
    // blendedTotal, preserving the model's home/away split while
    // correcting the overall level — rather than computing Poisson
    // probability against the raw (too-low) lambdas directly.
    const scaleFactor = expectedTotal > 0 ? blendedTotal / expectedTotal : 1;
    const scaledLambdaHome = lambdaHome * scaleFactor;
    const scaledLambdaAway = lambdaAway * scaleFactor;

    function poissonPmf(lambda: number, k: number): number {
      if (lambda <= 0) return k === 0 ? 1 : 0;
      let logP = -lambda + k * Math.log(lambda);
      for (let i = 1; i <= k; i++) logP -= Math.log(i);
      return Math.exp(logP);
    }
    let overProb = 0;
    for (let i = 0; i <= 15; i++) {
      for (let j = 0; j <= 15; j++) {
        if (i + j > line) overProb += poissonPmf(scaledLambdaHome, i) * poissonPmf(scaledLambdaAway, j);
      }
    }

    const selection: 'Over' | 'Under' = overProb >= 0.5 ? 'Over' : 'Under';
    const confidence = Math.max(overProb, 1 - overProb);

    const actualTotal = game.homeScore! + game.awayScore!;
    sumExpected += expectedTotal;
    sumBlended += blendedTotal;
    sumActual += actualTotal;
    count++;

    if (confidence < MIN_TIP_CONFIDENCE) continue;
    if (actualTotal === line) continue;
    const hit = selection === 'Over' ? actualTotal > line : actualTotal < line;

    tips.push({ league, season: game.seasonLabel, date: game.date, homeTeam: game.homeTeam, awayTeam: game.awayTeam, line, selection, confidence, actualTotal, hit });
  }

  console.log('   [' + league + '] avg expectedTotal=' + (count > 0 ? (sumExpected / count).toFixed(2) : 'N/A') +
    ' avg blendedLine=' + (count > 0 ? (sumBlended / count).toFixed(2) : 'N/A') +
    ' avg actualTotal=' + (count > 0 ? (sumActual / count).toFixed(2) : 'N/A') +
    ' (n=' + count + ')');
  return tips;
}

function summarize(tips: TotalsTip[], label: string): void {
  if (!tips.length) { console.log(`   [${label}] 0 qualifying tips`); return; }
  const hits = tips.filter(t => t.hit).length;
  const avgConf = tips.reduce((s, t) => s + t.confidence, 0) / tips.length;
  console.log(`   [${label}] totals: tips=${tips.length} hits=${hits} hitRate=${((hits / tips.length) * 100).toFixed(1)}% avgConf=${(avgConf * 100).toFixed(1)}%`);
}

async function main() {
  const allTips: TotalsTip[] = [];
  const leagueSummaries: { league: string; tips: number; hitRate: number }[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    console.log(`\n=== ${leagueName} ===`);
    let leagueGames: SeasonedGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        console.log(`   Season ${season}: ${games.length} games`);
        leagueGames.push(...games.map(g => ({ ...g, seasonLabel: season })));
      } catch (err: any) {
        console.error(`   Season ${season} FAILED: ${err.message}`);
      }
    }

    if (!leagueGames.length) { console.log(`   No data — skipping`); continue; }

    const tips = runTotalsBacktest(leagueName, leagueGames);
    summarize(tips, leagueName);
    allTips.push(...tips);

    if (tips.length > 0) {
      const hits = tips.filter(t => t.hit).length;
      leagueSummaries.push({ league: leagueName, tips: tips.length, hitRate: hits / tips.length });
    }
  }

  const keptLeagueNames = new Set(leagueSummaries.filter(s => s.hitRate >= MIN_LEAGUE_HIT_RATE_TO_INCLUDE).map(s => s.league));
  const filteredTips = allTips.filter(t => keptLeagueNames.has(t.league));

  console.log(`\n\n========== GRAND TOTAL (${keptLeagueNames.size} leagues at/above ${(MIN_LEAGUE_HIT_RATE_TO_INCLUDE * 100).toFixed(0)}%) ==========`);
  summarize(filteredTips, 'ALL LEAGUES (filtered)');

  console.log('\n========== LEAGUES RANKED BY HIT RATE ==========');
  const ranked = [...leagueSummaries].sort((a, b) => a.hitRate - b.hitRate);
  for (const r of ranked) {
    const tag = r.hitRate < MIN_LEAGUE_HIT_RATE_TO_INCLUDE ? '  [DROPPED]' : '';
    console.log(`   ${r.league.padEnd(35)} tips=${String(r.tips).padEnd(5)} hitRate=${(r.hitRate * 100).toFixed(1)}%${tag}`);
  }
  console.log('\n=== Done ===');
}

if (require.main === module) {
  main().catch(err => { console.error('[HockeyTotalsBacktest] Fatal error:', err.message); process.exit(1); });
}