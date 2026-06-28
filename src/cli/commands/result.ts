// src/cli/commands/result.ts
process.env.CLI_SILENT = 'true';

import { getDb } from '../../core/database/db';
import { v4 as uuidv4 } from 'uuid';

const db = getDb();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

async function sendMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
  });
}

// ─── BANKROLL ────────────────────────────────────────────────────────────────

function getBankroll(): any {
  return db.prepare('SELECT * FROM bankroll WHERE id = 1').get();
}

function updateBankroll(profitLoss: number, result: 'won' | 'lost' | 'void', stake: number): void {
  const b = getBankroll();
  const newBalance = b.balance + profitLoss;
  const won   = result === 'won'  ? b.totalWon  + 1 : b.totalWon;
  const lost  = result === 'lost' ? b.totalLost + 1 : b.totalLost;
  const voided = result === 'void' ? b.totalVoid + 1 : b.totalVoid;
  const staked = result === 'void' ? b.totalStaked : b.totalStaked + stake;

  db.prepare(`
    UPDATE bankroll SET
      balance = ?,
      totalBets = totalBets + ?,
      totalWon = ?,
      totalLost = ?,
      totalVoid = ?,
      totalStaked = ?,
      totalProfit = totalProfit + ?,
      updatedAt = ?
    WHERE id = 1
  `).run(
    newBalance,
    result === 'void' ? 0 : 1,
    won, lost, voided, staked,
    profitLoss,
    new Date().toISOString()
  );
}

// ─── LOG BET ─────────────────────────────────────────────────────────────────

