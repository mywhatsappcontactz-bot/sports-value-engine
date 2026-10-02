// src/core/engine/sbroNhlMoneylineEquityCurve.ts
//
// Checks the BANKROLL PATH of the calibrated moneyline model.
// It answers: "Did we ever get to +₦1m profit before finishing negative?"
//
// Usage:
//   npx ts-node src/core/engine/sbroNhlMoneylineEquityCurve.ts "C:\...\nhl 2015 2016.txt"
//
// Change STAKE_NGN below if your normal flat stake is different.

import * as fs from 'fs';
import {
  computeHockeyRawMoneylineProb,
  applyHockeyIsotonicCalibration,
} from './probabilityModel';

const MIN_PRIOR_GAMES = 5;
const FORM_WINDOW = 10;
const STAKE_NGN = 100000; // change this if your flat stake is different

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlMoneylineEquityCurve.ts <sbro-file.txt>');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

interface SbroRow {
  date: string;
  vh: 'V' | 'H' | 'N';
  team: string;
  final: number;
  openMl: number;
}

function parseRows(text: string): SbroRow[] {
  const rows: SbroRow[] = [];

  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 16 || !/^\d+$/.test(fields[0])) continue;

    const vh = fields[2];
    if (vh !== 'V' && vh !== 'H' && vh !== 'N') continue;

    const n = (s: string) => parseFloat(s);
    const final = n(fields[7]);
    const openMl = n(fields[8]);

    if (isNaN(final) || isNaN(openMl)) continue;

    rows.push({
      date: fields[0],
      vh: vh as 'V' | 'H' | 'N',
      team: fields[3],
      final,
      openMl,
    });
  }

  return rows;
}

interface Game {
  seq: number;
  dateLabel: string;
  awayTeam: string;
  awayScore: number;
  awayOpenMl: number;
  homeTeam: string;
  homeScore: number;
  homeOpenMl: number;
}

function pairRowsIntoGames(rows: SbroRow[]): Game[] {
  const games: Game[] = [];

  for (let i = 0; i < rows.length - 1; i += 2) {
    let a = rows[i];
    let b = rows[i + 1];

    if (a.date !== b.date) {
      i -= 1;
      continue;
    }

    if (a.vh === 'H' && b.vh === 'V') {
      const tmp = a;
      a = b;
      b = tmp;
    }

    if (!(a.vh === 'V' && b.vh === 'H')) continue;

    games.push({
      seq: games.length,
      dateLabel: a.date,
      awayTeam: a.team,
      awayScore: a.final,
      awayOpenMl: a.openMl,
      homeTeam: b.team,
      homeScore: b.final,
      homeOpenMl: b.openMl,
    });
  }

  return games;
}

function parseMonthDay(dateLabel: string): { month: number; day: number } {
  const s = dateLabel.trim();
  if (s.length === 3) {
    return { month: parseInt(s[0], 10), day: parseInt(s.slice(1), 10) };
  }
  return { month: parseInt(s.slice(0, 2), 10), day: parseInt(s.slice(2), 10) };
}

function isPreseasonNoise(dateLabel: string): boolean {
  const { month, day } = parseMonthDay(dateLabel);
  return month === 8 || (month === 9 && day < 15);
}

interface TeamRecord {
  seq: number;
  opp: string;
  won: boolean;
}

