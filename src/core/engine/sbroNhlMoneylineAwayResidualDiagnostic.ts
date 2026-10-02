// src/core/engine/sbroNhlMoneylineAwayResidualDiagnostic.ts
//
// Diagnostic only: calibrated NHL moneyline model vs de-vigged opening market.
// Focuses on AWAY sides and asks whether model probability is systematically
// too high/too low when it disagrees strongly with the market.
//
// Usage:
// npx ts-node src/core/engine/sbroNhlMoneylineAwayResidualDiagnostic.ts "<sbro-file.txt>"

import * as fs from 'fs';
import { computeHockeyRawMoneylineProb, applyHockeyIsotonicCalibration } from './probabilityModel';

const MIN_PRIOR_GAMES = 5;
const FORM_WINDOW = 10;

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlMoneylineAwayResidualDiagnostic.ts <sbro-file.txt>');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

interface SbroRow {
  date: string; vh: 'V' | 'H' | 'N'; team: string;
  final: number; openMl: number;
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
    if (Number.isNaN(final) || Number.isNaN(openMl)) continue;
    rows.push({ date: fields[0], vh, team: fields[3], final, openMl });
  }
  return rows;
}

interface Game {
  seq: number; dateLabel: string;
  awayTeam: string; awayScore: number; awayOpenMl: number;
  homeTeam: string; homeScore: number; homeOpenMl: number;
}

function pairRowsIntoGames(rows: SbroRow[]): Game[] {
  const games: Game[] = [];
  let seq = 0;
  for (let i = 0; i < rows.length - 1; i += 2) {
    let a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; }
    if (a.vh === 'H' && b.vh === 'V') { const t = a; a = b; b = t; }
    if (!(a.vh === 'V' && b.vh === 'H')) continue;
    games.push({
      seq: seq++, dateLabel: a.date,
      awayTeam: a.team, awayScore: a.final, awayOpenMl: a.openMl,
      homeTeam: b.team, homeScore: b.final, homeOpenMl: b.openMl
    });
  }
  return games;
}

function americanToDecimal(a: number): number {
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}

function parseMonthDay(s: string): { month: number; day: number } {
  if (s.length === 3) return { month: +s[0], day: +s.slice(1) };
  return { month: +s.slice(0, 2), day: +s.slice(2) };
}

function isPreseasonNoise(s: string): boolean {
  const { month, day } = parseMonthDay(s);
  return month === 8 || (month === 9 && day < 15);
}

interface TeamRecord { seq: number; opp: string; won: boolean; }

