// src/core/engine/nflBacktest.ts
//
// Backtests the NFL moneyline model against real completed seasons.
// Separate from nflModel.ts (which is pure model logic) — same split
// pattern as backtestModel.ts (football) and basketballBacktest1.ts.
//
// Run with: npx ts-node src/core/engine/nflBacktest.ts

import { fetchFullSeason, NflGame } from '../../scrapers/football-nfl/nflScraper';
import {
  buildHistoryFromGames,
  computeLeagueAverages,
  predictMoneyline,
  TeamGameRecord,
} from './nflModel';

interface BacktestResult {
  confidence: number;
  hit: boolean;
  spreadHit: boolean; // did our pick win outright OR lose by <= 3 (i.e. cover a +3.5 handicap)?
}

function printConfidenceBuckets(results: BacktestResult[], hitKey: 'hit' | 'spreadHit', label: string): void {
  console.log(`\n--- ${label} confidence calibration check ---`);
  const buckets: [number, number, string][] = [
    [0.50, 0.55, '50-55%'],
    [0.55, 0.60, '55-60%'],
    [0.60, 0.65, '60-65%'],
    [0.65, 0.70, '65-70%'],
    [0.70, 0.80, '70-80%'],
    [0.80, 1.01, '80%+'],
  ];
  for (const [lo, hi, bucketLabel] of buckets) {
    const subset = results.filter(r => r.confidence >= lo && r.confidence < hi);
    if (!subset.length) { console.log(`  ${bucketLabel}: 0 predictions`); continue; }
    const hits = subset.filter(r => r[hitKey]).length;
    console.log(`  ${bucketLabel}: ${subset.length} predictions, ${hits} hits, hit rate ${((hits / subset.length) * 100).toFixed(1)}%`);
  }
}

async function main() {
  console.log('Fetching 2024 and 2025 regular seasons (both completed)...');
  const games2024 = await fetchFullSeason(2024, 2);
  const games2025 = await fetchFullSeason(2025, 2);
  const allGames = [...games2024, ...games2025].sort((a, b) => a.date.localeCompare(b.date));

  const completed = allGames.filter(g => g.completed);
  console.log(`Total games: ${allGames.length}, completed: ${completed.length}`);

  if (completed.length === 0) {
    console.log('No completed games found — check year/seasonType.');
    return;
  }

  console.log(`\nFetching all ${completed.length} boxscores ONCE (several minutes)...`);
  const fullHistory = await buildHistoryFromGames(allGames);
  console.log(`Teams with history: ${fullHistory.size}`);

  const leagueAvg = computeLeagueAverages(fullHistory);
  console.log(`\nLeague averages: yardsPerPlay=${leagueAvg.avgYardsPerPlay.toFixed(2)}, turnovers=${leagueAvg.avgTurnovers.toFixed(2)}`);

  console.log('\nRunning backtest (pooled 2024+2025, chronological, no-lookahead, in-memory only)...');
  let tested = 0, hits = 0;
  const results: BacktestResult[] = [];
  const sortedCompleted = [...completed].sort((a, b) => a.date.localeCompare(b.date));

  for (const game of sortedCompleted) {
    const priorOnlyHistory = new Map<string, TeamGameRecord[]>();
    for (const [team, records] of fullHistory) {
      priorOnlyHistory.set(team, records.filter(r => r.date < game.date));
    }

    const pred = predictMoneyline(priorOnlyHistory, game.homeTeam, game.awayTeam, leagueAvg);
    if (!pred) continue;

    const homeScore = game.homeScore ?? 0;
    const awayScore = game.awayScore ?? 0;
    const homeWon = homeScore > awayScore;
    const predictedHomeWin = pred.favoredSide === 'Home';
    const hit = predictedHomeWin === homeWon;

    // Spread grading: margin from OUR PICK's perspective (positive = won
    // by that much, negative = lost by that much). Covers a +3.5 handicap
    // if margin >= -3 (win outright, or lose by 3 or fewer).
    const pickedMargin = predictedHomeWin ? (homeScore - awayScore) : (awayScore - homeScore);
    const spreadHit = pickedMargin >= -3;

    tested++;
    if (hit) hits++;
    results.push({ confidence: pred.confidence, hit, spreadHit });
  }

  console.log(`\nMoneyline backtest results: ${hits}/${tested} correct (${tested > 0 ? ((hits / tested) * 100).toFixed(1) : 0}%)`);
  const spreadHits = results.filter(r => r.spreadHit).length;
  console.log(`+3.5 handicap backtest results: ${spreadHits}/${tested} correct (${tested > 0 ? ((spreadHits / tested) * 100).toFixed(1) : 0}%)`);

  printConfidenceBuckets(results, 'hit', 'Moneyline');
  printConfidenceBuckets(results, 'spreadHit', '+3.5 Handicap');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[NflBacktest] Fatal error:', err.message);
    process.exit(1);
  });
}