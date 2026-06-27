// src/cli/commands/bets.ts
import { getDb } from '../../core/database/db';
import { Repository } from '../../core/database/repository';
import { ValueBet } from '../../core/database/schema';

// ─── DISPLAY ──────────────────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case 'pending':  return '\x1b[33m';
    case 'won':      return '\x1b[32m';
    case 'lost':     return '\x1b[31m';
    case 'void':     return '\x1b[90m';
    default:         return '\x1b[0m';
  }
}

function printBets(bets: ValueBet[], filter: string) {
  console.log('\n\x1b[1m\x1b[34m' + '═'.repeat(70) + '\x1b[0m');
  console.log(`\x1b[1m\x1b[34m   📋 VALUE BETS — ${filter.toUpperCase()}\x1b[0m`);
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(70) + '\x1b[0m\n');

  if (bets.length === 0) {
    console.log('  \x1b[90mNo bets found.\x1b[0m\n');
    return;
  }

  console.log(
    '  ' +
    'ID'.padEnd(10) +
    'MARKET'.padEnd(8) +
    'SEL'.padEnd(8) +
    'BOOK'.padEnd(14) +
    'ODDS'.padEnd(7) +
    'EDGE'.padEnd(8) +
    'KELLY'.padEnd(8) +
    'STATUS'
  );
  console.log('  ' + '─'.repeat(72));

  for (const bet of bets) {
    const color = statusColor(bet.status);
    console.log(
      '  ' +
      bet.id.slice(0, 8).padEnd(10) +
      bet.market.padEnd(8) +
      bet.selection.padEnd(8) +
      bet.bookmaker.padEnd(14) +
      String(bet.bookmakerOdds).padEnd(7) +
      `${(bet.edge * 100).toFixed(2)}%`.padEnd(8) +
      `${(bet.kellyStake * 100).toFixed(2)}%`.padEnd(8) +
      `${color}${bet.status}\x1b[0m`
    );
  }

  console.log('\n  ' + '─'.repeat(72));
  console.log(`  Total: ${bets.length} bet(s)\n`);
  console.log('\x1b[34m' + '═'.repeat(70) + '\x1b[0m\n');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function run() {
  const statusArg = process.argv[2]; // pending | won | lost | void | all
  const filter = statusArg || 'pending';

  const db = getDb();
  const repo = new Repository(db);
  const bets = filter === 'all' ? repo.getValueBets() : repo.getValueBets(filter);
  printBets(bets, filter);
}

run();