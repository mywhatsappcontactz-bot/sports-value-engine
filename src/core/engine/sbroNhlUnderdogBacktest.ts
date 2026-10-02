// src/core/engine/sbroNhlUnderdogBacktest.ts
//
// Companion to sbroNhlPuckLineBacktest.ts. Same Format A SBRO parsing,
// same shared probabilityModel functions, same real prices and real
// settlement — but it answers a DIFFERENT question.
//
// The existing backtests all bet the model's FAVORED side and select on
// a confidence floor. That structurally restricts every bet to short
// prices (observed avg odds 1.42-1.51 on puck line, ~1.9-2.2 moneyline),
// so "no edge" so far really means "no edge on short-priced sides".
//
// This script tests the other half of the board:
//   - the LONG-priced (plus-money) side of the puck line
//   - selected on EXPECTED VALUE, not a confidence floor
//
// WHY NOT CONFIDENCE FLOORS: a 2.60 underdog breaks even at 38.5%.
// Requiring modelProb >= 0.55 rejects every real underdog value bet and
// returns an empty table. Edge = modelProb * decimalOdds - 1 is the
// correct selector when prices vary.
//
// ⚠ CALIBRATION WARNING — READ THIS BEFORE TRUSTING ANY POSITIVE NUMBER:
// Puck-line cover probability is UNCALIBRATED (no isotonic fit exists
// for this market). EV filtering is FAR more sensitive to miscalibration
// than confidence floors are, because edge is multiplied by the price.
// An overconfident model at 3.00 odds manufactures a fake +20% edge from
// a 7pp probability error. If the long side shows a positive ROI here,
// that is a HYPOTHESIS TO CALIBRATE, not a result. Fit isotonic to
// puck-line cover first, then re-run.
//
// USAGE:
//   npx ts-node src/core/engine/sbroNhlUnderdogBacktest.ts <path-to-SBRO-file>
//   npx ts-node src/core/engine/sbroNhlUnderdogBacktest.ts "C:\Users\USER\Documents\nhl 2016 2017.txt"

import * as fs from 'fs';
import { computeHockeyGoalLambdas, marginDistribution, handicapCoverProbability } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const EDGE_THRESHOLDS = [0.00, 0.02, 0.05, 0.10];
const FIXED_STAKE = 10_000;

// Price buckets for the "where does signal live" breakdown.
const PRICE_BUCKETS: { label: string; min: number; max: number }[] = [
  { label: '< 1.50',     min: 0,    max: 1.50 },
  { label: '1.50-2.00',  min: 1.50, max: 2.00 },
  { label: '2.00-2.50',  min: 2.00, max: 2.50 },
  { label: '2.50-3.00',  min: 2.50, max: 3.00 },
  { label: '3.00+',      min: 3.00, max: Infinity },
];

// ─── CLI ────────────────────────────────────────────────────────────────

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlUnderdogBacktest.ts <path-to-SBRO-file>');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

// ─── PARSING (Format A only — 16 fields, PuckLine present) ─────────────
// Unchanged from sbroNhlPuckLineBacktest.ts.

interface SbroRow {
  date: string; rot: number; vh: 'V' | 'H' | 'N'; team: string;
  final: number; close: number;
  puckLine: number; puckLineOdds: number;
}

function parseRows(text: string): SbroRow[] {
  const lines = text.trim().split(/\r?\n/);
  const rows: SbroRow[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 16) continue;
    if (!/^\d+$/.test(fields[0])) continue;
    const vh = fields[2];
    if (vh !== 'V' && vh !== 'H' && vh !== 'N') continue;
    const n = (s: string) => parseFloat(s);
    const [date, rot, , team, , , , final, , close, puckLine, puckLineOdds] = fields;
    if (isNaN(n(puckLine)) || isNaN(n(puckLineOdds))) continue;
    rows.push({
      date, rot: n(rot), vh: vh as 'V' | 'H' | 'N', team,
      final: n(final), close: n(close),
      puckLine: n(puckLine), puckLineOdds: n(puckLineOdds),
    });
  }
  return rows;
}

interface Game {
  seq: number; dateLabel: string;
  awayTeam: string; awayScore: number; awayPuckLine: number; awayPuckLineOdds: number;
  homeTeam: string; homeScore: number; homePuckLine: number; homePuckLineOdds: number;
}

