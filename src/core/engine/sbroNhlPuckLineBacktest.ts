// src/core/engine/sbroNhlPuckLineBacktest.ts
//
// Backtests the model's puck-line (spread) predictions against REAL
// SBRO PuckLine/PuckLineOdds data — only available in the "Format A"
// SBRO file (16 raw fields per row, e.g. the FIRST NHL file used
// tonight, "nhl odds.txt"), NOT the second file ("nhl odd 2.txt"),
// which has no puck-line columns at all.
//
// Uses computeHockeyGoalLambdas() + marginDistribution() +
// handicapCoverProbability(), all exported from probabilityModel.ts as
// of 2026-09-15 specifically so this script never duplicates the raw
// formula — same drift-prevention pattern as the moneyline sharing
// fixed earlier tonight. Also benefits from the SAME NIGHT's fix to
// modelHockey()'s puck_line market, which used to hardcode Home as the
// -1.5 favorite always; a real puck line can favor either team, so this
// script determines direction independently per game from the REAL
// SBRO data (whichever team's row shows a negative PuckLine value is
// the real favorite) rather than trusting the model's own framing.
//
// PUCK LINE STILL UNCALIBRATED: unlike moneyline, no isotonic fit exists
// for puck-line cover probability yet — this backtest is exploratory,
// same caveat as every other uncalibrated market in this codebase.
//
// USAGE:
//   npx ts-node src/core/engine/sbroNhlPuckLineBacktest.ts <path-to-SBRO-file>
//   npx ts-node src/core/engine/sbroNhlPuckLineBacktest.ts "C:\Users\USER\Documents\nhl odds.txt"

import * as fs from 'fs';
import { computeHockeyGoalLambdas, marginDistribution, handicapCoverProbability } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const CONFIDENCE_FLOORS = [0.55, 0.60, 0.65, 0.70];
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

// ─── CLI ────────────────────────────────────────────────────────────────

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlPuckLineBacktest.ts <path-to-SBRO-file>');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

// ─── PARSING (Format A only — 16 fields, PuckLine present) ─────────────

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
    if (fields.length !== 16) continue; // this script only handles Format A (with PuckLine)
    if (!/^\d+$/.test(fields[0])) continue;
    const vh = fields[2];
    if (vh !== 'V' && vh !== 'H' && vh !== 'N') continue;
    const n = (s: string) => parseFloat(s);
    const [date, rot, , team, , , , final, , close, puckLine, puckLineOdds] = fields;
    if (isNaN(n(puckLine)) || isNaN(n(puckLineOdds))) continue; // no real puck-line price for this row
    rows.push({ date, rot: n(rot), vh: vh as 'V' | 'H' | 'N', team, final: n(final), close: n(close), puckLine: n(puckLine), puckLineOdds: n(puckLineOdds) });
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

// Same August/pre-Sep-15 exclusion as sbroNhlBacktest.ts, same reasoning.
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

// ─── HISTORY (same pattern as sbroNhlBacktest.ts) ──────────────────────

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
  return recs.slice(-10).map(r => ({ date: String(r.date), opponent: r.opp, result: r.res, goalsFor: r.pf, goalsAgainst: r.pa, venue: r.home ? 'home' : 'away' }));
}

interface BetRecord { won: boolean; odds: number; fixedProfit: number; }
function buildBetRecords(legs: { won: boolean; odds: number }[]): BetRecord[] {
  let balance = INITIAL_CAPITAL;
  return legs.map(l => {
    const profit = l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE;
    balance += profit;
    return { won: l.won, odds: l.odds, fixedProfit: profit };
  });
}
function fmtNaira(n: number): string { return `₦${Math.round(n).toLocaleString()}`; }

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const text = fs.readFileSync(inputPath, 'utf-8');
  const rows = parseRows(text);
  console.log(`Parsed ${rows.length} raw rows with real puck-line data.`);

  const allGames = pairRowsIntoGames(rows).sort((a, b) => a.seq - b.seq);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));
  console.log(`Paired into ${allGames.length} games (${allGames.length - games.length} deep-preseason games excluded).\n`);

  interface Leg { confidence: number; odds: number; won: boolean; }
  const legs: Leg[] = [];

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

    // Model's predicted cover probability, using the SAME shared
    // lambdas/margin-distribution functions production uses.
    const { lambdaHome, lambdaAway } = computeHockeyGoalLambdas(stats);
    const dist = marginDistribution(lambdaHome, lambdaAway);

    // Real market's direction for THIS game: whichever side has the
    // NEGATIVE puck line is the real favorite (laying -1.5), regardless
    // of what the model would have assumed on its own.
    const homeIsRealFavorite = game.homePuckLine < 0;
    const homeLine = homeIsRealFavorite ? -1.5 : 1.5;
    const modelHomeCoverProb = handicapCoverProbability(dist, homeLine);

    const favHomeCover = modelHomeCoverProb >= 0.5;
    const confidence = Math.max(modelHomeCoverProb, 1 - modelHomeCoverProb);

    // Settle using the REAL price for whichever side the model picked.
    const americanOdds = favHomeCover ? game.homePuckLineOdds : game.awayPuckLineOdds;
    const odds = americanToDecimal(americanOdds);

    // Real cover result from actual final scores.
    const margin = game.homeScore - game.awayScore; // positive = home won by this many
    const homeCovered = homeIsRealFavorite ? margin >= 2 : margin > -2;
    const won = favHomeCover ? homeCovered : !homeCovered;

    legs.push({ confidence, odds, won });
  }

  console.log(`${legs.length} qualifying puck-line predictions (5+ prior games each side, real puck-line price available).\n`);

  console.log('Floor   Bets   Wins   Win%     AvgOdds   ROI%      Profit(Fixed)');
  for (const floor of CONFIDENCE_FLOORS) {
    const floorLegs = legs.filter(l => l.confidence >= floor);
    if (!floorLegs.length) { console.log(`${(floor * 100).toFixed(0)}%      0`); continue; }
    const records = buildBetRecords(floorLegs);
    const wins = records.filter(r => r.won).length;
    const avgOdds = records.reduce((s, r) => s + r.odds, 0) / records.length;
    const staked = records.length * FIXED_STAKE;
    const profit = records.reduce((s, r) => s + r.fixedProfit, 0);
    const roi = (profit / staked) * 100;
    console.log(
      `${(floor * 100).toFixed(0)}%     ${String(records.length).padStart(4)}   ${String(wins).padStart(4)}   ` +
      `${((wins / records.length) * 100).toFixed(1).padStart(5)}%   ${avgOdds.toFixed(3).padStart(7)}   ` +
      `${roi.toFixed(2).padStart(7)}%   ${fmtNaira(profit).padStart(14)}`
    );
  }

  console.log('\n(Settled using real SBRO PuckLine/PuckLineOdds prices and real final');
  console.log(' scores. Puck-line cover probability is UNCALIBRATED — no isotonic fit');
  console.log(' exists for this market yet, unlike moneyline. Treat as exploratory.)');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });