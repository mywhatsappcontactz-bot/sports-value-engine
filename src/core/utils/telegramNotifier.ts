// src/core/utils/telegramNotifier.ts
import { getDb } from '../database/db';
import { EngineResult } from '../engine/valueEngine';
import { Tip } from '../engine/tipScanner';
import { v4 as uuidv4 } from 'uuid';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

const db = getDb();

// ─── TELEGRAM ────────────────────────────────────────────────────────────────

const TELEGRAM_MAX_LENGTH = 4000; // Telegram's real limit is 4096; leave margin

async function sendMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] Missing BOT_TOKEN or CHAT_ID — skipping notification');
    return;
  }

  // Telegram rejects any single message over 4096 chars outright — this
  // was the actual cause of tips never arriving (48 tips in one message
  // easily exceeds it). Split into multiple messages instead of failing
  // silently on the whole batch.
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_MAX_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', TELEGRAM_MAX_LENGTH);
    if (splitAt <= 0) splitAt = TELEGRAM_MAX_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  chunks.push(remaining);

  for (const chunk of chunks) {
    await sendSingleMessage(chunk);
  }
}

async function sendSingleMessage(text: string): Promise<void> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[Telegram] Failed to send message:', err);
  }
}

// ─── BANKROLL ────────────────────────────────────────────────────────────────

function getBankroll(): any {
  return db.prepare('SELECT * FROM bankroll WHERE id = 1').get();
}

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
  if (!b) return '';
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

function isDuplicateBet(betType: 'value_bet' | 'tip', matchId: string, selection: string): boolean {
  const existing = db.prepare(`
    SELECT id FROM bet_results
    WHERE betType = ? AND matchId = ? AND selection = ?
    AND result IN ('pending', 'won', 'lost')
  `).get(betType, matchId, selection);
  return !!existing;
}


// ─── VALUE BETS ──────────────────────────────────────────────────────────────

export async function notifyValueBets(result: EngineResult, sport: string): Promise<void> {
  if (!result.valueBets.length) return;

  const newBets = [];

  for (const bet of result.valueBets as any[]) {
    // Skip duplicates
    if (isDuplicateBet('value_bet', bet.matchId, bet.selection)) continue;

    const b = getBankroll();
    const stakeNaira = b ? parseFloat((bet.kellyStake * b.balance).toFixed(2)) : 0;

    const betId = logPendingBet(
      'value_bet',
      bet.id || uuidv4(),
      bet.matchId,
      bet.homeTeam || '',
      bet.awayTeam || '',
      bet.league || sport,
      sport,
      bet.selection,
      bet.bookmaker,
      bet.bookmakerOdds,
      stakeNaira,
    );

    const shortId = betId.slice(0, 8);
    const teams = bet.homeTeam && bet.awayTeam ? `${bet.homeTeam} vs ${bet.awayTeam}` : '';

    newBets.push({ bet, stakeNaira, shortId, teams });
  }

  if (!newBets.length) return;

  const lines: string[] = [];
  lines.push(`⚡ <b>VALUE BETS — ${sport.toUpperCase()}</b>`);
  lines.push(`Found: ${newBets.length} new bet(s)\n`);

  for (const { bet, stakeNaira, shortId, teams } of newBets) {
    lines.push(`🟢 <b>${teams}</b>`);
    lines.push(`Market: ${bet.market} | Selection: ${bet.selection}`);
    lines.push(`Bookmaker: ${bet.bookmaker} @ <b>${bet.bookmakerOdds}</b>`);
    lines.push(`Edge: ${(bet.edge * 100).toFixed(2)}% | Conf: ${(bet.confidence * 100).toFixed(1)}% | Kelly: ${(bet.kellyStake * 100).toFixed(2)}%`);
    lines.push(`Stake: ₦${stakeNaira.toLocaleString()}`);
    lines.push(`Bet ID: <code>${shortId}</code>`);
    lines.push('');
  }

  await sendMessage(lines.join('\n'));
}

// ─── TIPS ────────────────────────────────────────────────────────────────────

export async function notifyTips(tips: Tip[]): Promise<void> {
  if (!tips.length) return;

  // Cap to top picks by confidence — sending all 40+ tips is both
  // overwhelming to read and, before the chunking fix above, was the
  // direct cause of Telegram silently rejecting the message entirely.
  const MAX_TIPS_TO_NOTIFY = 10;
  const topTips = [...tips]
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_TIPS_TO_NOTIFY);

  const newTips = [];

  for (const tip of topTips) {
    if (tip.localOdds === null || tip.localBookmaker === null) {
      // No live price available — still worth showing as a prediction,
      // but nothing to stake or track in bet_results.
      newTips.push({ tip, stake: null, shortId: null });
      continue;
    }

    // Skip duplicates — same match + selection already pending
    if (isDuplicateBet('tip', tip.matchId, tip.targetSelection)) continue;

    const stake = 1000;

    const betId = logPendingBet(
      'tip',
      `${tip.matchId}_${tip.targetSelection}`,
      tip.matchId,
      tip.homeTeam,
      tip.awayTeam,
      tip.league,
      tip.sport,
      tip.targetSelection,
      tip.localBookmaker,
      tip.localOdds,
      stake,
    );

    const shortId = betId.slice(0, 8);
    newTips.push({ tip, stake, shortId });
  }

  if (!newTips.length) return;

  const lines: string[] = [];
  lines.push(`🎯 <b>HIGH CONFIDENCE TIPS</b>`);
  lines.push(`Found: ${newTips.length} new tip(s)\n`);

  for (const { tip, stake, shortId } of newTips) {
    const kickoff = new Date(tip.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    lines.push(`📌 <b>${tip.homeTeam} vs ${tip.awayTeam}</b> <i>(${tip.sport})</i>`);
    lines.push(`${tip.league} | KO: ${kickoff} | ${tip.hoursToKickoff}h away`);
    const priceText = tip.localOdds !== null
      ? `@ ${tip.localOdds} (${tip.localBookmaker})`
      : `(no live price currently offered)`;
    lines.push(`▶ <b>${tip.targetSelection}</b> (${tip.targetMarket}) ${priceText}`);
    lines.push(`Confidence: ${tip.confidence}% | Pinnacle: ${tip.pinnacleAvailable ? (tip.pinnacleAgrees ? 'agrees ✓' : 'diverges ⚠') : 'no line'}`);
    lines.push(`Signal: ${tip.signal}`);
    if (stake !== null && shortId !== null) {
      lines.push(`Stake: ₦${stake.toLocaleString()} | Bet ID: <code>${shortId}</code>`);
    }
    lines.push('');
  }

  await sendMessage(lines.join('\n'));
}