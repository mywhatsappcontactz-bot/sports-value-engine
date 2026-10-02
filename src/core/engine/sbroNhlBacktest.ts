// src/core/engine/sbroNhlBacktest.ts
//
// Real-odds NHL backtest using SportsbookReviewsOnline.com historical
// data (https://sportsbookreviewsonline.com/scoresoddsarchives/nhl/) —
// NOT the EliteProspects-derived --ot-convert estimate. This uses the
// REAL moneyline Open/Close prices SBRO recorded, and the REAL final
// score (confirmed 2026-09-14 via conversation: SBRO's "Final" column
// includes OT/shootout results — checked by finding a game where the
// period-by-period sum didn't match Final, e.g. Anaheim 1+1+2=4 periods
// but Final=5, confirming a hidden OT/SO goal folded into Final with no
// separate column). This makes SBRO's moneyline the correct market to
// backtest against for a real regulation-time-agnostic bet — no
// estimation/conversion needed, unlike the other 8 leagues which only
// have EliteProspects data and still need the --ot-convert formula.
//
// FILE FORMAT: SBRO's raw export has a header row that LOSES two column
// labels in translation — the real column count is 16, not the 13 names
// literally printed in the header. Confirmed by checking every sample
// row against a hypothesis and finding it internally consistent (e.g.
// PuckLine=1.5 paired with PuckLineOdds=-150, not "PuckLine=1.5" alone):
//   Date, Rot, VH, Team, 1st, 2nd, 3rd, Final, Open, Close,
//   PuckLine, PuckLineOdds, OpenOU, OpenOU_Odds, CloseOU, CloseOU_Odds
// Two consecutive rows (same Date+adjacent Rot) form one game. VH is
// 'V' (visitor/away), 'H' (home), or 'N' (neutral site — rare,
// typically international "Global Series" games). Row order convention
// observed in every sample: away row first, home row second. For 'N'/'N'
// pairs there's no true home team; the second-listed team is still
// treated as "home" for the model's sake (so it gets a prediction at
// all), but this means neutral games incorrectly receive a home-ice
// bump they shouldn't — a known, small imprecision, not worth
// special-casing for a small number of neutral games in a one-season
// pilot.
//
// SETTLEMENT: uses the CLOSE moneyline price (most representative of
// fair value) and the real Final score — no auto-loss-on-OT, no
// estimated conversion, because this IS the real incl.-OT market price.
//
// USAGE:
//   npx ts-node src/core/engine/sbroNhlBacktest.ts <path-to-file>
//   npx ts-node src/core/engine/sbroNhlBacktest.ts "C:\Users\USER\Documents\nhl pcukline.txt"
// If no path is given, looks for the first *.txt/*.csv file in the
// current directory whose name contains "nhl" (case-insensitive).

import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5; // same floor as hockeyBacktest1.ts
const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

// ─── FILE DISCOVERY ─────────────────────────────────────────────────────

function resolveInputPath(): string {
  const argPath = process.argv[2];
  if (argPath) {
    if (!fs.existsSync(argPath)) {
      console.error(`File not found: ${argPath}`);
      process.exit(1);
    }
    return argPath;
  }
  const dir = process.cwd();
  const candidates = fs.readdirSync(dir).filter(f => /nhl/i.test(f) && /\.(txt|csv)$/i.test(f));
  if (!candidates.length) {
    console.error('No file path given and no *nhl*.txt/*nhl*.csv found in current directory.');
    console.error('Usage: npx ts-node src/core/engine/sbroNhlBacktest.ts <path-to-file>');
    process.exit(1);
  }
  return path.join(dir, candidates[0]);
}

// ─── PARSING ────────────────────────────────────────────────────────────

interface SbroRow {
  date: string; // raw MMDD form as given in the file
  rot: number;
  vh: 'V' | 'H' | 'N';
  team: string;
  p1: number; p2: number; p3: number; final: number;
  open: number; close: number;
  puckLine: number; puckLineOdds: number;
  openOU: number; openOUOdds: number;
  closeOU: number; closeOUOdds: number;
}

