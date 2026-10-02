// src/core/engine/hockeyCalibrationCheck.ts
//
// Answers a specific question left open after the odds backtest: is the
// model systematically OVERCONFIDENT on heavily-favored picks
// specifically (the pattern all 3 small real-odds samples hinted at —
// every qualifying tip was a heavy favorite, and all 3 samples lost
// money)? This doesn't need any odds data to check — it uses real
// EliteProspects results we already have, just without throwing away
// the sub-0.75-confidence predictions the way hockeyBacktest1.ts does.
//
// For EVERY game with enough prior history (same MIN_PRIOR_GAMES cutoff
// as hockeyBacktest1.ts), computes the model's predicted confidence and
// buckets it into 5-point ranges (50-55%, 55-60%, ... 95-100%). For each
// bucket, compares the model's average claimed confidence against the
// REAL observed hit rate in that bucket. Good calibration = the two
// numbers stay close at every confidence level. If observed hit rate is
// consistently BELOW claimed confidence in the high buckets specifically,
// that's the model overstating certainty on lopsided-looking games —
// exactly the pattern to check for.
//
// Uses the exact same prediction functions as hockeyBacktest1.ts
// (imported, not re-derived) and the same 4 confirmed seasons across
// all 14 leagues.

import {
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';
import {
  buildHistory,
  h2hHomeWinRate,
  predictMoneyline,
  MIN_PRIOR_GAMES,
} from './hockeyBacktest1';

const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];
const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP);

interface Prediction {
  confidence: number; // 0.5-1.0, max(p, 1-p)
  hit: boolean;
}

function bucketLabel(confidence: number): string {
  const pct = confidence * 100;
  const lower = Math.floor(pct / 5) * 5;
  const upper = lower + 5;
  return `${lower}-${upper}%`;
}

async function main() {
  const allPredictions: Prediction[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    console.log(`Fetching ${leagueName}...`);
    let leagueGames: EPGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        leagueGames.push(...games);
      } catch (err: any) {
        console.error(`  ${season} FAILED: ${err.message}`);
      }
    }

    const seen = new Set<number>();
    const deduped = leagueGames.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
    const completedOnly = deduped.filter(g => g.isCompleted);
    const sorted = completedOnly.sort((a, b) => a.date.localeCompare(b.date));

    for (const game of sorted) {
      const priorGames = sorted.filter(g => g.date < game.date);
      const history = buildHistory(priorGames);

      const homeRecordsAll = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
      const awayRecordsAll = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));

      if (homeRecordsAll.length < MIN_PRIOR_GAMES || awayRecordsAll.length < MIN_PRIOR_GAMES) continue;

      const h2hHWR = h2hHomeWinRate(priorGames, game.homeTeam, game.awayTeam);
      const homeWinProb = predictMoneyline(homeRecordsAll, awayRecordsAll, h2hHWR);
      const selection: 'Home' | 'Away' = homeWinProb >= 0.5 ? 'Home' : 'Away';
      const confidence = Math.max(homeWinProb, 1 - homeWinProb);

      const homeWon = game.homeScore! > game.awayScore!;
      const hit = selection === 'Home' ? homeWon : !homeWon;

      allPredictions.push({ confidence, hit });
    }
  }

  console.log(`\n\nTotal predictions with enough prior history: ${allPredictions.length}\n`);

  const buckets = new Map<string, Prediction[]>();
  for (const p of allPredictions) {
    const label = bucketLabel(p.confidence);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label)!.push(p);
  }

  const sortedLabels = Array.from(buckets.keys()).sort((a, b) => parseInt(a) - parseInt(b));

  console.log('========== CALIBRATION: CLAIMED CONFIDENCE vs REAL HIT RATE ==========');
  console.log('Bucket       | Count | Avg Claimed Conf | Real Hit Rate | Gap (claimed - real)');
  console.log('-------------|-------|------------------|---------------|---------------------');
  for (const label of sortedLabels) {
    const preds = buckets.get(label)!;
    const avgClaimed = preds.reduce((s, p) => s + p.confidence, 0) / preds.length;
    const hits = preds.filter(p => p.hit).length;
    const realHitRate = hits / preds.length;
    const gap = avgClaimed - realHitRate;
    const gapFlag = gap > 0.10 ? '  <-- OVERCONFIDENT' : gap < -0.10 ? '  <-- UNDERCONFIDENT' : '';
    console.log(
      `${label.padEnd(12)} | ${String(preds.length).padEnd(5)} | ${(avgClaimed * 100).toFixed(1).padEnd(16)}% | ${(realHitRate * 100).toFixed(1).padEnd(13)}% | ${gap >= 0 ? '+' : ''}${(gap * 100).toFixed(1)}%${gapFlag}`
    );
  }

  console.log('\nInterpretation: if the high-confidence buckets (85%+) show a real hit rate');
  console.log('meaningfully BELOW the claimed confidence, that confirms the model overstates');
  console.log('certainty specifically on lopsided-looking games — which would explain why the');
  console.log('small real-odds samples lost money despite a "good enough" pooled hit rate.');

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('[HockeyCalibrationCheck] Fatal error:', err.message);
  process.exit(1);
});