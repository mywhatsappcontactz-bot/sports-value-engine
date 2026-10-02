// src/core/engine/oddsPortalThreeWayBacktest.ts
//
// Backtests the corrected, calibrated hockey model against REAL 3-way
// (Home/Draw/Away) OddsPortal odds, parsed via parseOddsPortalAcb.js
// (v10+) into CSV format:
//   Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,
//   Away_Score,Home_Odds,Draw_Odds,Away_Odds
//
// WHY THIS IS BETTER THAN --ot-convert (leagueDetailedReport.ts):
// --ot-convert ESTIMATES an incl.-OT price from a 14-pair-fitted
// formula applied to regulation-time odds. This script uses the REAL
// regulation-time 1X2 market instead — no estimation. A Home/Away bet
// in this market has a genuine, real-priced way to lose that has
// nothing to do with an assumption: if the game is tied after
// regulation (Status = 'After OT' or 'After Pen.'), the REAL market
// settled that as a Draw/X win, at a REAL draw price — meaning a
// Home or Away pick is a real, market-confirmed loss, not an
// auto-loss RULE we imposed. If the game ended in regulation
// (Status = 'Finished'), the pick settles by the real final score,
// same as any 2-way market.
//
// LEAGUE FILTER: the input file may contain more than one league's data
// mixed together (confirmed happened once already — a DEL2 game showed
// up inside a file named for a different league). This script REQUIRES
// an explicit league-name substring filter (case-insensitive match
// against the Tournament column) rather than trusting the whole file —
// belt-and-suspenders on top of checking Tournament uniqueness by hand
// before running this.
//
// USAGE:
//   npx ts-node src/core/engine/oddsPortalThreeWayBacktest.ts <csv-path> <league-filter>
//   npx ts-node src/core/engine/oddsPortalThreeWayBacktest.ts nhl_odds.csv "NHL"
//
// Pools ALL seasons found in the file for the matched league together
// (same approach as hockeyBacktest1.ts / leagueDetailedReport.ts) —
// history/rolling form is built chronologically across the full pooled
// set, not reset per season.

import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

// ─── CLI ────────────────────────────────────────────────────────────────

const [, , csvPathArg, leagueFilterArg] = process.argv;
if (!csvPathArg || !leagueFilterArg) {
  console.error('Usage: npx ts-node src/core/engine/oddsPortalThreeWayBacktest.ts <csv-path> <league-filter>');
  console.error('Example: npx ts-node src/core/engine/oddsPortalThreeWayBacktest.ts nhl_odds.csv "NHL"');
  process.exit(1);
}
if (!fs.existsSync(csvPathArg)) {
  console.error(`File not found: ${csvPathArg}`);
  process.exit(1);
}

// ─── PARSING ────────────────────────────────────────────────────────────

interface Row {
  date: string; // ISO yyyy-mm-dd, already converted by the parser
  tournament: string;
  stage: string;
  status: string; // 'Finished' | 'After OT' | 'After Pen.'
  homeTeam: string; homeScore: number;
  awayTeam: string; awayScore: number;
  homeOdds: number | null; drawOdds: number | null; awayOdds: number | null;
}

function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) { // skip header
    const parts = lines[i].split(',');
    if (parts.length < 11) continue;
    const [date, tournament, stage, status, homeTeam, homeScoreS, awayTeam, awayScoreS, homeOddsS, drawOddsS, awayOddsS] = parts;
    const homeScore = parseInt(homeScoreS, 10);
    const awayScore = parseInt(awayScoreS, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) continue;
    const toNum = (s: string) => (s && s.trim() !== '' ? parseFloat(s) : null);
    rows.push({
      date, tournament, stage, status, homeTeam, homeScore, awayTeam, awayScore,
      homeOdds: toNum(homeOddsS), drawOdds: toNum(drawOddsS), awayOdds: toNum(awayOddsS),
    });
  }
  return rows;
}

// ─── HISTORY / MODEL INPUT (same pattern as every other hockey backtest
//     in this codebase) ───────────────────────────────────────────────

interface TeamRecord { date: string; opp: string; res: 'W' | 'L'; home: boolean; pf: number; pa: number; }

