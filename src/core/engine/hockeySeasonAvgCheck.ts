// src/core/engine/hockeySeasonAvgCheck.ts
//
// Checks whether each league's average game total has shifted across
// seasons, or held steady — before deciding whether a per-league average
// (from hockeyTotalsBacktest.ts's diagnostic) is safe to use as a fixed
// anchor, or needs to be a rolling/recent-games-only number instead.
// Groups by (league, season) instead of pooling all seasons together.

import {
  fetchLeagueScores,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';

const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];
const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);

async function main() {
  for (const leagueName of ACTIVE_LEAGUES) {
    console.log('\n=== ' + leagueName + ' ===');

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        const completed = games.filter(g => g.isCompleted);
        if (!completed.length) {
          console.log('   ' + season + ': no completed games');
          continue;
        }
        const totals = completed.map(g => g.homeScore! + g.awayScore!);
        const avg = totals.reduce((s, t) => s + t, 0) / totals.length;
        console.log('   ' + season + ': n=' + completed.length + ' avgTotal=' + avg.toFixed(2));
      } catch (err: any) {
        console.log('   ' + season + ' FAILED: ' + err.message);
      }
    }
  }
  console.log('\n=== Done ===');
}

main().catch(err => { console.error('[HockeySeasonAvgCheck] Fatal error:', err.message); process.exit(1); });