// SUPPORTS TWO OBSERVED SBRO EXPORT FORMATS:
//   Format A (16 raw tokens per row): includes PuckLine/PuckLineOdds
//     columns, Final and Open are cleanly separated.
//   Format B (13 raw tokens per row, confirmed 2026-09-15 on a second
//     file): NO PuckLine columns at all, AND the Final and Open columns
//     are glued into a single token whenever there's no whitespace
//     between them in the source export — e.g. "2100" is really
//     Final=2, Open=100; "1-120" is really Final=1, Open=-120. Detected
//     by splitting at the first "-" if present (Open is negative), or
//     by taking the first digit as Final and the rest as Open if not
//     (Open is positive, since positive American odds never show a "+"
//     in this data). KNOWN LIMITATION: this heuristic assumes a
//     single-digit Final score — breaks for a 10+ goal final, which is
//     rare enough in real hockey to accept as a known gap rather than
//     build a more complex disambiguation for.
function splitFinalOpenToken(token: string): { final: number; open: number } | null {
  const dashIdx = token.indexOf('-', 1); // skip index 0 in case the whole token were negative (shouldn't happen for a score)
  if (dashIdx > 0) {
    const finalPart = token.slice(0, dashIdx);
    const openPart = token.slice(dashIdx); // includes the '-'
    if (/^\d+$/.test(finalPart) && /^-\d+$/.test(openPart)) {
      return { final: parseInt(finalPart, 10), open: parseInt(openPart, 10) };
    }
    return null;
  }
  // No '-' present: Final is the first digit, Open is the remainder
  // (positive odds, shown with no leading '+').
  if (token.length >= 2 && /^\d+$/.test(token)) {
    return { final: parseInt(token[0], 10), open: parseInt(token.slice(1), 10) };
  }
  return null;
}

let unrecognizedRowCount = 0;

function parseRows(text: string): SbroRow[] {
  const lines = text.trim().split(/\r?\n/);
  const rows: SbroRow[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue; // clearly not a data row (header, blank, etc.)
    if (!/^\d+$/.test(fields[0])) continue; // guards against a stray header line slipping through
    const vhField = fields[2];
    if (vhField !== 'V' && vhField !== 'H' && vhField !== 'N') continue;
    const n = (s: string) => parseFloat(s);

    if (fields.length === 16) {
      // Format A: Final and Open already separate, PuckLine present.
      const [date, rot, vh, team, p1, p2, p3, final, open, close, puckLine, puckLineOdds, openOU, openOUOdds, closeOU, closeOUOdds] = fields;
      rows.push({
        date, rot: n(rot), vh: vh as 'V' | 'H' | 'N', team,
        p1: n(p1), p2: n(p2), p3: n(p3), final: n(final),
        open: n(open), close: n(close),
        puckLine: n(puckLine), puckLineOdds: n(puckLineOdds),
        openOU: n(openOU), openOUOdds: n(openOUOdds),
        closeOU: n(closeOU), closeOUOdds: n(closeOUOdds),
      });
      continue;
    }

    if (fields.length === 14) {
      // Format B: confirmed directly via PowerShell split (2026-09-15) —
      // NO gluing, all 14 fields already separate, just missing the
      // PuckLine/PuckLineOdds columns Format A has. (An earlier guess at
      // this format assumed Final+Open were glued together based on how
      // the text rendered when pasted into chat — that was a copy/paste
      // rendering artifact, not real file content; ground-truth checking
      // via PowerShell directly against the file is what caught it.)
      const [date, rot, vh, team, p1, p2, p3, final, open, close, openOU, openOUOdds, closeOU, closeOUOdds] = fields;
      rows.push({
        date, rot: n(rot), vh: vh as 'V' | 'H' | 'N', team,
        p1: n(p1), p2: n(p2), p3: n(p3), final: n(final),
        open: n(open), close: n(close),
        puckLine: NaN, puckLineOdds: NaN, // not present in this format, unused downstream
        openOU: n(openOU), openOUOdds: n(openOUOdds),
        closeOU: n(closeOU), closeOUOdds: n(closeOUOdds),
      });
      continue;
    }

    unrecognizedRowCount++; // visible instead of silently vanishing
  }
  if (unrecognizedRowCount) {
    console.log(`(${unrecognizedRowCount} row(s) had an unrecognized field count/shape and were skipped — worth spot-checking if this number is large.)`);
  }
  return rows;
}