function buildHistory(games: Game[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();
  const push = (team: string, rec: TeamRecord) => {
    if (!hist.has(team)) hist.set(team, []);
    hist.get(team)!.push(rec);
  };
  for (const g of games) {
    push(g.homeTeam, { seq: g.seq, opp: g.awayTeam, won: g.homeScore > g.awayScore });
    push(g.awayTeam, { seq: g.seq, opp: g.homeTeam, won: g.awayScore > g.homeScore });
  }
  return hist;
}

function winRate(recs: TeamRecord[]): number {
  if (!recs.length) return 0.5;
  const recent = recs.slice(-FORM_WINDOW);
  return recent.filter(r => r.won).length / recent.length;
}

function h2hHomeWinRate(priorGames: Game[], homeTeam: string, awayTeam: string): number {
  const meetings = priorGames.filter(g =>
    (g.homeTeam === homeTeam && g.awayTeam === awayTeam) ||
    (g.homeTeam === awayTeam && g.awayTeam === homeTeam)
  );
  if (!meetings.length) return 0.5;
  let homeWins = 0;
  for (const g of meetings) {
    const homeTeamWon = g.homeTeam === homeTeam
      ? g.homeScore > g.awayScore
      : g.awayScore > g.homeScore;
    if (homeTeamWon) homeWins++;
  }
  return homeWins / meetings.length;
}

interface Row {
  modelP: number;
  marketP: number;
  actual: number;
  residual: number;
  roi: number;
}

function marketProbAway(awayOpen: number, homeOpen: number): number {
  const da = americanToDecimal(awayOpen);
  const dh = americanToDecimal(homeOpen);
  const ra = 1 / da;
  const rh = 1 / dh;
  return ra / (ra + rh);
}

function makeRows(games: Game[]): Row[] {
  const out: Row[] = [];
  for (const game of games) {
    const prior = games.filter(g => g.seq < game.seq);
    const history = buildHistory(prior);
    const home = history.get(game.homeTeam) ?? [];
    const away = history.get(game.awayTeam) ?? [];
    if (home.length < MIN_PRIOR_GAMES || away.length < MIN_PRIOR_GAMES) continue;

    const rawHome = computeHockeyRawMoneylineProb(
      winRate(home), winRate(away), h2hHomeWinRate(prior, game.homeTeam, game.awayTeam)
    );
    const calibratedHome = applyHockeyIsotonicCalibration(rawHome);
    const calibratedAway = 1 - calibratedHome;

    const marketAway = marketProbAway(game.awayOpenMl, game.homeOpenMl);
    const residual = calibratedAway - marketAway;
    const won = game.awayScore > game.homeScore;
    const dec = americanToDecimal(game.awayOpenMl);
    const roi = won ? (dec - 1) * 100 : -100;

    out.push({ modelP: calibratedAway, marketP: marketAway, actual: won ? 1 : 0, residual, roi });
  }
  return out;
}

function printBucket(label: string, rows: Row[]) {
  if (!rows.length) {
    console.log(`${label.padEnd(14)} 0`);
    return;
  }
  const avgModel = rows.reduce((s,r) => s+r.modelP,0)/rows.length;
  const avgMarket = rows.reduce((s,r) => s+r.marketP,0)/rows.length;
  const actual = rows.reduce((s,r) => s+r.actual,0)/rows.length;
  const avgResidual = rows.reduce((s,r) => s+r.residual,0)/rows.length;
  const roi = rows.reduce((s,r) => s+r.roi,0)/rows.length;
  const modelError = actual - avgModel;
  console.log(
    `${label.padEnd(14)} ${String(rows.length).padStart(5)} ` +
    `${(avgMarket*100).toFixed(1).padStart(7)}% ` +
    `${(avgModel*100).toFixed(1).padStart(7)}% ` +
    `${(actual*100).toFixed(1).padStart(7)}% ` +
    `${(avgResidual*100).toFixed(1).padStart(8)}pp ` +
    `${(modelError*100 >= 0 ? '+' : '') + (modelError*100).toFixed(1).padStart(7)}pp ` +
    `${(roi >= 0 ? '+' : '') + roi.toFixed(2).padStart(8)}%`
  );
}

async function main() {
  const rows = parseRows(fs.readFileSync(inputPath, 'utf-8'));
  const allGames = pairRowsIntoGames(rows).sort((a,b)=>a.seq-b.seq);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));

  console.log(`Parsed ${rows.length} raw rows with real moneyline open prices.`);
  console.log(`Paired into ${allGames.length} games (${allGames.length-games.length} deep-preseason excluded).`);
  const data = makeRows(games);

  console.log(`\n${data.length} qualifying AWAY sides.\n`);
  console.log('================ AWAY MODEL-CALIBRATION DIAGNOSTIC ================\n');
  console.log('Residual = calibrated away ModelP - de-vigged opening MarketP.');
  console.log('Model error = Actual win rate - calibrated ModelP.');
  console.log('ROI = flat 1-unit stake at the actual opening away moneyline.\n');

  console.log('Residual bucket       Bets  MarketP  ModelP  Actual  Residual  ModelErr     ROI');
  console.log('-------------------------------------------------------------------------------');

  const buckets: [string, (r:Row)=>boolean][] = [
    ['< -10pp', r => r.residual < -0.10],
    ['-10 to -5pp', r => r.residual >= -0.10 && r.residual < -0.05],
    ['-5 to 0pp', r => r.residual >= -0.05 && r.residual < 0],
    ['0 to +5pp', r => r.residual >= 0 && r.residual < 0.05],
    ['+5 to +10pp', r => r.residual >= 0.05 && r.residual < 0.10],
    ['> +10pp', r => r.residual >= 0.10]
  ];

  for (const [label, test] of buckets) printBucket(label, data.filter(test));

  console.log('\n── CALIBRATED MODEL-PROBABILITY BANDS (AWAY) ──\n');
  console.log('ModelP band       Bets  ModelP  Actual  Error     ROI');
  console.log('-------------------------------------------------------');

  const bands: [string, number, number][] = [
    ['40-50%', 0.40, 0.50],
    ['50-60%', 0.50, 0.60],
    ['60-70%', 0.60, 0.70],
    ['70-80%', 0.70, 0.80],
    ['80%+', 0.80, 1.01]
  ];

  for (const [label, lo, hi] of bands) {
    const b = data.filter(r => r.modelP >= lo && r.modelP < hi);
    if (!b.length) { console.log(`${label.padEnd(14)} 0`); continue; }
    const mp = b.reduce((s,r)=>s+r.modelP,0)/b.length;
    const ac = b.reduce((s,r)=>s+r.actual,0)/b.length;
    const roi = b.reduce((s,r)=>s+r.roi,0)/b.length;
    const err = ac-mp;
    console.log(
      `${label.padEnd(14)} ${String(b.length).padStart(5)} ` +
      `${(mp*100).toFixed(1).padStart(6)}% ${(ac*100).toFixed(1).padStart(7)}% ` +
      `${(err*100 >= 0 ? '+' : '') + (err*100).toFixed(1).padStart(7)}pp ` +
      `${(roi >= 0 ? '+' : '') + roi.toFixed(2).padStart(8)}%`
    );
  }

  console.log('\n======================================================================');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
