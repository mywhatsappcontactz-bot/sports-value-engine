// src/cli/commands/stats.ts
import { getDb } from '../../core/database/db';
import { Repository } from '../../core/database/repository';

function run() {
  const db = getDb();
  const repo = new Repository(db);

  const clv = repo.getCLVSummary();
  const allBets = repo.getValueBets();
  const pending = allBets.filter(b => b.status === 'pending').length;
  const won     = allBets.filter(b => b.status === 'won').length;
  const lost    = allBets.filter(b => b.status === 'lost').length;
  const closed  = allBets.filter(b => b.status === 'closed').length; // Added for completeness

  const avgEdge = allBets.length
    ? allBets.reduce((s, b) => s + b.edge, 0) / allBets.length
    : 0;

  console.log('\n\x1b[1m\x1b[35m' + '═'.repeat(50) + '\x1b[0m');
  console.log('\x1b[1m\x1b[35m   📈 ENGINE PERFORMANCE STATS\x1b[0m');
  console.log('\x1b[1m\x1b[35m' + '═'.repeat(50) + '\x1b[0m\n');

  console.log('   BET HISTORY');
  console.log('   ' + '─'.repeat(30));
  console.log(`   Total bets   : ${allBets.length}`);
  console.log(`   Pending      : \x1b[33m${pending}\x1b[0m`);
  console.log(`   Closed (CLV) : \x1b[36m${closed}\x1b[0m`);
  console.log(`   Won          : \x1b[32m${won}\x1b[0m`);
  console.log(`   Lost         : \x1b[31m${lost}\x1b[0m`);
  console.log(`   Avg edge     : ${(avgEdge * 100).toFixed(2)}%`);

  console.log('\n   CLV TRACKING');
  console.log('   ' + '─'.repeat(30));
  if (clv.totalBets === 0) {
    console.log('   \x1b[90mNo CLV records yet.\x1b[0m');
  } else {
    // Convert clv.avgCLV to percentage for display: e.g. 0.0526 -> 5.26%
    const avgClvPct = (clv.avgCLV * 100).toFixed(2);
    console.log(`   Total tracked : ${clv.totalBets}`);
    console.log(`   Positive CLV  : \x1b[32m${clv.positiveCLV}\x1b[0m`);
    console.log(`   Avg CLV       : ${clv.avgCLV >= 0 ? '\x1b[32m' : '\x1b[31m'}${avgClvPct}%\x1b[0m`);
  }

  console.log('\n\x1b[35m' + '═'.repeat(50) + '\x1b[0m\n');
}

run();