// SBRO dates are MMDD with no year and no explicit season rollover
// marker. NHL seasons run Oct-Jun, so a date "sequence number" (position
// in file order) is used for chronological sorting WITHIN this single
// file/season rather than trying to reconstruct a real calendar date —
// good enough for one season's rolling history, not safe to reuse
// across multiple pooled seasons without real year disambiguation.
interface SbroGame {
  seq: number; // file order, used as the sort/chronology key
  dateLabel: string;
  awayTeam: string; awayScore: number;
  homeTeam: string; homeScore: number;
  homeMoneylineClose: number; awayMoneylineClose: number;
  neutral: boolean;
}

function pairRowsIntoGames(rows: SbroRow[]): SbroGame[] {
  const games: SbroGame[] = [];
  let seq = 0;
  for (let i = 0; i < rows.length - 1; i += 2) {
    const a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; } // resync if pairing drifted
    // Row-order convention: away row first, home row second (see file
    // header comment). Neutral ('N'/'N') pairs follow the same order —
    // second-listed team is nominally "home" for the model.
    games.push({
      seq: seq++,
      dateLabel: a.date,
      awayTeam: a.team, awayScore: a.final,
      homeTeam: b.team, homeScore: b.final,
      awayMoneylineClose: a.close, homeMoneylineClose: b.close,
      neutral: a.vh === 'N',
    });
  }
  return games;
}

// ─── AMERICAN ODDS -> DECIMAL ────────────────────────────────────────────