function pairRowsIntoGames(rows: SbroRow[]): Game[] {
  const games: Game[] = [];
  let seq = 0;
  for (let i = 0; i < rows.length - 1; i += 2) {
    const a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; }
    games.push({
      seq: seq++, dateLabel: a.date,
      awayTeam: a.team, awayScore: a.final, awayPuckLine: a.puckLine, awayPuckLineOdds: a.puckLineOdds,
      homeTeam: b.team, homeScore: b.final, homePuckLine: b.puckLine, homePuckLineOdds: b.puckLineOdds,
    });
  }
  return games;
}

function americanToDecimal(american: number): number {
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

function parseMonthDay(dateLabel: string): { month: number; day: number } {
  const s = dateLabel.trim();
  if (s.length === 3) return { month: parseInt(s[0], 10), day: parseInt(s.slice(1), 10) };
  return { month: parseInt(s.slice(0, 2), 10), day: parseInt(s.slice(2), 10) };
}
function isPreseasonNoise(dateLabel: string): boolean {
  const { month, day } = parseMonthDay(dateLabel);
  if (month === 8) return true;
  if (month === 9 && day < 15) return true;
  return false;
}

// ─── HISTORY (unchanged) ───────────────────────────────────────────────

interface TeamRecord { date: number; opp: string; res: 'W' | 'L'; home: boolean; pf: number; pa: number; }

function buildHistory(games: Game[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();
  const push = (team: string, rec: TeamRecord) => {
    if (!hist.has(team)) hist.set(team, []);
    hist.get(team)!.push(rec);
  };
  for (const g of games) {
    push(g.homeTeam, { date: g.seq, opp: g.awayTeam, res: g.homeScore > g.awayScore ? 'W' : 'L', home: true, pf: g.homeScore, pa: g.awayScore });
    push(g.awayTeam, { date: g.seq, opp: g.homeTeam, res: g.awayScore > g.homeScore ? 'W' : 'L', home: false, pf: g.awayScore, pa: g.homeScore });
  }
  return hist;
}
function toForm(recs: TeamRecord[]): FormRecord[] {
  return recs.slice(-10).map(r => ({
    date: String(r.date), opponent: r.opp, result: r.res,
    goalsFor: r.pf, goalsAgainst: r.pa, venue: r.home ? 'home' : 'away',
  }));
}

function fmtNaira(n: number): string { return `₦${Math.round(n).toLocaleString()}`; }

// ─── CANDIDATE BETS ────────────────────────────────────────────────────
//
// For every qualifying game we emit BOTH sides as candidate bets, each
// with its own real price, own model cover probability, and own real
// settled result. Strategies below are just filters over this list —
// that way long side / short side / all sides are strictly comparable.

interface Candidate {
  seq: number;
  team: string;
  isHome: boolean;
  line: number;            // -1.5 or +1.5
  decimalOdds: number;
  modelProb: number;       // model P(this side covers its line)
  edge: number;            // modelProb * decimalOdds - 1
  won: boolean;            // real cover result
  isLongSide: boolean;     // this side is the longer price of the two
}

interface Summary {
  bets: number; wins: number; winPct: number;
  avgOdds: number; avgModelProb: number; roi: number; profit: number;
}

function summarize(cands: Candidate[]): Summary | null {
  if (!cands.length) return null;
  let profit = 0, wins = 0, oddsSum = 0, probSum = 0;
  for (const c of cands) {
    profit += c.won ? FIXED_STAKE * (c.decimalOdds - 1) : -FIXED_STAKE;
    if (c.won) wins++;
    oddsSum += c.decimalOdds;
    probSum += c.modelProb;
  }
  const staked = cands.length * FIXED_STAKE;
  return {
    bets: cands.length, wins, winPct: (wins / cands.length) * 100,
    avgOdds: oddsSum / cands.length, avgModelProb: (probSum / cands.length) * 100,
    roi: (profit / staked) * 100, profit,
  };
}

function printEdgeTable(title: string, pool: Candidate[]) {
  console.log(`\n── ${title} ──`);
  if (!pool.length) { console.log('  (no candidate bets in this pool)'); return; }
  console.log('Edge>=  Bets   Wins   Win%    AvgOdds   Breakeven   AvgModelP   ROI%      Profit(Fixed)');
  for (const t of EDGE_THRESHOLDS) {
    const sel = pool.filter(c => c.edge >= t);
    const s = summarize(sel);
    if (!s) { console.log(`${(t * 100).toFixed(0).padStart(4)}%      0`); continue; }
    const breakeven = (1 / s.avgOdds) * 100;
    console.log(
      `${(t * 100).toFixed(0).padStart(4)}%   ${String(s.bets).padStart(5)}  ${String(s.wins).padStart(5)}   ` +
      `${s.winPct.toFixed(1).padStart(5)}%   ${s.avgOdds.toFixed(3).padStart(7)}   ` +
      `${breakeven.toFixed(1).padStart(8)}%   ${s.avgModelProb.toFixed(1).padStart(8)}%   ` +
      `${s.roi.toFixed(2).padStart(7)}%   ${fmtNaira(s.profit).padStart(14)}`
    );
  }
}

function printPriceBuckets(title: string, pool: Candidate[]) {
  console.log(`\n── ${title} ──`);
  console.log('Price       Bets   Wins   Win%    Breakeven   Gap(pp)   AvgModelP   ROI%');
  for (const b of PRICE_BUCKETS) {
    const sel = pool.filter(c => c.decimalOdds >= b.min && c.decimalOdds < b.max);
    const s = summarize(sel);
    if (!s) { console.log(`${b.label.padEnd(10)}     0`); continue; }
    const breakeven = (1 / s.avgOdds) * 100;
    const gap = s.winPct - breakeven;
    console.log(
      `${b.label.padEnd(10)} ${String(s.bets).padStart(5)}  ${String(s.wins).padStart(5)}   ` +
      `${s.winPct.toFixed(1).padStart(5)}%   ${breakeven.toFixed(1).padStart(8)}%   ` +
      `${(gap >= 0 ? '+' : '') + gap.toFixed(1)}`.padStart(9) + `   ` +
      `${s.avgModelProb.toFixed(1).padStart(8)}%   ${s.roi.toFixed(2).padStart(7)}%`
    );
  }
}

// Calibration check: in each model-probability band, how often did the
// side actually cover? If these columns diverge, EV numbers above are
// not trustworthy and the fix is an isotonic fit, not more filtering.
function printCalibration(pool: Candidate[]) {
  console.log('\n── Calibration check (model P vs actual cover rate) ──');
  console.log('ModelP band   Bets   Predicted   Actual   Error(pp)');
  const bands = [[0.0, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01]];
  for (const [lo, hi] of bands) {
    const sel = pool.filter(c => c.modelProb >= lo && c.modelProb < hi);
    if (!sel.length) { console.log(`${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`.padEnd(13) + '    0'); continue; }
    const predicted = (sel.reduce((s, c) => s + c.modelProb, 0) / sel.length) * 100;
    const actual = (sel.filter(c => c.won).length / sel.length) * 100;
    const err = actual - predicted;
    console.log(
      `${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`.padEnd(13) +
      `${String(sel.length).padStart(5)}   ${predicted.toFixed(1).padStart(8)}%   ` +
      `${actual.toFixed(1).padStart(6)}%   ${((err >= 0 ? '+' : '') + err.toFixed(1)).padStart(9)}`
    );
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const text = fs.readFileSync(inputPath, 'utf-8');
  const rows = parseRows(text);
  console.log(`Parsed ${rows.length} raw rows with real puck-line data.`);

  const allGames = pairRowsIntoGames(rows).sort((a, b) => a.seq - b.seq);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));
  console.log(`Paired into ${allGames.length} games (${allGames.length - games.length} deep-preseason games excluded).`);

  const candidates: Candidate[] = [];
  let qualifyingGames = 0;

  for (const game of games) {
    const priorGames = games.filter(g => g.seq < game.seq);
    const history = buildHistory(priorGames);

    const homeRecords = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date - a.date);
    const awayRecords = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date - a.date);
    if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) continue;

    const h2h: H2HRecord[] = priorGames
      .filter(g => (g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam) || (g.homeTeam === game.awayTeam && g.awayTeam === game.homeTeam))
      .map(g => {
        const flip = g.homeTeam !== game.homeTeam;
        const hs = flip ? g.awayScore : g.homeScore, as = flip ? g.homeScore : g.awayScore;
        return { date: String(g.seq), homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeScore: hs, awayScore: as, winner: (hs > as ? 'home' : 'away') as 'home' | 'away' };
      });

    const stats: Stats = {
      id: `s-${game.seq}`, matchId: `m-${game.seq}`, sport: 'hockey',
      h2h, homeForm: toForm(homeRecords), awayForm: toForm(awayRecords),
      referee: {}, situational: {}, additionalContext: {},
      confidenceFactors: { dataCompleteness: 1, h2hSampleSize: h2h.length, formSampleSize: 10 },
    };

    const { lambdaHome, lambdaAway } = computeHockeyGoalLambdas(stats);
    const dist = marginDistribution(lambdaHome, lambdaAway);

    // Real market direction, same rule as the puck-line script.
    const homeIsRealFavorite = game.homePuckLine < 0;
    const homeLine = homeIsRealFavorite ? -1.5 : 1.5;
    const awayLine = -homeLine;

    const homeProb = handicapCoverProbability(dist, homeLine);
    const awayProb = 1 - homeProb; // ±1.5 admits no push, so strictly complementary

    const homeDec = americanToDecimal(game.homePuckLineOdds);
    const awayDec = americanToDecimal(game.awayPuckLineOdds);

    // Real cover result from actual final scores.
    const margin = game.homeScore - game.awayScore;
    const homeCovered = homeIsRealFavorite ? margin >= 2 : margin >= -1;
    const awayCovered = !homeCovered;

    const homeIsLong = homeDec > awayDec;

    candidates.push({
      seq: game.seq, team: game.homeTeam, isHome: true, line: homeLine,
      decimalOdds: homeDec, modelProb: homeProb, edge: homeProb * homeDec - 1,
      won: homeCovered, isLongSide: homeIsLong,
    });
    candidates.push({
      seq: game.seq, team: game.awayTeam, isHome: false, line: awayLine,
      decimalOdds: awayDec, modelProb: awayProb, edge: awayProb * awayDec - 1,
      won: awayCovered, isLongSide: !homeIsLong,
    });

    qualifyingGames++;
  }

  console.log(`\n${qualifyingGames} qualifying games -> ${candidates.length} candidate sides (both sides of every game priced and settled).`);

  // ─── RESIDUAL DIAGNOSTIC ──────────────────────────────────────────────
  //
  // This does NOT alter the existing model or candidate construction.
  // For each side, compare the model probability with the de-vigged
  // probability implied by both real puck-line prices.
  //
  // residual = modelProb - marketProb
  //
  // The purpose is diagnostic: does disagreement with the market correspond
  // to a different realized cover rate? It is NOT an EV selector.
  //

  interface ResidualRow {
    modelProb: number;
    marketProb: number;
    residual: number;
    decimalOdds: number;
    won: boolean;
    isLongSide: boolean;
  }

  const residualRows: ResidualRow[] = [];

  for (const c of candidates) {
    const game = games.find(g => g.seq === c.seq);
    if (!game) continue;

    const homeDec = americanToDecimal(game.homePuckLineOdds);
    const awayDec = americanToDecimal(game.awayPuckLineOdds);

    if (!Number.isFinite(homeDec) || !Number.isFinite(awayDec) ||
        homeDec <= 1 || awayDec <= 1) continue;

    const invHome = 1 / homeDec;
    const invAway = 1 / awayDec;
    const totalInv = invHome + invAway;

    const marketHomeProb = invHome / totalInv;
    const marketProb = c.isHome ? marketHomeProb : 1 - marketHomeProb;

    residualRows.push({
      modelProb: c.modelProb,
      marketProb,
      residual: c.modelProb - marketProb,
      decimalOdds: c.decimalOdds,
      won: c.won,
      isLongSide: c.isLongSide,
    });
  }

  console.log('\n================= MODEL / MARKET RESIDUAL TEST =================');
  console.log(`Rows with usable two-sided market probability: ${residualRows.length}`);
  console.log('\nResidual bucket       Bets   MarketP   ModelP   Actual   Actual-Mkt   ROI');
  console.log('--------------------------------------------------------------------------');

  const residualBuckets = [
    { label: '< -10pp', min: -Infinity, max: -0.10 },
    { label: '-10 to -5pp', min: -0.10, max: -0.05 },
    { label: '-5 to 0pp', min: -0.05, max: 0 },
    { label: '0 to +5pp', min: 0, max: 0.05 },
    { label: '+5 to +10pp', min: 0.05, max: 0.10 },
    { label: '> +10pp', min: 0.10, max: Infinity },
  ];

  function printResidualTable(rows: ResidualRow[]) {
    for (const b of residualBuckets) {
      const sel = rows.filter(r => r.residual >= b.min && r.residual < b.max);

      if (!sel.length) {
        console.log(`${b.label.padEnd(20)} ${String(0).padStart(5)}`);
        continue;
      }

      const marketP = sel.reduce((s, r) => s + r.marketProb, 0) / sel.length;
      const modelP = sel.reduce((s, r) => s + r.modelProb, 0) / sel.length;
      const actual = sel.filter(r => r.won).length / sel.length;
      const roi =
        sel.reduce((s, r) => s + (r.won ? r.decimalOdds - 1 : -1), 0) /
        sel.length;

      console.log(
        `${b.label.padEnd(20)} ${String(sel.length).padStart(5)} ` +
        `${(marketP * 100).toFixed(1).padStart(7)}% ` +
        `${(modelP * 100).toFixed(1).padStart(7)}% ` +
        `${(actual * 100).toFixed(1).padStart(7)}% ` +
        `${((actual - marketP) * 100).toFixed(1).padStart(10)}pp ` +
        `${(roi * 100).toFixed(2).padStart(7)}%`
      );
    }
  }

  printResidualTable(residualRows);

  console.log('\n── LONG side only ──');
  printResidualTable(residualRows.filter(r => r.isLongSide));

  console.log('\n── SHORT side only ──');
  printResidualTable(residualRows.filter(r => !r.isLongSide));

  console.log('\\n── REVERSED RESIDUAL (marketProb - modelProb) ──');
  console.log('Same observations, opposite sign. This checks whether the');
  console.log('apparent inverse relationship is simply directional.\\n');
  console.log('Reversed bucket        Bets   MarketP   ModelP   Actual   Actual-Mkt   ROI');
  console.log('----------------------------------------------------------------------------');

  const reversedBuckets = [
    { label: '< -10pp', min: -Infinity, max: -0.10 },
    { label: '-10 to -5pp', min: -0.10, max: -0.05 },
    { label: '-5 to 0pp', min: -0.05, max: 0 },
    { label: '0 to +5pp', min: 0, max: 0.05 },
    { label: '+5 to +10pp', min: 0.05, max: 0.10 },
    { label: '> +10pp', min: 0.10, max: Infinity },
  ];

  for (const b of reversedBuckets) {
    const sel = residualRows.filter(r => {
      const reversed = -r.residual;
      return reversed >= b.min && reversed < b.max;
    });

    if (!sel.length) {
      console.log(`${b.label.padEnd(22)} ${String(0).padStart(5)}`);
      continue;
    }

    const marketP = sel.reduce((s, r) => s + r.marketProb, 0) / sel.length;
    const modelP = sel.reduce((s, r) => s + r.modelProb, 0) / sel.length;
    const actual = sel.filter(r => r.won).length / sel.length;
    const roi = sel.reduce((s, r) => s + (r.won ? r.decimalOdds - 1 : -1), 0) / sel.length;

    console.log(
      `${b.label.padEnd(22)} ${String(sel.length).padStart(5)} ` +
      `${(marketP * 100).toFixed(1).padStart(7)}% ` +
      `${(modelP * 100).toFixed(1).padStart(7)}% ` +
      `${(actual * 100).toFixed(1).padStart(7)}% ` +
      `${((actual - marketP) * 100).toFixed(1).padStart(10)}pp ` +
      `${(roi * 100).toFixed(2).padStart(7)}%`
    );
  }

  console.log('\n────────────────────────────────────────────────────────────');
  console.log('Positive Actual-Market means the side covered more often than');
  console.log('the de-vigged opening market probability predicted.');
  console.log('This is a diagnostic only. Do not treat a positive bucket as');
  console.log('a betting edge until it survives an untouched season.');
  console.log('────────────────────────────────────────────────────────────');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });