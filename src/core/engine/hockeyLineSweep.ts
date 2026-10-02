// src/core/engine/hockeyLineSweep.ts
//
// Tests a FIXED SPREAD of candidate lines for game totals and team
// totals against real historical outcomes — no model-derived blending,
// no anchor formula. Same discipline as football's CARDS_LINES/
// SOT_LINES/TEAM_CORNERS_LINES: try several real, bookmaker-plausible
// lines, keep only the ones that clear MIN_HIT_RATE in real history.
//
// Replaces the model-expectedTotal-blend approach in
// hockeyTotalsBacktest.ts, which required tuning a BLEND_WEIGHT
// parameter with no clean stopping point. This is simpler and matches
// how every other market in this codebase actually gets calibrated:
// test real candidates, keep what works.

import {
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';

const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];
const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);
const MIN_HIT_RATE = 0.70;

// Real, bookmaker-plausible game-total lines to sweep.
const GAME_TOTAL_LINES = [4.5, 5.5, 6.5, 7.5];
// Real, bookmaker-plausible team-total lines to sweep.
const TEAM_TOTAL_LINES = [1.5, 2.5, 3.5];

interface LineResult {
  league: string;
  market: string;
  line: number;
  side: 'Over' | 'Under';
  bets: number;
  hits: number;
  hitRate: number;
}

function sweepGameTotals(league: string, games: EPGame[]): LineResult[] {
  const completed = games.filter(g => g.isCompleted);
  const results: LineResult[] = [];

  for (const line of GAME_TOTAL_LINES) {
    let overHits = 0, underHits = 0;
    for (const g of completed) {
      const total = g.homeScore! + g.awayScore!;
      if (total === line) continue; // push
      if (total > line) overHits++; else underHits++;
    }
    const n = completed.length;
    if (n === 0) continue;
    results.push({ league, market: 'game_total', line, side: 'Over', bets: n, hits: overHits, hitRate: overHits / n });
    results.push({ league, market: 'game_total', line, side: 'Under', bets: n, hits: underHits, hitRate: underHits / n });
  }
  return results;
}

function sweepTeamTotals(league: string, games: EPGame[]): LineResult[] {
  const completed = games.filter(g => g.isCompleted);
  const results: LineResult[] = [];

  for (const line of TEAM_TOTAL_LINES) {
    let homeOverHits = 0, homeUnderHits = 0, homeN = 0;
    let awayOverHits = 0, awayUnderHits = 0, awayN = 0;

    for (const g of completed) {
      if (g.homeScore !== line) {
        homeN++;
        if (g.homeScore! > line) homeOverHits++; else homeUnderHits++;
      }
      if (g.awayScore !== line) {
        awayN++;
        if (g.awayScore! > line) awayOverHits++; else awayUnderHits++;
      }
    }

    if (homeN > 0) {
      results.push({ league, market: 'home_team_total', line, side: 'Over', bets: homeN, hits: homeOverHits, hitRate: homeOverHits / homeN });
      results.push({ league, market: 'home_team_total', line, side: 'Under', bets: homeN, hits: homeUnderHits, hitRate: homeUnderHits / homeN });
    }
    if (awayN > 0) {
      results.push({ league, market: 'away_team_total', line, side: 'Over', bets: awayN, hits: awayOverHits, hitRate: awayOverHits / awayN });
      results.push({ league, market: 'away_team_total', line, side: 'Under', bets: awayN, hits: awayUnderHits, hitRate: awayUnderHits / awayN });
    }
  }
  return results;
}

async function main() {
  const allResults: LineResult[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    console.log(`\n=== ${leagueName} ===`);
    let leagueGames: EPGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        leagueGames.push(...games);
      } catch (err: any) {
        console.error(`   Season ${season} FAILED: ${err.message}`);
      }
    }

    if (!leagueGames.length) { console.log('   No data — skipping'); continue; }

    const seen = new Set<number>();
    const deduped = leagueGames.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));

    const gameTotalResults = sweepGameTotals(leagueName, deduped);
    const teamTotalResults = sweepTeamTotals(leagueName, deduped);
    allResults.push(...gameTotalResults, ...teamTotalResults);

    for (const r of [...gameTotalResults, ...teamTotalResults]) {
      const tag = r.hitRate >= MIN_HIT_RATE ? '  [CLEARS 70%]' : '';
      console.log(`   ${r.market.padEnd(18)} ${r.side.padEnd(6)} ${r.line} : n=${r.bets} hits=${r.hits} hitRate=${(r.hitRate * 100).toFixed(1)}%${tag}`);
    }
  }

  console.log('\n\n========== ALL LINES CLEARING 70% (pooled across leagues where shown above) ==========');
  const winners = allResults.filter(r => r.hitRate >= MIN_HIT_RATE);
  if (!winners.length) {
    console.log('   None. No fixed line cleared 70% hit rate in any league for either market.');
  } else {
    for (const w of winners) {
      console.log(`   ${w.league.padEnd(30)} ${w.market.padEnd(18)} ${w.side} ${w.line} : n=${w.bets} hitRate=${(w.hitRate * 100).toFixed(1)}%`);
    }
  }
  console.log('\n=== Done ===');
}

main().catch(err => { console.error('[HockeyLineSweep] Fatal error:', err.message); process.exit(1); });