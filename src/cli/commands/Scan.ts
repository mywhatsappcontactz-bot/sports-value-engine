process.env.CLI_SILENT = 'true';

import { getDb } from '../../core/database/db';
import { Repository } from '../../core/database/repository';
import { ValueEngine, EngineResult } from '../../core/engine/valueEngine';
import { RealFetcher, SUPPORTED_SPORTS, Sport } from '../../data-bridge/realFetcher';
import { recordClosingLines } from '../../core/utils/clvTracker';
import { logger } from '../../core/utils/logger';
import { recordOddsSnapshot } from '../../core/engine/oddsHistoryRecorder';

// ─── DISPLAY HELPERS ──────────────────────────────────────────────────────────

function edgeBar(edge: number): string {
  const filled = Math.min(Math.round(edge * 200), 20);
  return '█'.repeat(filled) + '░'.repeat(20 - filled);
}

function printHeader(sport: string) {
  console.log('\n\x1b[1m\x1b[34m' + '═'.repeat(60) + '\x1b[0m');
  console.log(`\x1b[1m\x1b[34m   ⚡ VALUE SCAN — ${sport.toUpperCase()}\x1b[0m`);
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(60) + '\x1b[0m');
}

function printResults(result: EngineResult, sport: string) {
  printHeader(sport);

  console.log(`\n   Matches processed : ${result.matchesProcessed}`);
  console.log(`   Bets evaluated    : ${result.betsEvaluated}`);
  console.log(`   Value bets found  : \x1b[32m${result.betsFound}\x1b[0m`);
  console.log(`   Pinnacle flagged  : \x1b[33m${result.betsFlagged}\x1b[0m`);
  console.log(`   Edge rejected     : ${result.betsRejected}`);
  console.log(`   Duration          : ${result.durationMs}ms`);

  if (result.valueBets.length === 0) {
    console.log('\n   \x1b[33mNo value bets found for this scan.\x1b[0m\n');
    return;
  }

  console.log('\n   \x1b[1mVALUE BETS (sorted by edge)\x1b[0m\n');
  console.log(
    '   ' +
    'MARKET'.padEnd(8) +
    'SEL'.padEnd(8) +
    'BOOK'.padEnd(14) +
    'ODDS'.padEnd(7) +
    'EDGE'.padEnd(8) +
    'CONF'.padEnd(8) +
    'KELLY'
  );
  console.log('   ' + '─'.repeat(65));

  for (const bet of result.valueBets as any[]) {
    const edgePct  = `${(bet.edge * 100).toFixed(2)}%`;
    const kellyPct = `${(bet.kellyStake * 100).toFixed(2)}%`;
    const confPct  = `${(bet.confidence * 100).toFixed(1)}%`;
    const bar      = edgeBar(bet.edge);
    const teams    = bet.homeTeam && bet.awayTeam ? `${bet.homeTeam} vs ${bet.awayTeam}` : '';

    console.log(`   \x1b[36m${teams}\x1b[0m`);
    console.log(
      '   \x1b[32m●\x1b[0m ' +
      bet.market.padEnd(8) +
      bet.selection.padEnd(10) +
      bet.bookmaker.padEnd(14) +
      String(bet.bookmakerOdds).padEnd(7) +
      edgePct.padEnd(8) +
      confPct.padEnd(8) +
      kellyPct
    );
    console.log(`     \x1b[90m[${bar}]\x1b[0m`);
  }

  const avgEdge  = result.valueBets.reduce((s, b) => s + b.edge, 0) / result.valueBets.length;
  const avgKelly = result.valueBets.reduce((s, b) => s + b.kellyStake, 0) / result.valueBets.length;
  const avgConf  = result.valueBets.reduce((s, b) => s + b.confidence, 0) / result.valueBets.length;

  console.log('\n   ' + '─'.repeat(65));
  console.log(`   Avg edge: \x1b[32m${(avgEdge * 100).toFixed(2)}%\x1b[0m   Avg conf: ${(avgConf * 100).toFixed(1)}%   Avg kelly: ${(avgKelly * 100).toFixed(2)}%`);
  console.log('\n\x1b[34m' + '═'.repeat(60) + '\x1b[0m\n');
}