function buildHistory(games: Row[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();
  const push = (team: string, rec: TeamRecord) => {
    if (!hist.has(team)) hist.set(team, []);
    hist.get(team)!.push(rec);
  };
  for (const g of games) {
    push(g.homeTeam, { date: g.date, opp: g.awayTeam, res: g.homeScore > g.awayScore ? 'W' : 'L', home: true, pf: g.homeScore, pa: g.awayScore });
    push(g.awayTeam, { date: g.date, opp: g.homeTeam, res: g.awayScore > g.homeScore ? 'W' : 'L', home: false, pf: g.awayScore, pa: g.homeScore });
  }
  return hist;
}

function toForm(recs: TeamRecord[]): FormRecord[] {
  return recs.slice(-10).map(r => ({
    date: r.date, opponent: r.opp, result: r.res,
    goalsFor: r.pf, goalsAgainst: r.pa, venue: r.home ? 'home' : 'away',
  }));
}

// ─── STAKING ────────────────────────────────────────────────────────────

interface BetRecord {
  date: string; won: boolean; odds: number; wentToOT: boolean;
  fixedProfit: number; fixedBalanceAfter: number;
}

function buildBetRecords(legs: { date: string; won: boolean; odds: number; wentToOT: boolean }[]): BetRecord[] {
  let balance = INITIAL_CAPITAL;
  const records: BetRecord[] = [];
  for (const l of legs) {
    const profit = l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE;
    balance += profit;
    records.push({ date: l.date, won: l.won, odds: l.odds, wentToOT: l.wentToOT, fixedProfit: profit, fixedBalanceAfter: balance });
  }
  return records;
}

function fmtNaira(n: number): string {
  return `₦${Math.round(n).toLocaleString()}`;
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const text = fs.readFileSync(csvPathArg, 'utf-8');
  const allRows = parseCsv(text);
  console.log(`Parsed ${allRows.length} total rows from ${csvPathArg}.`);

  const rows = allRows
    .filter(r => r.tournament.toLowerCase().includes(leagueFilterArg.toLowerCase()))
    .sort((a, b) => a.date.localeCompare(b.date));
  console.log(`${rows.length} rows match league filter "${leagueFilterArg}".`);

  const tournamentsSeen = [...new Set(rows.map(r => r.tournament))];
  console.log(`Tournament strings included: ${tournamentsSeen.join(', ')}\n`);

  interface Leg { date: string; confidence: number; odds: number; won: boolean; wentToOT: boolean; }
  const legs: Leg[] = [];
  let skippedNoOdds = 0;

  for (const game of rows) {
    const priorGames = rows.filter(g => g.date < game.date);
    const history = buildHistory(priorGames);

    const homeRecords = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const awayRecords = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) continue;

    const h2h: H2HRecord[] = priorGames
      .filter(g => (g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam) || (g.homeTeam === game.awayTeam && g.awayTeam === game.homeTeam))
      .map(g => {
        const flip = g.homeTeam !== game.homeTeam;
        const hs = flip ? g.awayScore : g.homeScore, as = flip ? g.homeScore : g.awayScore;
        return { date: g.date, homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeScore: hs, awayScore: as, winner: (hs > as ? 'home' : 'away') as 'home' | 'away' };
      });

    const stats: Stats = {
      id: `s-${game.date}-${game.homeTeam}-${game.awayTeam}`, matchId: `m-${game.date}`, sport: 'hockey',
      h2h, homeForm: toForm(homeRecords), awayForm: toForm(awayRecords),
      referee: {}, situational: {}, additionalContext: {},
      confidenceFactors: { dataCompleteness: 1, h2hSampleSize: h2h.length, formSampleSize: 10 },
    };
    const input: ModelInput = {
      match: { id: `m-${game.date}`, sport: 'hockey', homeTeam: game.homeTeam, awayTeam: game.awayTeam, startTime: game.date, league: leagueFilterArg },
      stats, odds: [],
    };

    const probs = getProbabilities(input);
    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const favHome = homeProb >= 0.5;
    const confidence = Math.max(homeProb, 1 - homeProb);
    const odds = favHome ? game.homeOdds : game.awayOdds;
    if (odds === null) { skippedNoOdds++; continue; } // no real price posted for this side

    const wentToOT = game.status !== 'Finished';
    // The core of the real-market advantage over --ot-convert: if the
    // game went to OT/shootout, the REAL 1X2 market settled it as a
    // Draw — a Home or Away pick genuinely lost, at real odds, not an
    // assumption. If it finished in regulation, settle by the real score.
    const won = wentToOT ? false : (favHome ? game.homeScore > game.awayScore : game.awayScore > game.homeScore);

    legs.push({ date: game.date, confidence, odds, won, wentToOT });
  }

  console.log(`${legs.length} qualifying predictions (5+ prior games each side, real odds available).`);
  if (skippedNoOdds) console.log(`(${skippedNoOdds} additional games skipped — no real price posted for the model's favored side.)\n`);
  else console.log('');

  console.log('Floor   Bets   Wins   Win%     AvgOdds   ROI%      Profit(Fixed)');
  const floorBooks: { floor: number; records: BetRecord[] }[] = [];
  for (const floor of FLOORS_TO_TEST) {
    const floorLegs = legs.filter(l => l.confidence >= floor);
    if (!floorLegs.length) { console.log(`${(floor * 100).toFixed(0)}%      0`); continue; }
    const records = buildBetRecords(floorLegs);
    floorBooks.push({ floor, records });
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

  console.log('\n-- Regulation vs OT/Shootout breakdown (real market settlement) --');
  for (const { floor, records } of floorBooks) {
    const reg = records.filter(r => !r.wentToOT);
    const ot = records.filter(r => r.wentToOT);
    const summarize = (rs: BetRecord[]) => {
      if (!rs.length) return 'no bets';
      const wins = rs.filter(r => r.won).length;
      const staked = rs.length * FIXED_STAKE;
      const profit = rs.reduce((s, r) => s + r.fixedProfit, 0);
      return `${rs.length} bets | ${((wins / rs.length) * 100).toFixed(1)}% win | ROI ${((profit / staked) * 100).toFixed(2)}%`;
    };
    console.log(`  Floor ${(floor * 100).toFixed(0)}%: regulation [${summarize(reg)}]  |  went to OT/SO [${summarize(ot)}]`);
  }

  console.log('\n(Settled using REAL regulation-time Home/Away odds and the REAL market');
  console.log(' result — OT/shootout games are a genuine loss because the real 1X2 market');
  console.log(' settled them as Draw, not an auto-loss rule or estimated conversion.)');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });