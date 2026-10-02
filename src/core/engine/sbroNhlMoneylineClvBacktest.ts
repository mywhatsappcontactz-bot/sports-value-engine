// src/core/engine/sbroNhlMoneylineClvBacktest.ts
//
// Tests Closing Line Value (CLV), not ROI — a different, outcome-
// independent question: after the model picks a side, did the REAL
// market move toward that side by closing (you'd have beaten the
// close, meaning sharp money later agreed with you) or away from it
// (the market disagreed after you'd have bet)?
//
// WHY THIS IS WORTH RUNNING SEPARATELY FROM EVERYTHING ELSE TONIGHT:
// ROI depends on variance across a whole season — a real edge can look
// bad for months, and no edge can look good for months, purely by
// chance (see tonight's earlier moneyline/puck-line flip-flops). CLV
// doesn't have that problem: every single pick is its own independent
// data point about whether the model is on the right side of where
// smart money moves the number, regardless of whether that particular
// game happened to go the model's way. This is the standard way
// professional bettors check for real skill without waiting a season.
//
// DATA: uses the REAL Open/Close moneyline odds columns already present
// in every SBRO Format-A file (fields 9 and 10 — see parseRows below).
// No goalie-style proxy, no new download needed.
//
// USAGE:
//   npx ts-node src/core/engine/sbroNhlMoneylineClvBacktest.ts <sbro-file.txt>
//   npx ts-node src/core/engine/sbroNhlMoneylineClvBacktest.ts "C:\...\nhl 2016 2017.txt"

import * as fs from 'fs';
import { computeHockeyRawMoneylineProb } from './probabilityModel';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const CONFIDENCE_FLOORS = [0, 0.55, 0.60, 0.65, 0.70]; // 0 = every qualifying pick, for a baseline
const FORM_WINDOW = 10; // matches formWinRate's effective window elsewhere (FormRecord.slice(-10))

// ─── CLI ────────────────────────────────────────────────────────────────

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlMoneylineClvBacktest.ts <path-to-SBRO-file>');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) { console.error(`File not found: ${inputPath}`); process.exit(1); }

// ─── PARSING ────────────────────────────────────────────────────────────
// Same 16-field Format A layout used throughout tonight. Fields 8/9 are
// the MONEYLINE open/close American odds (distinct from puck-line's
// fields 10/11) — see the header comment in sbroNhlPuckLineBacktest.ts
// for the full column layout this was reverse-engineered from.

interface SbroRow { date: string; vh: 'V' | 'H' | 'N'; team: string; final: number; openMl: number; closeMl: number; }

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
    const date = fields[0], team = fields[3], final = n(fields[7]);
    const openMl = n(fields[8]), closeMl = n(fields[9]);
    if (isNaN(openMl) || isNaN(closeMl)) continue; // no real moneyline price for this row
    rows.push({ date, vh: vh as 'V' | 'H' | 'N', team, final, openMl, closeMl });
  }
  return rows;
}

interface Game {
  seq: number; dateLabel: string;
  awayTeam: string; awayScore: number; awayOpenMl: number; awayCloseMl: number;
  homeTeam: string; homeScore: number; homeOpenMl: number; homeCloseMl: number;
}

function pairRowsIntoGames(rows: SbroRow[]): Game[] {
  const games: Game[] = [];
  let seq = 0;
  let skippedMismatched = 0;
  for (let i = 0; i < rows.length - 1; i += 2) {
    let a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; }
    // Defensive: don't assume row order, use the actual V/H markers.
    if (a.vh === 'H' && b.vh === 'V') { const tmp = a; a = b; b = tmp; }
    if (!(a.vh === 'V' && b.vh === 'H')) { skippedMismatched++; continue; }
    games.push({
      seq: seq++, dateLabel: a.date,
      awayTeam: a.team, awayScore: a.final, awayOpenMl: a.openMl, awayCloseMl: a.closeMl,
      homeTeam: b.team, homeScore: b.final, homeOpenMl: b.openMl, homeCloseMl: b.closeMl,
    });
  }
  if (skippedMismatched) console.log(`(${skippedMismatched} row-pair(s) skipped — V/H markers didn't resolve to one away + one home row.)`);
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

// ─── HISTORY (minimal — computeHockeyRawMoneylineProb only needs three
// plain win-rate numbers, not a full Stats object, so this script
// doesn't need FormRecord/H2HRecord wrapping at all) ────────────────

interface TeamRecord { seq: number; opp: string; won: boolean; }
function buildHistory(games: Game[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();
  const push = (team: string, rec: TeamRecord) => { if (!hist.has(team)) hist.set(team, []); hist.get(team)!.push(rec); };
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
    (g.homeTeam === homeTeam && g.awayTeam === awayTeam) || (g.homeTeam === awayTeam && g.awayTeam === homeTeam)
  );
  if (!meetings.length) return 0.5;
  let homeWins = 0;
  for (const g of meetings) {
    const thisMatchupWinnerIsHomeTeam = g.homeTeam === homeTeam ? g.homeScore > g.awayScore : g.awayScore > g.homeScore;
    if (thisMatchupWinnerIsHomeTeam) homeWins++;
  }
  return homeWins / meetings.length;
}

// ─── CLV CORE ───────────────────────────────────────────────────────────

