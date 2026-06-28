// src/core/utils/telegramNotifier.ts
import { EngineResult } from '../engine/valueEngine';
import { Tip } from '../engine/tipScanner';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

async function sendMessage(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[Telegram] Missing BOT_TOKEN or CHAT_ID — skipping notification');
    return;
  }

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

export async function notifyValueBets(result: EngineResult, sport: string): Promise<void> {
  if (!result.valueBets.length) return;

  const lines: string[] = [];
  lines.push(`⚡ <b>VALUE BETS — ${sport.toUpperCase()}</b>`);
  lines.push(`Found: ${result.valueBets.length} bet(s)\n`);

  for (const bet of result.valueBets as any[]) {
    const teams = bet.homeTeam && bet.awayTeam ? `${bet.homeTeam} vs ${bet.awayTeam}` : '';
    lines.push(`🟢 <b>${teams}</b>`);
    lines.push(`Market: ${bet.market} | Selection: ${bet.selection}`);
    lines.push(`Bookmaker: ${bet.bookmaker} @ <b>${bet.bookmakerOdds}</b>`);
    lines.push(`Edge: ${(bet.edge * 100).toFixed(2)}% | Conf: ${(bet.confidence * 100).toFixed(1)}% | Kelly: ${(bet.kellyStake * 100).toFixed(2)}%`);
    lines.push('');
  }

  await sendMessage(lines.join('\n'));
}

export async function notifyTips(tips: Tip[]): Promise<void> {
  if (!tips.length) return;

  const lines: string[] = [];
  lines.push(`🎯 <b>HIGH CONFIDENCE TIPS</b>`);
  lines.push(`Found: ${tips.length} tip(s)\n`);

  for (const tip of tips) {
    const kickoff = new Date(tip.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    lines.push(`📌 <b>${tip.homeTeam} vs ${tip.awayTeam}</b>`);
    lines.push(`${tip.league} | KO: ${kickoff} | ${tip.hoursToKickoff}h away`);
    lines.push(`▶ <b>${tip.targetSelection}</b> @ ${tip.localOdds} (${tip.localBookmaker})`);
    lines.push(`Confidence: ${tip.confidence}% | Drop: ${tip.oddsDropPct}%`);
    lines.push(`Signal: ${tip.signal}`);
    lines.push('');
  }

  await sendMessage(lines.join('\n'));
}

export async function notifySilent(sport: string): Promise<void> {
  // Don't spam when nothing found — stay silent
}