function printSummary(allResults: { sport: string; result: EngineResult }[]) {
  const totalBets    = allResults.reduce((s, r) => s + r.result.betsFound, 0);
  const totalMatches = allResults.reduce((s, r) => s + r.result.matchesProcessed, 0);
  const totalMs      = allResults.reduce((s, r) => s + r.result.durationMs, 0);

  console.log('\n\x1b[1m\x1b[35m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m\x1b[35m   📊 FULL SCAN SUMMARY — ALL SPORTS\x1b[0m');
  console.log('\x1b[1m\x1b[35m' + '═'.repeat(60) + '\x1b[0m\n');

  console.log('   ' + 'SPORT'.padEnd(14) + 'MATCHES'.padEnd(10) + 'VALUE BETS'.padEnd(12) + 'FLAGGED');
  console.log('   ' + '─'.repeat(44));

  for (const { sport, result } of allResults) {
    const indicator = result.betsFound > 0 ? '\x1b[32m✔\x1b[0m' : '\x1b[90m–\x1b[0m';
    console.log(
      `   ${indicator} ` +
      sport.padEnd(12) +
      String(result.matchesProcessed).padEnd(10) +
      String(result.betsFound).padEnd(12) +
      String(result.betsFlagged)
    );
  }

  console.log('\n   ' + '─'.repeat(44));
  console.log(`   Total value bets : \x1b[32m\x1b[1m${totalBets}\x1b[0m`);
  console.log(`   Total matches    : ${totalMatches}`);
  console.log(`   Total duration   : ${totalMs}ms`);
  console.log('\n\x1b[35m' + '═'.repeat(60) + '\x1b[0m\n');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function runScan(sportArg?: string) {
  const sportsToScan: Sport[] = (sportArg && sportArg !== 'all')
    ? [sportArg as Sport]
    : [...SUPPORTED_SPORTS];

  for (const s of sportsToScan) {
    if (!SUPPORTED_SPORTS.includes(s)) {
      console.error(`\x1b[31mUnknown sport: "${s}". Valid: ${SUPPORTED_SPORTS.join(', ')}, all\x1b[0m`);
      process.exit(1);
    }
  }

  const fetcher = new RealFetcher();
  const repo    = new Repository(getDb());

  // Clean up old matches before starting any processing
  repo.markOldMatchesAsCompleted();
  
  const allResults: { sport: string; result: EngineResult }[] = [];

  for (const sport of sportsToScan) {
    console.log(`\n\x1b[90m[scan] Fetching live data for ${sport}...\x1b[0m`);
    const fetchResult = await fetcher.fetchSport(sport);
    console.log(`\x1b[90m[scan] ${fetchResult.matchesSaved} matches, ${fetchResult.oddsSaved} odds, ${fetchResult.statsSaved} stats\x1b[0m`);

    const engine = new ValueEngine(repo);
    const result = await engine.run(sport);

    printResults(result, sport);
    allResults.push({ sport, result });
  }

  if (sportsToScan.length > 1) {
    printSummary(allResults);
  }
  // Record Pinnacle odds snapshot for tip scanner
logger.info('[scan] Recording Pinnacle odds snapshot...');
recordOddsSnapshot();
logger.info('[scan] Odds snapshot recorded.');

// Finalizing pipeline with CLV Tracking
logger.info('[scan] Running CLV tracker for upcoming matches...');
await recordClosingLines(repo);
logger.info('[scan] CLV tracking complete.');


}

const sportArg = process.argv[2];
runScan(sportArg).catch(err => {
  logger.error('[CLI] Scan failed', { error: err.message });
  process.exit(1);
});