interface Pick {
  confidence: number; // raw, uncalibrated model confidence — see note in printout
  side: 'home' | 'away';
  openDecimal: number; closeDecimal: number;
  clvPct: number; // positive = market moved TOWARD the model's side after open (beat the close)
  won: boolean; // kept for context only — NOT what CLV measures
}

function fmtPct(n: number): string { return `${(n >= 0 ? '+' : '') + n.toFixed(2)}%`; }

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const text = fs.readFileSync(inputPath, 'utf-8');
  const rows = parseRows(text);
  console.log(`Parsed ${rows.length} raw rows with real moneyline open+close prices.`);

  const allGames = pairRowsIntoGames(rows).sort((a, b) => a.seq - b.seq);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));
  console.log(`Paired into ${allGames.length} games (${allGames.length - games.length} deep-preseason excluded).\n`);

  const picks: Pick[] = [];

  for (const game of games) {
    const priorGames = games.filter(g => g.seq < game.seq);
    const history = buildHistory(priorGames);

    const homeRecs = history.get(game.homeTeam) ?? [];
    const awayRecs = history.get(game.awayTeam) ?? [];
    if (homeRecs.length < MIN_PRIOR_GAMES || awayRecs.length < MIN_PRIOR_GAMES) continue;

    const homeWR = winRate(homeRecs);
    const awayWR = winRate(awayRecs);
    const h2hHWR = h2hHomeWinRate(priorGames, game.homeTeam, game.awayTeam);

    const rawHomeWinProb = computeHockeyRawMoneylineProb(homeWR, awayWR, h2hHWR);
    const side: 'home' | 'away' = rawHomeWinProb >= 0.5 ? 'home' : 'away';
    const confidence = Math.max(rawHomeWinProb, 1 - rawHomeWinProb);

    const openAmerican = side === 'home' ? game.homeOpenMl : game.awayOpenMl;
    const closeAmerican = side === 'home' ? game.homeCloseMl : game.awayCloseMl;
    const openDecimal = americanToDecimal(openAmerican);
    const closeDecimal = americanToDecimal(closeAmerican);
    const clvPct = (openDecimal / closeDecimal - 1) * 100;

    const won = side === 'home' ? game.homeScore > game.awayScore : game.awayScore > game.homeScore;

    picks.push({ confidence, side, openDecimal, closeDecimal, clvPct, won });
  }

  console.log(`${picks.length} qualifying picks (5+ prior games each side, real open+close price available).\n`);

  console.log('Floor   Picks   AvgCLV%    %BeatClose   %WorseThanClose   %Push   Win% (context only)');
  for (const floor of CONFIDENCE_FLOORS) {
    const sel = picks.filter(p => p.confidence >= floor);
    if (!sel.length) { console.log(`${(floor * 100).toFixed(0)}%      0`); continue; }
    const avgClv = sel.reduce((s, p) => s + p.clvPct, 0) / sel.length;
    const beatClose = sel.filter(p => p.clvPct > 0.01).length;
    const worseThanClose = sel.filter(p => p.clvPct < -0.01).length;
    const push = sel.length - beatClose - worseThanClose;
    const wins = sel.filter(p => p.won).length;
    console.log(
      `${(floor * 100).toFixed(0)}%     ${String(sel.length).padStart(5)}   ${fmtPct(avgClv).padStart(8)}   ` +
      `${((beatClose / sel.length) * 100).toFixed(1).padStart(9)}%   ${((worseThanClose / sel.length) * 100).toFixed(1).padStart(14)}%   ` +
      `${((push / sel.length) * 100).toFixed(1).padStart(5)}%   ${((wins / sel.length) * 100).toFixed(1).padStart(5)}%`
    );
  }

  console.log('\n── By side (does the model have CLV on one side but not the other?) ──');
  for (const side of ['home', 'away'] as const) {
    const sel = picks.filter(p => p.side === side);
    if (!sel.length) { console.log(`${side}: 0 picks`); continue; }
    const avgClv = sel.reduce((s, p) => s + p.clvPct, 0) / sel.length;
    const beatClose = sel.filter(p => p.clvPct > 0.01).length;
    console.log(`${side.padEnd(5)}: ${sel.length} picks, AvgCLV ${fmtPct(avgClv)}, beat close ${((beatClose / sel.length) * 100).toFixed(1)}%`);
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`HOW TO READ THIS:`);
  console.log(`AvgCLV% > 0 and %BeatClose meaningfully > 50% across MULTIPLE`);
  console.log(`seasons is the actual signature of real skill — the market is`);
  console.log(`agreeing with the model's picks after the fact, independent of`);
  console.log(`whether any individual game happened to go the model's way.`);
  console.log(`AvgCLV% ~0 or negative, or %BeatClose ~50% (a coinflip), means`);
  console.log(`the model isn't finding anything the closing market didn't`);
  console.log(`already know — consistent with tonight's ROI results, not a`);
  console.log(`contradiction of them.`);
  console.log(`Confidence used here is RAW (uncalibrated) model output — CLV`);
  console.log(`doesn't need calibration, only direction and relative ordering,`);
  console.log(`both of which isotonic calibration preserves by construction.`);
  console.log(`One season is a reasonable first look for CLV (it needs less`);
  console.log(`data than ROI to mean something) but still confirm on a second`);
  console.log(`season before treating any positive result as real.`);
  console.log(`────────────────────────────────────────────────────────────`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });