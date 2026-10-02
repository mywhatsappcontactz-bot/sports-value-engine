// src/core/engine/sbroNhlMoneylineResidualBacktest.ts
//
// CALIBRATED MONEYLINE MODEL / MARKET RESIDUAL TEST
//
// Compares the calibrated hockey moneyline probability against the
// de-vigged REAL opening moneyline market probability.
//
// USAGE:
// npx ts-node src/core/engine/sbroNhlMoneylineResidualBacktest.ts <sbro-file.txt>

import * as fs from 'fs';
import {
  computeHockeyRawMoneylineProb,
  applyHockeyIsotonicCalibration,
} from './probabilityModel';

const MIN_PRIOR_GAMES = 5;
const FORM_WINDOW = 10;

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlMoneylineResidualBacktest.ts <path-to-SBRO-file>');
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
  let seq = 0;
  let skipped = 0;

  for (let i = 0; i < rows.length - 1; i += 2) {
    let a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; }

    if (a.vh === 'H' && b.vh === 'V') {
      const tmp = a; a = b; b = tmp;
    }

    if (!(a.vh === 'V' && b.vh === 'H')) {
      skipped++;
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

  if (skipped) console.log(`(${skipped} row-pair(s) skipped.)`);
  return games;
}

function americanToDecimal(american: number): number {
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function americanToImpliedProb(american: number): number {
  return american > 0
    ? 100 / (american + 100)
    : Math.abs(american) / (Math.abs(american) + 100);
}

function parseMonthDay(dateLabel: string): { month: number; day: number } {
  const s = dateLabel.trim();
  return s.length === 3
    ? { month: parseInt(s[0], 10), day: parseInt(s.slice(1), 10) }
    : { month: parseInt(s.slice(0, 2), 10), day: parseInt(s.slice(2), 10) };
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

interface Candidate {
  side: 'home' | 'away';
  modelProb: number;
  marketProb: number;
  residual: number;
  openDecimal: number;
  won: boolean;
}

const BUCKETS = [
  '< -10pp',
  '-10 to -5pp',
  '-5 to 0pp',
  '0 to +5pp',
  '+5 to +10pp',
  '> +10pp',
];

function bucketLabel(r: number): string {
  if (r < -0.10) return '< -10pp';
  if (r < -0.05) return '-10 to -5pp';
  if (r < 0) return '-5 to 0pp';
  if (r < 0.05) return '0 to +5pp';
  if (r < 0.10) return '+5 to +10pp';
  return '> +10pp';
}

function roi(sel: Candidate[]): number {
  if (!sel.length) return 0;
  let profit = 0;
  for (const c of sel) profit += c.won ? c.openDecimal - 1 : -1;
  return profit / sel.length;
}

function printTable(title: string, candidates: Candidate[]) {
  console.log(`\n── ${title} ──`);
  console.log('Residual bucket       Bets   MarketP   ModelP   Actual   Actual-Mkt   ROI');
  console.log('--------------------------------------------------------------------------');

  for (const bucket of BUCKETS) {
    const sel = candidates.filter(c => bucketLabel(c.residual) === bucket);

    if (!sel.length) {
      console.log(`${bucket.padEnd(20)} 0`);
      continue;
    }

    const marketP = sel.reduce((s, c) => s + c.marketProb, 0) / sel.length;
    const modelP = sel.reduce((s, c) => s + c.modelProb, 0) / sel.length;
    const actual = sel.filter(c => c.won).length / sel.length;
    const gap = actual - marketP;
    const r = roi(sel);

    console.log(
      `${bucket.padEnd(20)} ` +
      `${String(sel.length).padStart(4)}   ` +
      `${(marketP * 100).toFixed(1).padStart(6)}%   ` +
      `${(modelP * 100).toFixed(1).padStart(6)}%   ` +
      `${(actual * 100).toFixed(1).padStart(6)}%   ` +
      `${(gap * 100 >= 0 ? '+' : '') + (gap * 100).toFixed(1).padStart(8)}pp   ` +
      `${(r * 100 >= 0 ? '+' : '') + (r * 100).toFixed(2).padStart(6)}%`
    );
  }
}

function printDirection(title: string, sel: Candidate[]) {
  if (!sel.length) {
    console.log(`${title}: 0`);
    return;
  }

  const avgResidual = sel.reduce((s, c) => s + c.residual, 0) / sel.length;
  const marketP = sel.reduce((s, c) => s + c.marketProb, 0) / sel.length;
  const actual = sel.filter(c => c.won).length / sel.length;

  console.log(
    `${title.padEnd(18)} ${String(sel.length).padStart(5)} bets | ` +
    `Avg residual ${avgResidual >= 0 ? '+' : ''}${(avgResidual * 100).toFixed(2)}pp | ` +
    `Market ${(marketP * 100).toFixed(1)}% | Actual ${(actual * 100).toFixed(1)}% | ` +
    `ROI ${roi(sel) >= 0 ? '+' : ''}${(roi(sel) * 100).toFixed(2)}%`
  );
}

async function main() {
  const text = fs.readFileSync(inputPath, 'utf-8');
  const rows = parseRows(text);

  console.log(`Parsed ${rows.length} raw rows with real moneyline open prices.`);

  const allGames = pairRowsIntoGames(rows).sort((a, b) => a.seq - b.seq);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));

  console.log(
    `Paired into ${allGames.length} games ` +
    `(${allGames.length - games.length} deep-preseason excluded).\n`
  );

  const candidates: Candidate[] = [];

  for (const game of games) {
    const priorGames = games.filter(g => g.seq < game.seq);
    const history = buildHistory(priorGames);

    const homeRecs = history.get(game.homeTeam) ?? [];
    const awayRecs = history.get(game.awayTeam) ?? [];

    if (homeRecs.length < MIN_PRIOR_GAMES || awayRecs.length < MIN_PRIOR_GAMES) continue;

    const homeWR = winRate(homeRecs);
    const awayWR = winRate(awayRecs);
    const h2hHWR = h2hHomeWinRate(priorGames, game.homeTeam, game.awayTeam);

    const rawHomeProb = computeHockeyRawMoneylineProb(homeWR, awayWR, h2hHWR);

    // CRITICAL: calibrated probability, not raw probability.
    const modelHomeProb = applyHockeyIsotonicCalibration(rawHomeProb);

    const homeImplied = americanToImpliedProb(game.homeOpenMl);
    const awayImplied = americanToImpliedProb(game.awayOpenMl);
    const total = homeImplied + awayImplied;

    if (!Number.isFinite(total) || total <= 0) continue;

    const marketHomeProb = homeImplied / total;
    const marketAwayProb = awayImplied / total;

    candidates.push({
      side: 'home',
      modelProb: modelHomeProb,
      marketProb: marketHomeProb,
      residual: modelHomeProb - marketHomeProb,
      openDecimal: americanToDecimal(game.homeOpenMl),
      won: game.homeScore > game.awayScore,
    });

    candidates.push({
      side: 'away',
      modelProb: 1 - modelHomeProb,
      marketProb: marketAwayProb,
      residual: (1 - modelHomeProb) - marketAwayProb,
      openDecimal: americanToDecimal(game.awayOpenMl),
      won: game.awayScore > game.homeScore,
    });
  }

  console.log(
    `${candidates.length} candidate sides with calibrated model probability ` +
    `and two-sided de-vigged opening market probability.`
  );

  console.log('\n================= CALIBRATED MODEL / MARKET RESIDUAL TEST =================');

  printTable('ALL SIDES', candidates);

  console.log('\n── RESIDUAL DIRECTION SUMMARY ──');
  printDirection('Model > Market', candidates.filter(c => c.residual > 0));
  printDirection('Model < Market', candidates.filter(c => c.residual < 0));

  printTable(
    'HOME ONLY',
    candidates.filter(c => c.side === 'home')
  );

  printTable(
    'AWAY ONLY',
    candidates.filter(c => c.side === 'away')
  );

  console.log(`
────────────────────────────────────────────────────────────
Residual = calibrated model probability − de-vigged opening
market probability.

Positive residual means the calibrated model assigns a higher
probability than the opening market.

The ROI column uses the actual opening moneyline price.

Run this on one season first, then an untouched second season.
Do not tune thresholds on the second season.
────────────────────────────────────────────────────────────
`);
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
