// src/core/engine/hockeyCalibrationPrep.ts
//
// Walk-forward backtest producing REAL hit rate binned by RAW MODEL
// CONFIDENCE, for puck line (+1.5 and +2.5) and the five totals/team-
// totals markets confirmed via hockeyLineSweep.ts (Game Total Over 4.5,
// Game Total Under 7.5, Home Team Total Over 1.5, Away Team Total Over
// 1.5, Away Team Total Under 3.5). This is the direct input an isotonic
// fit needs — same shape as hockeyIsotonicFit.ts's moneyline
// preparation — NOT the calibration table itself. Once this run shows
// clean, monotonic bins (real hit rate rising as raw confidence rises),
// those bins become the ISOTONIC_BLOCKS arrays wired into
// probabilityModel.ts.
//
// Uses computeHockeyGoalLambdas/marginDistribution/handicapCoverProbability
// — same shared functions production's modelHockey() uses — so this
// calibration is built against the EXACT formula that will ship, not a
// hand-duplicated copy (same drift-prevention discipline as
// hockeyBacktest1.ts's predictMoneyline).

import {
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';
import {
  computeHockeyGoalLambdas,
  marginDistribution,
  handicapCoverProbability,
} from './probabilityModel';
import { Stats, FormRecord } from '../database/schema';
import { buildHistory, TeamGameRecord } from './hockeyBacktest1';

const MIN_PRIOR_GAMES = 10;
const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];
const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);

// Fixed lines confirmed via hockeyLineSweep.ts — only these ship.
const GAME_TOTAL_OVER_LINE = 4.5;
const GAME_TOTAL_UNDER_LINE = 7.5;
const TEAM_TOTAL_OVER_LINE = 1.5;
const AWAY_TEAM_TOTAL_UNDER_LINE = 3.5;
const PUCK_LINES = [1.5, 2.5];

interface MarketSample {
  rawConfidence: number;
  hit: boolean;
}

function toFormRecords(records: TeamGameRecord[], venue: 'home' | 'away'): FormRecord[] {
  return records.slice(0, 10).map(r => ({
    date: r.date, opponent: r.opponent, result: r.won ? 'W' : 'L',
    goalsFor: r.goalsFor, goalsAgainst: r.goalsAgainst, venue,
  }));
}

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

function singleOverProb(mean: number, line: number, maxVal = 20): number {
  let p = 0;
  for (let i = 0; i <= maxVal; i++) if (i > line) p += poissonPmf(mean, i);
  return p;
}

function totalOverProb(lambdaHome: number, lambdaAway: number, line: number, maxVal = 15): number {
  let p = 0;
  for (let i = 0; i <= maxVal; i++) for (let j = 0; j <= maxVal; j++) if (i + j > line) p += poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
  return p;
}

function binAndSummarize(samples: MarketSample[], label: string) {
  if (!samples.length) { console.log('   [' + label + '] 0 samples'); return; }
  const sorted = [...samples].sort((a, b) => a.rawConfidence - b.rawConfidence);
  const binCount = 10;
  const binSize = Math.ceil(sorted.length / binCount);
  console.log('   [' + label + '] n=' + samples.length);
  for (let b = 0; b < binCount; b++) {
    const slice = sorted.slice(b * binSize, (b + 1) * binSize);
    if (!slice.length) continue;
    const avgConf = slice.reduce((s, x) => s + x.rawConfidence, 0) / slice.length;
    const hits = slice.filter(x => x.hit).length;
    const realHitRate = hits / slice.length;
    console.log('      bin ' + (b + 1) + ': n=' + slice.length + ' avgRawConf=' + (avgConf * 100).toFixed(1) + '% realHitRate=' + (realHitRate * 100).toFixed(1) + '%');
  }
}

async function main() {
  const puckLineSamples: Record<number, MarketSample[]> = { 1.5: [], 2.5: [] };
  const gameOverSamples: MarketSample[] = [];
  const gameUnderSamples: MarketSample[] = [];
  const homeTeamOverSamples: MarketSample[] = [];
  const awayTeamOverSamples: MarketSample[] = [];
  const awayTeamUnderSamples: MarketSample[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    console.log('\n=== ' + leagueName + ' ===');
    let leagueGames: EPGame[] = [];
    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        leagueGames.push(...games);
      } catch (err: any) {
        console.error('   Season ' + season + ' FAILED: ' + err.message);
      }
    }
    if (!leagueGames.length) continue;

    const seen = new Set<number>();
    const deduped = leagueGames.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
    const completed = deduped.filter(g => g.isCompleted);
    const sorted = completed.sort((a, b) => a.date.localeCompare(b.date));

    for (const game of sorted) {
      const priorGames = sorted.filter(g => g.date < game.date);
      const history = buildHistory(priorGames);
      const homeRecords = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
      const awayRecords = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
      if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) continue;

      const stats: Stats = {
        id: 'x', matchId: 'x', sport: 'hockey', h2h: [],
        homeForm: toFormRecords(homeRecords, 'home'),
        awayForm: toFormRecords(awayRecords, 'away'),
        referee: {}, situational: {}, additionalContext: {},
        confidenceFactors: { dataCompleteness: 1, h2hSampleSize: 0, formSampleSize: 10 },
      };

      const { lambdaHome, lambdaAway } = computeHockeyGoalLambdas(stats);
      const actualHomeGoals = game.homeScore!;
      const actualAwayGoals = game.awayScore!;
      const actualMargin = actualHomeGoals - actualAwayGoals;

      // ── PUCK LINE (both 1.5 and 2.5) ──
      const dist = marginDistribution(lambdaHome, lambdaAway);
      for (const pl of PUCK_LINES) {
        // Direction from the model's own win probability, same as production.
        const homeWinProbApprox = handicapCoverProbability(dist, 0);
        const homeIsFavored = homeWinProbApprox >= 0.5;
        const homeLine = homeIsFavored ? -pl : pl;
        const homeCoverProb = handicapCoverProbability(dist, homeLine);
        const favHomeCover = homeCoverProb >= 0.5;
        const confidence = Math.max(homeCoverProb, 1 - homeCoverProb);
        const homeCovered = homeIsFavored ? actualMargin >= Math.ceil(pl) : actualMargin > -Math.ceil(pl);
        const hit = favHomeCover ? homeCovered : !homeCovered;
        puckLineSamples[pl].push({ rawConfidence: confidence, hit });
      }

      // ── GAME TOTAL OVER 4.5 / UNDER 7.5 ──
      const actualTotal = actualHomeGoals + actualAwayGoals;
      const overProbAt45 = totalOverProb(lambdaHome, lambdaAway, GAME_TOTAL_OVER_LINE);
      gameOverSamples.push({ rawConfidence: overProbAt45, hit: actualTotal > GAME_TOTAL_OVER_LINE });
      const overProbAt75 = totalOverProb(lambdaHome, lambdaAway, GAME_TOTAL_UNDER_LINE);
      gameUnderSamples.push({ rawConfidence: 1 - overProbAt75, hit: actualTotal < GAME_TOTAL_UNDER_LINE });

      // ── TEAM TOTALS ──
      const homeOverProb = singleOverProb(lambdaHome, TEAM_TOTAL_OVER_LINE);
      homeTeamOverSamples.push({ rawConfidence: homeOverProb, hit: actualHomeGoals > TEAM_TOTAL_OVER_LINE });
      const awayOverProb = singleOverProb(lambdaAway, TEAM_TOTAL_OVER_LINE);
      awayTeamOverSamples.push({ rawConfidence: awayOverProb, hit: actualAwayGoals > TEAM_TOTAL_OVER_LINE });
      const awayUnderProb = 1 - singleOverProb(lambdaAway, AWAY_TEAM_TOTAL_UNDER_LINE);
      awayTeamUnderSamples.push({ rawConfidence: awayUnderProb, hit: actualAwayGoals < AWAY_TEAM_TOTAL_UNDER_LINE });
    }
  }

  console.log('\n\n========== CALIBRATION BINS (real hit rate vs raw model confidence) ==========');
  binAndSummarize(puckLineSamples[1.5], 'PUCK LINE +/-1.5');
  binAndSummarize(puckLineSamples[2.5], 'PUCK LINE +/-2.5');
  binAndSummarize(gameOverSamples, 'GAME TOTAL Over 4.5');
  binAndSummarize(gameUnderSamples, 'GAME TOTAL Under 7.5');
  binAndSummarize(homeTeamOverSamples, 'HOME TEAM TOTAL Over 1.5');
  binAndSummarize(awayTeamOverSamples, 'AWAY TEAM TOTAL Over 1.5');
  binAndSummarize(awayTeamUnderSamples, 'AWAY TEAM TOTAL Under 3.5');
  console.log('\n=== Done ===');
}

main().catch(err => { console.error('[HockeyCalibrationPrep] Fatal error:', err.message); process.exit(1); });