function buildHistory(games: Game[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();

  const push = (team: string, rec: TeamRecord) => {
    if (!hist.has(team)) hist.set(team, []);
    hist.get(team)!.push(rec);
  };

  for (const g of games) {
    push(g.homeTeam, {
      seq: g.seq,
      opp: g.awayTeam,
      won: g.homeScore > g.awayScore,
    });

    push(g.awayTeam, {
      seq: g.seq,
      opp: g.homeTeam,
      won: g.awayScore > g.homeScore,
    });
  }

  return hist;
}

function winRate(recs: TeamRecord[]): number {
  if (!recs.length) return 0.5;
  const recent = recs.slice(-FORM_WINDOW);
  return recent.filter(r => r.won).length / recent.length;
}

function h2hHomeWinRate(
  priorGames: Game[],
  homeTeam: string,
  awayTeam: string
): number {
  const meetings = priorGames.filter(g =>
    (g.homeTeam === homeTeam && g.awayTeam === awayTeam) ||
    (g.homeTeam === awayTeam && g.awayTeam === homeTeam)
  );

  if (!meetings.length) return 0.5;

  let homeWins = 0;

  for (const g of meetings) {
    const homeTeamWon =
      g.homeTeam === homeTeam
        ? g.homeScore > g.awayScore
        : g.awayScore > g.homeScore;

    if (homeTeamWon) homeWins++;
  }

  return homeWins / meetings.length;
}

function americanToDecimal(american: number): number {
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

interface Bet {
  seq: number;
  date: string;
  side: 'home' | 'away';
  modelP: number;
  odds: number;
  profit: number;
  cumulative: number;
}

async function main() {
  const text = fs.readFileSync(inputPath, 'utf8');
  const rows = parseRows(text);

  console.log(`Parsed ${rows.length} raw rows with real moneyline open prices.`);

  const allGames = pairRowsIntoGames(rows);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));

  console.log(
    `Paired into ${allGames.length} games (${allGames.length - games.length} deep-preseason excluded).`
  );

  const bets: Bet[] = [];
  let cumulative = 0;

  for (const game of games) {
    const priorGames = games.filter(g => g.seq < game.seq);
    const history = buildHistory(priorGames);

    const homeRecs = history.get(game.homeTeam) ?? [];
    const awayRecs = history.get(game.awayTeam) ?? [];

    if (homeRecs.length < MIN_PRIOR_GAMES || awayRecs.length < MIN_PRIOR_GAMES) {
      continue;
    }

    const homeWR = winRate(homeRecs);
    const awayWR = winRate(awayRecs);
    const h2hHWR = h2hHomeWinRate(
      priorGames,
      game.homeTeam,
      game.awayTeam
    );

    const rawHomeP = computeHockeyRawMoneylineProb(
      homeWR,
      awayWR,
      h2hHWR
    );

    // Pick the same side the raw model picks.
    const side: 'home' | 'away' = rawHomeP >= 0.5 ? 'home' : 'away';

    const rawSideP = side === 'home' ? rawHomeP : 1 - rawHomeP;
    const modelP = applyHockeyIsotonicCalibration(rawSideP);

    const american =
      side === 'home' ? game.homeOpenMl : game.awayOpenMl;

    const decimalOdds = americanToDecimal(american);

    const won =
      side === 'home'
        ? game.homeScore > game.awayScore
        : game.awayScore > game.homeScore;

    const profit = won
      ? STAKE_NGN * (decimalOdds - 1)
      : -STAKE_NGN;

    cumulative += profit;

    bets.push({
      seq: game.seq,
      date: game.dateLabel,
      side,
      modelP,
      odds: decimalOdds,
      profit,
      cumulative,
    });
  }

  if (!bets.length) {
    console.log('No qualifying bets.');
    return;
  }

  let peak = 0;
  let peakBet = 0;
  let peakDate = '';
  let maxDrawdown = 0;
  let maxDrawdownBet = 0;
  let maxDrawdownDate = '';

  for (let i = 0; i < bets.length; i++) {
    const equity = bets[i].cumulative;

    if (equity > peak) {
      peak = equity;
      peakBet = i + 1;
      peakDate = bets[i].date;
    }

    const drawdown = peak - equity;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownBet = i + 1;
      maxDrawdownDate = bets[i].date;
    }
  }

  const finalProfit = bets[bets.length - 1].cumulative;

  console.log('\n================ EQUITY CURVE CHECK ================');
  console.log(`Flat stake: ₦${STAKE_NGN.toLocaleString()}`);
  console.log(`Qualifying bets: ${bets.length}`);
  console.log(`Final profit: ₦${finalProfit.toLocaleString()}`);
  console.log(`Highest profit reached: ₦${peak.toLocaleString()}`);
  console.log(`Peak occurred at bet #${peakBet} (date ${peakDate})`);
  console.log(`Maximum drawdown after a peak: ₦${maxDrawdown.toLocaleString()}`);
  console.log(`Largest drawdown reached at bet #${maxDrawdownBet} (date ${maxDrawdownDate})`);

  console.log('\n── ₦1 MILLION CHECK ──');

  if (peak >= 1_000_000) {
    const peakBetRecord = bets[peakBet - 1];
    console.log(
      `YES — the equity curve reached at least ₦1,000,000 profit.`
    );
    console.log(
      `Peak: ₦${peak.toLocaleString()} at bet #${peakBetRecord.seq + 1}, date ${peakBetRecord.date}.`
    );
  } else {
    console.log(
      `NO — the equity curve never reached ₦1,000,000 profit.`
    );
    console.log(
      `Highest point was ₦${peak.toLocaleString()} profit.`
    );
  }

  console.log('\n── SIMPLE CHECKPOINTS ──');

  const checkpoints = [100, 250, 500, 750, 1000];

  for (const n of checkpoints) {
    if (n <= bets.length) {
      const b = bets[n - 1];
      console.log(
        `After ${n.toString().padStart(4)} bets: ₦${b.cumulative.toLocaleString()}`
      );
    }
  }

  console.log('====================================================');
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