function logPendingBet(
  betType: 'value_bet' | 'tip',
  refId: string,
  matchId: string,
  homeTeam: string,
  awayTeam: string,
  league: string,
  sport: string,
  selection: string,
  bookmaker: string,
  odds: number,
  stake: number,
): string {
  const b = getBankroll();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO bet_results (
      id, betType, refId, matchId, homeTeam, awayTeam, league, sport,
      selection, bookmaker, odds, stake, result, profitLoss,
      bankrollBefore, bankrollAfter
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
  `).run(id, betType, refId, matchId, homeTeam, awayTeam, league, sport,
    selection, bookmaker, odds, stake, b.balance, b.balance);

  return id;
}

// ─── SETTLE BET ──────────────────────────────────────────────────────────────

async function settleBet(betId: string, result: 'won' | 'lost' | 'void'): Promise<void> {
  const bet = db.prepare('SELECT * FROM bet_results WHERE id = ?').get(betId) as any;

  if (!bet) {
    console.error(`❌ Bet not found: ${betId}`);
    process.exit(1);
  }

  if (bet.result !== 'pending') {
    console.error(`❌ Bet already settled as: ${bet.result}`);
    process.exit(1);
  }

  const b = getBankroll();
  let profitLoss = 0;

  if (result === 'won') {
    profitLoss = parseFloat(((bet.odds - 1) * bet.stake).toFixed(2));
  } else if (result === 'lost') {
    profitLoss = -bet.stake;
  } else {
    profitLoss = 0; // void — stake returned
  }

  const bankrollAfter = parseFloat((b.balance + profitLoss).toFixed(2));

  db.prepare(`
    UPDATE bet_results SET
      result = ?,
      profitLoss = ?,
      bankrollAfter = ?,
      settledAt = ?
    WHERE id = ?
  `).run(result, profitLoss, bankrollAfter, new Date().toISOString(), betId);

  updateBankroll(profitLoss, result, bet.stake);

  const emoji = result === 'won' ? '✅' : result === 'lost' ? '❌' : '↩️';
  const pl = profitLoss >= 0 ? `+₦${profitLoss}` : `-₦${Math.abs(profitLoss)}`;

  const msg = [
    `${emoji} <b>BET SETTLED</b>`,
    ``,
    `${bet.homeTeam} vs ${bet.awayTeam}`,
    `Selection: ${bet.selection} @ ${bet.odds}`,
    `Stake: ₦${bet.stake} | Result: <b>${result.toUpperCase()}</b>`,
    `P&L: <b>${pl}</b>`,
    ``,
    `💰 Bankroll: ₦${b.balance.toLocaleString()} → ₦${bankrollAfter.toLocaleString()}`,
  ].join('\n');

  console.log(msg.replace(/<[^>]+>/g, ''));
  await sendMessage(msg);
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

async function printSummary(): Promise<void> {
  const b = getBankroll() as any;
  const bets = db.prepare(`SELECT * FROM bet_results WHERE result != 'pending' ORDER BY settledAt DESC LIMIT 10`).all() as any[];

  const roi = b.totalStaked > 0
    ? ((b.totalProfit / b.totalStaked) * 100).toFixed(2)
    : '0.00';

  const hitRate = (b.totalWon + b.totalLost) > 0
    ? ((b.totalWon / (b.totalWon + b.totalLost)) * 100).toFixed(1)
    : '0.0';

  const growth = (((b.balance - b.startingBalance) / b.startingBalance) * 100).toFixed(2);
  const growthSign = b.balance >= b.startingBalance ? '+' : '';

  const lines = [
    `📊 <b>ROI SUMMARY</b>`,
    ``,
    `💰 Bankroll : ₦${b.balance.toLocaleString()} (${growthSign}${growth}%)`,
    `📈 ROI      : ${roi}%`,
    `🎯 Hit Rate : ${hitRate}%`,
    ``,
    `Total Bets  : ${b.totalBets}`,
    `Won         : ${b.totalWon}`,
    `Lost        : ${b.totalLost}`,
    `Void        : ${b.totalVoid}`,
    `Total Staked: ₦${b.totalStaked.toLocaleString()}`,
    `Total P&L   : ${b.totalProfit >= 0 ? '+' : ''}₦${b.totalProfit.toLocaleString()}`,
  ];

  if (bets.length) {
    lines.push(``, `<b>Last ${bets.length} settled bets:</b>`);
    for (const bet of bets) {
      const emoji = bet.result === 'won' ? '✅' : bet.result === 'lost' ? '❌' : '↩️';
      const pl = bet.profitLoss >= 0 ? `+₦${bet.profitLoss}` : `-₦${Math.abs(bet.profitLoss)}`;
      lines.push(`${emoji} ${bet.homeTeam} vs ${bet.awayTeam} | ${bet.selection} | ${pl}`);
    }
  }

  const msg = lines.join('\n');
  console.log(msg.replace(/<[^>]+>/g, ''));
  await sendMessage(msg);
}

// ─── LIST PENDING ─────────────────────────────────────────────────────────────

function listPending(): void {
  const bets = db.prepare(`
    SELECT br.*, m.startTime FROM bet_results br
    JOIN matches m ON br.matchId = m.id
    WHERE br.result = 'pending'
    ORDER BY m.startTime ASC
  `).all() as any[];

  if (!bets.length) {
    console.log('No pending bets.');
    return;
  }

  console.log(`\n📋 PENDING BETS (${bets.length})\n`);
  console.log('ID'.padEnd(10) + 'TYPE'.padEnd(12) + 'MATCH'.padEnd(40) + 'SELECTION'.padEnd(15) + 'ODDS'.padEnd(8) + 'STAKE');
  console.log('─'.repeat(95));

  for (const bet of bets) {
    const shortId = bet.id.slice(0, 8);
    const match = `${bet.homeTeam} vs ${bet.awayTeam}`.slice(0, 38);
    console.log(
      shortId.padEnd(10) +
      bet.betType.padEnd(12) +
      match.padEnd(40) +
      bet.selection.padEnd(15) +
      String(bet.odds).padEnd(8) +
      `₦${bet.stake}`
    );
  }
  console.log();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const [,, command, ...args] = process.argv;

  switch (command) {
    case 'won':
    case 'lost':
    case 'void': {
      const betId = args[0];
      if (!betId) {
        console.error('Usage: result.ts won|lost|void <betId>');
        process.exit(1);
      }
      // Support short ID (first 8 chars)
      const fullBet = db.prepare(`SELECT id FROM bet_results WHERE id LIKE ?`).get(betId + '%') as any;
      const resolvedId = fullBet ? fullBet.id : betId;
      await settleBet(resolvedId, command as 'won' | 'lost' | 'void');
      break;
    }

    case 'summary':
      await printSummary();
      break;

    case 'pending':
      listPending();
      break;

    default:
      console.log(`
Usage:
  npx ts-node src/cli/commands/result.ts pending           — list all pending bets
  npx ts-node src/cli/commands/result.ts won <betId>       — mark bet as won
  npx ts-node src/cli/commands/result.ts lost <betId>      — mark bet as lost
  npx ts-node src/cli/commands/result.ts void <betId>      — mark bet as void
  npx ts-node src/cli/commands/result.ts summary           — view ROI + send to Telegram
      `);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});