function americanToDecimal(american: number): number {
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

// ─── HISTORY / MODEL INPUT CONSTRUCTION ────────────────────────────────
// Mirrors leagueDetailedReport.ts's history-building pattern (push per
// team, slice last 10 for form) so Stats objects here are shaped exactly
// like every other hockey backtest in this codebase.

interface TeamRecord { date: number; opp: string; res: 'W' | 'L'; home: boolean; pf: number; pa: number; }

function buildHistory(games: SbroGame[]): Map<string, TeamRecord[]> {
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

// ─── BET RECORD / STAKING (same pattern as leagueDetailedReport.ts) ────

interface BetRecord {
  seq: number; won: boolean; odds: number;
  fixedProfit: number; fixedBalanceAfter: number;
}

function buildBetRecords(legs: { seq: number; won: boolean; odds: number }[]): BetRecord[] {
  let balance = INITIAL_CAPITAL;
  const records: BetRecord[] = [];
  for (const l of legs) {
    const profit = l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE;
    balance += profit;
    records.push({ seq: l.seq, won: l.won, odds: l.odds, fixedProfit: profit, fixedBalanceAfter: balance });
  }
  return records;
}

function fmtNaira(n: number): string {
  return `₦${Math.round(n).toLocaleString()}`;
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const inputPath = resolveInputPath();
  console.log(`Reading: ${inputPath}\n`);

  const text = fs.readFileSync(inputPath, 'utf-8');
  const rows = parseRows(text);
  console.log(`Parsed ${rows.length} raw rows.`);

  const games = pairRowsIntoGames(rows).sort((a, b) => a.seq - b.seq);
  console.log(`Paired into ${games.length} games.`);

  // FILTER: exclude deep preseason (August + first half of September).
  // Confirmed 2026-09-15: several "neutral-site" August rows turned out
  // to be split-squad/exhibition games — not meaningful real-season data
  // for a betting model. One also had a real parsing hazard: a short
  // team name (e.g. "Florida", "Chicago") ran directly into the next
  // numeric field with no whitespace in the raw file, silently shifting
  // every subsequent field in that row. Rather than patch the parser for
  // that edge case, these games are cut outright — this removes the
  // corrupted rows as a side effect of removing games that shouldn't be
  // in the backtest anyway.
  function parseMonthDay(dateLabel: string): { month: number; day: number } {
    const s = dateLabel.trim();
    if (s.length === 3) return { month: parseInt(s[0], 10), day: parseInt(s.slice(1), 10) };
    return { month: parseInt(s.slice(0, 2), 10), day: parseInt(s.slice(2), 10) };
  }
  function isPreseasonNoise(dateLabel: string): boolean {
    const { month, day } = parseMonthDay(dateLabel);
    if (month === 8) return true; // all of August
    if (month === 9 && day < 15) return true; // first half of September
    return false;
  }
  const preseasonCount = games.filter(g => isPreseasonNoise(g.dateLabel)).length;
  const realSeasonGames = games.filter(g => !isPreseasonNoise(g.dateLabel));
  console.log(`Excluded ${preseasonCount} deep-preseason game(s) (August / pre-Sep-15) — see file header caveat.`);
  const neutralCount = realSeasonGames.filter(g => g.neutral).length;
  if (neutralCount) console.log(`  (${neutralCount} genuine neutral-site games remain in the real-season set — home-ice bump still applied to the nominal "home" team anyway, see file header caveat)`);

  interface Leg { seq: number; confidence: number; odds: number; won: boolean; edge: number; matchesMarketFavorite: boolean; }
  const legs: Leg[] = [];

  for (const game of realSeasonGames) {
    const priorGames = realSeasonGames.filter(g => g.seq < game.seq);
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
    const input: ModelInput = {
      match: { id: `m-${game.seq}`, sport: 'hockey', homeTeam: game.homeTeam, awayTeam: game.awayTeam, startTime: String(game.seq), league: 'NHL' },
      stats, odds: [],
    };

    const probs = getProbabilities(input);
    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const favHome = homeProb >= 0.5;
    const confidence = Math.max(homeProb, 1 - homeProb);
    const americanOdds = favHome ? game.homeMoneylineClose : game.awayMoneylineClose;
    const odds = americanToDecimal(americanOdds);
    const won = favHome ? game.homeScore > game.awayScore : game.awayScore > game.homeScore;

    // ── EDGE (real value vs. the market, not just model confidence) ──
    // Confidence alone doesn't mean a bet is good — a 65%-confident pick
    // is worthless if the real market ALREADY implies 68% for that side.
    // Edge = model's calibrated probability minus the market's own
    // implied probability for the same side, with the market's vig
    // removed by normalizing both sides' implied probabilities to sum
    // to 1 (standard vig-removal approach). Positive edge means the
    // model disagrees with the market in your favor; edge near/below
    // zero means you're just betting the market's own price back at it,
    // which loses to the vig by construction over time.
    const homeDecimal = americanToDecimal(game.homeMoneylineClose);
    const awayDecimal = americanToDecimal(game.awayMoneylineClose);
    const impliedHomeRaw = 1 / homeDecimal;
    const impliedAwayRaw = 1 / awayDecimal;
    const impliedTotal = impliedHomeRaw + impliedAwayRaw; // >1 due to vig
    const marketImpliedFavored = favHome ? (impliedHomeRaw / impliedTotal) : (impliedAwayRaw / impliedTotal);
    const edge = confidence - marketImpliedFavored;
    // Does the model just pick whichever side the REAL market already
    // favors, or does it ever genuinely go against the market's own
    // favorite? If this is ~100%, the model isn't adding independent
    // information — it's mirroring the market's own pricing, which
    // would fully explain both the lack of edge AND why "disagreeing
    // more" (the edge-threshold test) gets worse, not better: the rare
    // times it does disagree are essentially blind underdog picks with
    // no real basis behind them.
    const marketFavoredHome = impliedHomeRaw > impliedAwayRaw;
    const matchesMarketFavorite = favHome === marketFavoredHome;

    legs.push({ seq: game.seq, confidence, odds, won, edge, matchesMarketFavorite });
  }

  console.log(`\n${legs.length} qualifying predictions (5+ prior games each side).\n`);

  // ── IS THE MODEL JUST PICKING THE MARKET FAVORITE? ──────────────────
  const agreesCount = legs.filter(l => l.matchesMarketFavorite).length;
  const disagreesCount = legs.length - agreesCount;
  console.log(`=== Does the model just pick the market's own favorite? ===`);
  console.log(`Model picked the SAME side as the real market's favorite: ${agreesCount}/${legs.length} (${((agreesCount / legs.length) * 100).toFixed(1)}%)`);
  console.log(`Model picked AGAINST the market's favorite (a real underdog pick): ${disagreesCount}/${legs.length} (${((disagreesCount / legs.length) * 100).toFixed(1)}%)`);
  if (disagreesCount > 0) {
    const disagreeLegs = legs.filter(l => !l.matchesMarketFavorite);
    const disagreeRecords = buildBetRecords(disagreeLegs);
    const disagreeWins = disagreeRecords.filter(r => r.won).length;
    const disagreeStaked = disagreeRecords.length * FIXED_STAKE;
    const disagreeProfit = disagreeRecords.reduce((s, r) => s + r.fixedProfit, 0);
    console.log(`  Those underdog picks alone: ${disagreeRecords.length} bets, ${((disagreeWins / disagreeRecords.length) * 100).toFixed(1)}% win rate, ROI ${((disagreeProfit / disagreeStaked) * 100).toFixed(2)}%`);
  }
  console.log('(If agreement is near 100%, the model has no real independent signal —');
  console.log(' it is just relabeling the market\'s own favorite as its "prediction.")\n');

  console.log('Floor   Bets   Wins   Win%     AvgOdds   ROI%      Profit(Fixed)');
  for (const floor of FLOORS_TO_TEST) {
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

  // ── WERE WE EVER UP? Running-balance peak/trough, not just the final
  //    number. A season can end negative while still having spent real
  //    time above the starting capital — that's a different, useful
  //    question from "is the final ROI positive." ────────────────────
  console.log('\n=== Running balance: were we ever up, and by how much? ===');
  console.log('Floor   Peak(+)          Peak%     Bets-to-peak   Trough(-)         Trough%   %-of-bets-above-water');
  for (const floor of FLOORS_TO_TEST) {
    const floorLegs = legs.filter(l => l.confidence >= floor);
    if (!floorLegs.length) continue;
    const records = buildBetRecords(floorLegs);

    let peakBalance = INITIAL_CAPITAL, peakIdx = -1;
    let troughBalance = INITIAL_CAPITAL, troughIdx = -1;
    let aboveWaterCount = 0;
    records.forEach((r, i) => {
      if (r.fixedBalanceAfter > peakBalance) { peakBalance = r.fixedBalanceAfter; peakIdx = i; }
      if (r.fixedBalanceAfter < troughBalance) { troughBalance = r.fixedBalanceAfter; troughIdx = i; }
      if (r.fixedBalanceAfter > INITIAL_CAPITAL) aboveWaterCount++;
    });
    const peakPct = ((peakBalance - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
    const troughPct = ((troughBalance - INITIAL_CAPITAL) / INITIAL_CAPITAL) * 100;
    const pctAboveWater = (aboveWaterCount / records.length) * 100;
    console.log(
      `${(floor * 100).toFixed(0)}%     ${fmtNaira(peakBalance).padStart(14)}   ` +
      `${(peakPct >= 0 ? '+' : '') + peakPct.toFixed(2)}%   ${String(peakIdx + 1).padStart(5)}/${records.length}   ` +
      `${fmtNaira(troughBalance).padStart(14)}   ${(troughPct >= 0 ? '+' : '') + troughPct.toFixed(2)}%   ` +
      `${pctAboveWater.toFixed(1)}%`
    );
  }
  console.log('(Peak% shows the BEST the running balance ever got above the ₦1,000,000');
  console.log(' start — if positive, you were genuinely up at some point even if the');
  console.log(' season ended negative. "%-of-bets-above-water" is how much of the whole');
  console.log(' run you would have been sitting on a profit, not just the final number.)');

  console.log('\n(Settled using real SBRO Close moneyline price and real Final score —');
  console.log(' no estimated conversion, no auto-loss-on-OT. This is the real market.)');

  // ── VALUE-BASED SELECTION (edge vs. market, not raw confidence) ────
  console.log('\n\n=== VALUE-BASED SELECTION (edge over the real market price) ===');
  console.log('Selects bets by how much the model DISAGREES with the market, not by');
  console.log('raw confidence alone. Edge = model probability - market implied probability');
  console.log('(vig removed). A 65%-confident pick the market already prices at 65% has');
  console.log('ZERO edge and should not show up as attractive just because confidence is high.\n');

  const EDGE_THRESHOLDS = [0.00, 0.02, 0.04, 0.06, 0.08, 0.10];
  console.log('Edge>=   Bets   Wins   Win%     AvgOdds   ROI%      Profit(Fixed)');
  for (const threshold of EDGE_THRESHOLDS) {
    const edgeLegs = legs.filter(l => l.edge >= threshold);
    if (!edgeLegs.length) { console.log(`${(threshold * 100).toFixed(0)}%       0`); continue; }
    const records = buildBetRecords(edgeLegs);
    const wins = records.filter(r => r.won).length;
    const avgOdds = records.reduce((s, r) => s + r.odds, 0) / records.length;
    const staked = records.length * FIXED_STAKE;
    const profit = records.reduce((s, r) => s + r.fixedProfit, 0);
    const roi = (profit / staked) * 100;
    console.log(
      `${(threshold * 100).toFixed(0)}%      ${String(records.length).padStart(4)}   ${String(wins).padStart(4)}   ` +
      `${((wins / records.length) * 100).toFixed(1).padStart(5)}%   ${avgOdds.toFixed(3).padStart(7)}   ` +
      `${roi.toFixed(2).padStart(7)}%   ${fmtNaira(profit).padStart(14)}`
    );
  }

  // ── COMBINED: confidence floor AND a real edge requirement ─────────
  // The real, honest test: does requiring BOTH a reasonable confidence
  // floor AND genuine value vs. the market do better than either alone?
  console.log('\n=== COMBINED: confidence floor 55%+ AND edge threshold ===');
  console.log('Floor+Edge>=   Bets   Wins   Win%     AvgOdds   ROI%      Profit(Fixed)');
  const combinedLegs55 = legs.filter(l => l.confidence >= 0.55);
  for (const threshold of EDGE_THRESHOLDS) {
    const filtered = combinedLegs55.filter(l => l.edge >= threshold);
    if (!filtered.length) { console.log(`55%+${(threshold * 100).toFixed(0)}%       0`); continue; }
    const records = buildBetRecords(filtered);
    const wins = records.filter(r => r.won).length;
    const avgOdds = records.reduce((s, r) => s + r.odds, 0) / records.length;
    const staked = records.length * FIXED_STAKE;
    const profit = records.reduce((s, r) => s + r.fixedProfit, 0);
    const roi = (profit / staked) * 100;
    console.log(
      `55%+${(threshold * 100).toFixed(0)}%       ${String(records.length).padStart(4)}   ${String(wins).padStart(4)}   ` +
      `${((wins / records.length) * 100).toFixed(1).padStart(5)}%   ${avgOdds.toFixed(3).padStart(7)}   ` +
      `${roi.toFixed(2).padStart(7)}%   ${fmtNaira(profit).padStart(14)}`
    );
  }

  console.log('\n(If ROI improves as the edge threshold rises, that is real evidence the');
  console.log(' model has genuine information the market lacks. If ROI does NOT improve');
  console.log(' with higher edge requirements, the model is not finding real value — it is');
  console.log(' just occasionally agreeing with an already-efficient market by chance.)');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });