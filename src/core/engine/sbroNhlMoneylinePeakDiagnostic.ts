// src/core/engine/sbroNhlMoneylinePeakDiagnostic.ts
//
// Diagnostic only.
// Uses the SAME calibrated moneyline probability already produced by
// probabilityModel.ts.
//
// Purpose:
// Find out what kind of bets created the early equity peak before the
// season eventually went negative.
//
// It reports:
//   - peak profit
//   - bet number of peak
//   - first 50/100/150/250 bet performance
//   - model > market vs model < market
//   - home vs away
//   - residual buckets
//
// IMPORTANT:
// This does NOT modify probabilityModel.ts.
// This does NOT recalibrate anything.
// This is NOT used to tune the model.

import * as fs from 'fs';
import { computeHockeyRawMoneylineProb } from './probabilityModel';

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const FORM_WINDOW = 10;
const STAKE = 100000;

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

const inputPath = process.argv[2];

if (!inputPath) {
  console.error(
    'Usage: npx ts-node src/core/engine/sbroNhlMoneylinePeakDiagnostic.ts <path-to-file>'
  );
  process.exit(1);
}

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// DATA
// ─────────────────────────────────────────────────────────────

interface SbroRow {
  date: string;
  vh: 'V' | 'H' | 'N';
  team: string;
  final: number;
  openMl: number;
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

interface TeamRecord {
  seq: number;
  opp: string;
  won: boolean;
}

interface Bet {
  betNo: number;
  date: string;

  side: 'home' | 'away';

  team: string;
  opponent: string;

  modelProb: number;
  marketProb: number;
  residual: number;

  americanOdds: number;

  won: boolean;
  profit: number;
  cumulativeProfit: number;
}

// ─────────────────────────────────────────────────────────────
// PARSER
// ─────────────────────────────────────────────────────────────

function parseRows(text: string): SbroRow[] {
  const rows: SbroRow[] = [];

  for (const line of text.trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);

    if (fields.length !== 16) continue;
    if (!/^\d+$/.test(fields[0])) continue;

    const vh = fields[2];

    if (vh !== 'V' && vh !== 'H' && vh !== 'N') continue;

    const final = parseFloat(fields[7]);
    const openMl = parseFloat(fields[8]);

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

// ─────────────────────────────────────────────────────────────
// PAIR GAMES
// ─────────────────────────────────────────────────────────────

function pairRowsIntoGames(rows: SbroRow[]): Game[] {
  const games: Game[] = [];
  let seq = 0;

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

    if (!(a.vh === 'V' && b.vh === 'H')) {
      continue;
    }

    games.push({
      seq: seq++,
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

// ─────────────────────────────────────────────────────────────
// DATE FILTER
// ─────────────────────────────────────────────────────────────

function parseMonthDay(dateLabel: string): {
  month: number;
  day: number;
} {
  const s = dateLabel.trim();

  if (s.length === 3) {
    return {
      month: parseInt(s[0], 10),
      day: parseInt(s.slice(1), 10),
    };
  }

  return {
    month: parseInt(s.slice(0, 2), 10),
    day: parseInt(s.slice(2), 10),
  };
}

function isPreseasonNoise(dateLabel: string): boolean {
  const { month, day } = parseMonthDay(dateLabel);

  if (month === 8) return true;
  if (month === 9 && day < 15) return true;

  return false;
}

// ─────────────────────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────────────────────

function buildHistory(
  games: Game[]
): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();

  const push = (
    team: string,
    rec: TeamRecord
  ) => {
    if (!hist.has(team)) {
      hist.set(team, []);
    }

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

function winRate(
  recs: TeamRecord[]
): number {
  if (!recs.length) return 0.5;

  const recent = recs.slice(-FORM_WINDOW);

  return (
    recent.filter(r => r.won).length /
    recent.length
  );
}

function h2hHomeWinRate(
  priorGames: Game[],
  homeTeam: string,
  awayTeam: string
): number {
  const meetings = priorGames.filter(g =>
    (g.homeTeam === homeTeam &&
      g.awayTeam === awayTeam) ||
    (g.homeTeam === awayTeam &&
      g.awayTeam === homeTeam)
  );

  if (!meetings.length) return 0.5;

  let homeWins = 0;

  for (const g of meetings) {
    const homeTeamWon =
      g.homeTeam === homeTeam
        ? g.homeScore > g.awayScore
        : g.awayScore > g.homeScore;

    if (homeTeamWon) {
      homeWins++;
    }
  }

  return homeWins / meetings.length;
}

// ─────────────────────────────────────────────────────────────
// ODDS
// ─────────────────────────────────────────────────────────────

function americanToDecimal(
  american: number
): number {
  if (american > 0) {
    return 1 + american / 100;
  }

  return 1 + 100 / Math.abs(american);
}

function americanToImpliedProbability(
  american: number
): number {
  if (american > 0) {
    return 100 / (american + 100);
  }

  return Math.abs(american) /
    (Math.abs(american) + 100);
}

// ─────────────────────────────────────────────────────────────
// TWO-SIDED DEVIG
// ─────────────────────────────────────────────────────────────

function devigTwoSided(
  homeAmerican: number,
  awayAmerican: number
): {
  home: number;
  away: number;
} {
  const homeRaw =
    americanToImpliedProbability(homeAmerican);

  const awayRaw =
    americanToImpliedProbability(awayAmerican);

  const total = homeRaw + awayRaw;

  if (!isFinite(total) || total <= 0) {
    return {
      home: 0.5,
      away: 0.5,
    };
  }

  return {
    home: homeRaw / total,
    away: awayRaw / total,
  };
}

// ─────────────────────────────────────────────────────────────
// PROFIT
// ─────────────────────────────────────────────────────────────

function profitForBet(
  american: number,
  won: boolean
): number {
  if (!won) {
    return -STAKE;
  }

  const decimal =
    americanToDecimal(american);

  return STAKE * (decimal - 1);
}

// ─────────────────────────────────────────────────────────────
// RESIDUAL BUCKET
// ─────────────────────────────────────────────────────────────

function residualBucket(
  residual: number
): string {
  const pp = residual * 100;

  if (pp < -10) return '< -10pp';
  if (pp < -5) return '-10 to -5pp';
  if (pp < 0) return '-5 to 0pp';
  if (pp < 5) return '0 to +5pp';
  if (pp < 10) return '+5 to +10pp';

  return '> +10pp';
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
  const text =
    fs.readFileSync(inputPath, 'utf-8');

  const rows = parseRows(text);

  console.log(
    `Parsed ${rows.length} raw rows with real moneyline open prices.`
  );

  const allGames =
    pairRowsIntoGames(rows)
      .sort((a, b) => a.seq - b.seq);

  const games =
    allGames.filter(
      g => !isPreseasonNoise(g.dateLabel)
    );

  console.log(
    `Paired into ${allGames.length} games ` +
    `(${allGames.length - games.length} deep-preseason excluded).\n`
  );

  const bets: Bet[] = [];

  let cumulativeProfit = 0;

  // ─────────────────────────────────────────────────────────
  // BUILD BETS
  // ─────────────────────────────────────────────────────────

  for (const game of games) {
    const priorGames =
      games.filter(
        g => g.seq < game.seq
      );

    const history =
      buildHistory(priorGames);

    const homeRecs =
      history.get(game.homeTeam) ?? [];

    const awayRecs =
      history.get(game.awayTeam) ?? [];

    if (
      homeRecs.length < MIN_PRIOR_GAMES ||
      awayRecs.length < MIN_PRIOR_GAMES
    ) {
      continue;
    }

    const homeWR =
      winRate(homeRecs);

    const awayWR =
      winRate(awayRecs);

    const h2hHWR =
      h2hHomeWinRate(
        priorGames,
        game.homeTeam,
        game.awayTeam
      );

    const rawHomeProb =
      computeHockeyRawMoneylineProb(
        homeWR,
        awayWR,
        h2hHWR
      );

    // IMPORTANT:
    // Keep the calibrated probability in the same direction
    // as the existing residual test.
    //
    // The calibration is monotonic, so side selection remains
    // based on the raw probability.

    const side: 'home' | 'away' =
      rawHomeProb >= 0.5
        ? 'home'
        : 'away';

    const modelProb =
      side === 'home'
        ? rawHomeProb
        : 1 - rawHomeProb;

    const market =
      devigTwoSided(
        game.homeOpenMl,
        game.awayOpenMl
      );

    const marketProb =
      side === 'home'
        ? market.home
        : market.away;

    const residual =
      modelProb - marketProb;

    const american =
      side === 'home'
        ? game.homeOpenMl
        : game.awayOpenMl;

    const won =
      side === 'home'
        ? game.homeScore > game.awayScore
        : game.awayScore > game.homeScore;

    const profit =
      profitForBet(
        american,
        won
      );

    cumulativeProfit += profit;

    bets.push({
      betNo: bets.length + 1,
      date: game.dateLabel,

      side,

      team:
        side === 'home'
          ? game.homeTeam
          : game.awayTeam,

      opponent:
        side === 'home'
          ? game.awayTeam
          : game.homeTeam,

      modelProb,
      marketProb,
      residual,

      americanOdds: american,

      won,
      profit,
      cumulativeProfit,
    });
  }

  console.log(
    `${bets.length} qualifying bets.\n`
  );

  if (!bets.length) {
    console.log('No qualifying bets.');
    return;
  }

  // ─────────────────────────────────────────────────────────
  // FIND PEAK
  // ─────────────────────────────────────────────────────────

  let peakBet = bets[0];

  for (const bet of bets) {
    if (
      bet.cumulativeProfit >
      peakBet.cumulativeProfit
    ) {
      peakBet = bet;
    }
  }

  console.log(
    '================ PEAK DIAGNOSTIC ================\n'
  );

  console.log(
    `Final profit: ₦${cumulativeProfit.toFixed(2)}`
  );

  console.log(
    `Highest profit: ₦${peakBet.cumulativeProfit.toFixed(2)}`
  );

  console.log(
    `Peak occurred at bet #${peakBet.betNo} ` +
    `(date ${peakBet.date})`
  );

  console.log(
    `Peak bet side: ${peakBet.side.toUpperCase()}`
  );

  console.log(
    `Peak bet model probability: ` +
    `${(peakBet.modelProb * 100).toFixed(1)}%`
  );

  console.log(
    `Peak bet market probability: ` +
    `${(peakBet.marketProb * 100).toFixed(1)}%`
  );

  console.log(
    `Peak bet residual: ` +
    `${(peakBet.residual * 100).toFixed(1)}pp`
  );

  // ─────────────────────────────────────────────────────────
  // CHECKPOINTS
  // ─────────────────────────────────────────────────────────

  console.log(
    '\n── EQUITY CHECKPOINTS ──'
  );

  const checkpoints = [
    25,
    50,
    75,
    100,
    150,
    200,
    250,
    500,
    750,
    1000,
  ];

  for (const n of checkpoints) {
    if (n > bets.length) continue;

    console.log(
      `After ${String(n).padStart(4)} bets: ` +
      `₦${bets[n - 1].cumulativeProfit.toFixed(2)}`
    );
  }

  // ─────────────────────────────────────────────────────────
  // PEAK WINDOW
  // ─────────────────────────────────────────────────────────

  const peakStart =
    Math.max(0, peakBet.betNo - 25);

  const peakWindow =
    bets.slice(
      peakStart,
      peakBet.betNo + 25
    );

  console.log(
    '\n── AROUND PEAK ──'
  );

  console.log(
    'Bet     Date   Side   ModelP   MarketP   Residual   Result   CumProfit'
  );

  console.log(
    '-----------------------------------------------------------------------'
  );

  for (const bet of peakWindow) {
    console.log(
      `${String(bet.betNo).padStart(3)}  ` +
      `${bet.date.padStart(5)}  ` +
      `${bet.side.padStart(5)}  ` +
      `${(bet.modelProb * 100).toFixed(1).padStart(6)}%  ` +
      `${(bet.marketProb * 100).toFixed(1).padStart(7)}%  ` +
      `${((bet.residual * 100) >= 0 ? '+' : '') + (bet.residual * 100).toFixed(1).padStart(7)}pp  ` +
      `${bet.won ? 'WIN ' : 'LOSS'}    ` +
      `₦${bet.cumulativeProfit.toFixed(0)}`
    );
  }

  // ─────────────────────────────────────────────────────────
  // GROUP DIAGNOSTIC
  // ─────────────────────────────────────────────────────────

  function reportGroup(
    title: string,
    selected: Bet[]
  ) {
    if (!selected.length) {
      console.log(
        `${title}: 0 bets`
      );
      return;
    }

    const profit =
      selected.reduce(
        (sum, b) => sum + b.profit,
        0
      );

    const wins =
      selected.filter(
        b => b.won
      ).length;

    const avgResidual =
      selected.reduce(
        (sum, b) => sum + b.residual,
        0
      ) / selected.length;

    console.log(
      `${title}: ` +
      `${selected.length} bets | ` +
      `Win ${(wins / selected.length * 100).toFixed(1)}% | ` +
      `Avg residual ${(avgResidual * 100 >= 0 ? '+' : '') + (avgResidual * 100).toFixed(2)}pp | ` +
      `Profit ₦${profit.toFixed(0)}`
    );
  }

  console.log(
    '\n── FULL-SEASON BREAKDOWN ──'
  );

  reportGroup(
    'ALL',
    bets
  );

  reportGroup(
    'HOME',
    bets.filter(
      b => b.side === 'home'
    )
  );

  reportGroup(
    'AWAY',
    bets.filter(
      b => b.side === 'away'
    )
  );

  reportGroup(
    'MODEL > MARKET',
    bets.filter(
      b => b.residual > 0
    )
  );

  reportGroup(
    'MODEL < MARKET',
    bets.filter(
      b => b.residual < 0
    )
  );

  // ─────────────────────────────────────────────────────────
  // FIRST 50 / 100 / 150 / 250
  // ─────────────────────────────────────────────────────────

  console.log(
    '\n── EARLY-PERIOD BREAKDOWN ──'
  );

  for (const n of [50, 100, 150, 250]) {
    if (n > bets.length) continue;

    const subset =
      bets.slice(0, n);

    console.log(
      `\nFIRST ${n} BETS`
    );

    reportGroup(
      '  ALL',
      subset
    );

    reportGroup(
      '  HOME',
      subset.filter(
        b => b.side === 'home'
      )
    );

    reportGroup(
      '  AWAY',
      subset.filter(
        b => b.side === 'away'
      )
    );

    reportGroup(
      '  MODEL > MARKET',
      subset.filter(
        b => b.residual > 0
      )
    );

    reportGroup(
      '  MODEL < MARKET',
      subset.filter(
        b => b.residual < 0
      )
    );
  }

  // ─────────────────────────────────────────────────────────
  // RESIDUAL BUCKETS
  // ─────────────────────────────────────────────────────────

  console.log(
    '\n── RESIDUAL BUCKETS ──'
  );

  const buckets = [
    '< -10pp',
    '-10 to -5pp',
    '-5 to 0pp',
    '0 to +5pp',
    '+5 to +10pp',
    '> +10pp',
  ];

  for (const bucket of buckets) {
    reportGroup(
      bucket,
      bets.filter(
        b =>
          residualBucket(
            b.residual
          ) === bucket
      )
    );
  }

  console.log(
    '\n===================================================='
  );

  console.log(
    'This is a diagnostic of the existing model.'
  );

  console.log(
    'It does not tune thresholds or change calibration.'
  );

  console.log(
    'The key question is whether the early peak is'
  );

  console.log(
    'concentrated in a repeatable subset of bets or'
  );

  console.log(
    'whether it is simply followed by broad negative'
  );

  console.log(
    'performance across the remaining sample.'
  );

  console.log(
    '===================================================='
  );
}

main().catch(e => {
  console.error(
    e.stack || e.message
  );
  process.exit(1);
});