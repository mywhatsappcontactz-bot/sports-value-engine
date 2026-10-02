// src/cli/commands/quickScan.ts
//
// Lightweight companion to scan.ts — fetches ODDS ONLY (no stats
// scraping), then runs ValueEngine + TipScanner + Telegram notify exactly
// like scan.ts does. Safe to run frequently (every 15-30 min) since it
// never touches soccerstats.com or basketball-reference — only TheOddsAPI
// and your own local database.
//
// Intended split:
//   - quickScan.ts (this file)  -> every 15-30 min, odds + value bets + tips
//   - scan.ts (unchanged)       -> once or twice daily, full odds + stats scrape
//
// Point your frequent scheduled task (SportsScan) at this file instead of
// scan.ts. Keep scan.ts on a separate, much slower schedule (or run it
// manually) purely to refresh stats data.

process.env.CLI_SILENT = 'true';

import { getDb } from '../../core/database/db';
import { Repository } from '../../core/database/repository';
import { ValueEngine, EngineResult } from '../../core/engine/valueEngine';
import { RealFetcher, SUPPORTED_SPORTS, Sport } from '../../data-bridge/realFetcher';
import { recordClosingLines } from '../../core/utils/clvTracker';
import { logger } from '../../core/utils/logger';
import { recordOddsSnapshot } from '../../core/engine/oddsHistoryRecorder';
import { runTipScanner, Tip } from '../../core/engine/tipScanner';
import { notifyValueBets, notifyTips } from '../../core/utils/telegramNotifier';

// ─── DISPLAY HELPERS (same as scan.ts) ────────────────────────────────

function edgeBar(edge: number): string {
  const filled = Math.min(Math.round(edge * 200), 20);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function printHeader(sport: string) {
  console.log('\n' + '═'.repeat(60));
  console.log(`   ⚡ QUICK SCAN (odds only) — ${sport.toUpperCase()}`);
  console.log('═'.repeat(60));
}

function printResults(result: EngineResult, sport: string) {
  printHeader(sport);
  console.log(`\n   Matches processed : ${result.matchesProcessed}`);
  console.log(`   Bets evaluated    : ${result.betsEvaluated}`);
  console.log(`   Value bets found  : ${result.betsFound}`);
  console.log(`   Pinnacle flagged  : ${result.betsFlagged}`);
  console.log(`   Edge rejected     : ${result.betsRejected}`);
  console.log(`   Duration          : ${result.durationMs}ms`);

  if (result.valueBets.length === 0) {
    console.log('\n   No value bets found for this scan.\n');
    return;
  }

  console.log('\n   VALUE BETS (sorted by edge)\n');
  for (const bet of result.valueBets as any[]) {
    const edgePct = `${(bet.edge * 100).toFixed(2)}%`;
    const confPct = `${(bet.confidence * 100).toFixed(1)}%`;
    const teams = bet.homeTeam && bet.awayTeam ? `${bet.homeTeam} vs ${bet.awayTeam}` : '';
    console.log(`   ${teams}`);
    console.log(`   ● ${bet.market} ${bet.selection} @ ${bet.bookmakerOdds} (${bet.bookmaker}) — edge ${edgePct}, conf ${confPct}`);
    console.log(`     [${edgeBar(bet.edge)}]`);
  }
}

function printTips(tips: Tip[]) {
  console.log('\n' + '═'.repeat(60));
  console.log('   🎯 TIP SCANNER — HIGH CONFIDENCE PICKS');
  console.log('═'.repeat(60) + '\n');

  if (!tips.length) {
    console.log('   No qualifying tips found.\n');
    return;
  }

  for (const tip of tips) {
    const kickoff = new Date(tip.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    console.log(`\n   ${tip.homeTeam} vs ${tip.awayTeam} (${tip.sport})`);
    console.log(`   ${tip.league} | KO: ${kickoff} | ${tip.hoursToKickoff}h away`);
    const priceText = tip.localOdds !== null
      ? `@ ${tip.localOdds} (${tip.localBookmaker})`
      : `(no live price — fair odds ~${tip.impliedFairOdds})`;
    console.log(`   ▶ ${tip.targetSelection} (${tip.targetMarket}) ${priceText}`);
    console.log(`   Confidence : ${tip.confidence}%`);
    console.log(`   Signal     : ${tip.signal}`);
  }
  console.log('\n' + '═'.repeat(60) + '\n');
}

// ─── MAIN ─────────────────────────────────────────────────────────────

async function runQuickScan(sportArg?: string) {
  const sportsToScan: Sport[] = (sportArg && sportArg !== 'all')
    ? [sportArg as Sport]
    : [...SUPPORTED_SPORTS];

  for (const s of sportsToScan) {
    if (!SUPPORTED_SPORTS.includes(s)) {
      console.error(`Unknown sport: "${s}". Valid: ${SUPPORTED_SPORTS.join(', ')}, all`);
      process.exit(1);
    }
  }

  const fetcher = new RealFetcher();
  const repo = new Repository(getDb());

  repo.markOldMatchesAsCompleted();

  for (const sport of sportsToScan) {
    console.log(`\n[quickScan] Fetching odds only for ${sport} (no stats scrape)...`);
    // fetchStats=false — skips soccerstats.com / basketball-reference /
    // tennis-abstract entirely. Only TheOddsAPI is called here, plus
    // whatever's already in the DB from the last full scan.ts run.
    const fetchResult = await fetcher.fetchSport(sport, false);
    console.log(`[quickScan] ${fetchResult.matchesSaved} matches, ${fetchResult.oddsSaved} odds (stats untouched this run)`);

    const engine = new ValueEngine(repo);
    const result = await engine.run(sport);
    printResults(result, sport);

    await notifyValueBets(result, sport);
  }

  logger.info('[quickScan] Recording Pinnacle odds snapshot...');
  recordOddsSnapshot();

  logger.info('[quickScan] Running CLV tracker...');
  await recordClosingLines(repo);

  logger.info('[quickScan] Running tip scanner...');
  const tips = runTipScanner(72);
  printTips(tips);
  await notifyTips(tips);
  logger.info(`[quickScan] Complete — ${tips.length} tips found.`);
}

const sportArg = process.argv[2];
runQuickScan(sportArg).catch(err => {
  logger.error('[quickScan] Failed', { error: err.message });
  process.exit(1);
});