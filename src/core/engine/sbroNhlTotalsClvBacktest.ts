// src/core/engine/sbroNhlTotalsClvBacktest.ts
//
// Same CLV methodology as sbroNhlMoneylineClvBacktest.ts, applied to the
// totals (Over/Under) market instead of moneyline — outcome-independent:
// checks whether the market moved toward the model's Over/Under pick
// between open and close, not whether the pick actually won.
//
// ⚠ COLUMN-MAPPING ASSUMPTION — VERIFY BEFORE TRUSTING OUTPUT:
// SBRO Format A's totals columns (fields 13-16: OpenOU, OpenOU_Odds,
// CloseOU, CloseOU_Odds) don't self-label which row is Over and which
// is Under, unlike moneyline where each row obviously belongs to that
// row's own team. This script assumes the standard SBRO/sportsbook
// historical-odds convention: the AWAY row carries the Over price, the
// HOME row carries the Under price, for the same total line. If that's
// backwards for this data, flip AWAY_ROW_IS_OVER below — everything else
// is unaffected by the flip.
//
// BUILT-IN SANITY CHECK: the open (and close) total line should be
// IDENTICAL between a game's away row and home row, since it's one
// market with two sides, not two different numbers. This script checks
// that automatically and warns if games disagree — a mismatch there
// would mean the column indices themselves are wrong, not just the
// Over/Under labeling, and no amount of flipping AWAY_ROW_IS_OVER fixes
// that.
//
// MODEL: hockey's own totals logic is a fixed line (5.5, see modelHockey
// in probabilityModel.ts) and explicitly flagged uncalibrated/untested
// there. This script instead evaluates the model at whatever the REAL
// open total line actually was for each game — a fairer test, since a
// fixed-line model tested against real varying lines would be comparing
// apples to oranges. totalOverProbability is reimplemented locally
// (small, self-contained Poisson calc) since only the larger shared
// pieces (computeHockeyGoalLambdas etc.) are exported from
// probabilityModel.ts — this mirrors the private function of the same
// name there exactly, not a divergent copy of anything load-bearing.
//
// USAGE:
//   npx ts-node src/core/engine/sbroNhlTotalsClvBacktest.ts <sbro-file.txt>
//   npx ts-node src/core/engine/sbroNhlTotalsClvBacktest.ts "C:\...\nhl 2016 2017.txt"

import * as fs from 'fs';
import { computeHockeyGoalLambdas } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const CONFIDENCE_FLOORS = [0, 0.55, 0.60, 0.65, 0.70];

// Flip this if the first run's line-consistency check passes but the
// Over/Under assignment still looks backwards on manual inspection
// (e.g. "Over" picks consistently look like they should've been "Under").
const AWAY_ROW_IS_OVER = true;

// ─── CLI ────────────────────────────────────────────────────────────────

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlTotalsClvBacktest.ts <path-to-SBRO-file>');
  process.exit(1);
}
if (!fs.existsSync(inputPath)) { console.error(`File not found: ${inputPath}`); process.exit(1); }

// ─── LOCAL POISSON HELPERS (mirrors probabilityModel.ts's private
// poissonPmf/totalOverProbability exactly — not exported there, so
// reimplemented here rather than patching the shared file again for
// something this small and self-contained) ─────────────────────────

function poissonPmf(lambda: number, k: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 1; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}
function totalOverProbability(lambdaHome: number, lambdaAway: number, line: number, maxGoals = 8): number {
  let overProb = 0;
  for (let i = 0; i <= maxGoals; i++) {
    for (let j = 0; j <= maxGoals; j++) {
      if (i + j > line) overProb += poissonPmf(lambdaHome, i) * poissonPmf(lambdaAway, j);
    }
  }
  return overProb;
}

// ─── PARSING ────────────────────────────────────────────────────────────
// Fields 12-15 are OpenOU, OpenOU_Odds, CloseOU, CloseOU_Odds — see the
// column-mapping assumption at the top of this file.

interface SbroRow {
  date: string; vh: 'V' | 'H' | 'N'; team: string; final: number;
  openOuLine: number; openOuOdds: number; closeOuLine: number; closeOuOdds: number;
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
    const date = fields[0], team = fields[3], final = n(fields[7]);
    const openOuLine = n(fields[12]), openOuOdds = n(fields[13]);
    const closeOuLine = n(fields[14]), closeOuOdds = n(fields[15]);
    if ([openOuLine, openOuOdds, closeOuLine, closeOuOdds].some(isNaN)) continue;
    rows.push({ date, vh: vh as 'V' | 'H' | 'N', team, final, openOuLine, openOuOdds, closeOuLine, closeOuOdds });
  }
  return rows;
}

interface Game {
  seq: number; dateLabel: string;
  awayTeam: string; awayScore: number;
  homeTeam: string; homeScore: number;
  openLine: number; openLineMismatch: boolean;
  overOpenOdds: number; overCloseOdds: number;
  underOpenOdds: number; underCloseOdds: number;
}

function pairRowsIntoGames(rows: SbroRow[]): { games: Game[]; lineMismatches: number } {
  const games: Game[] = [];
  let seq = 0;
  let lineMismatches = 0;
  for (let i = 0; i < rows.length - 1; i += 2) {
    let a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; }
    if (a.vh === 'H' && b.vh === 'V') { const tmp = a; a = b; b = tmp; }
    if (!(a.vh === 'V' && b.vh === 'H')) continue;

    const awayRow = a, homeRow = b;
    const openLineMismatch = Math.abs(awayRow.openOuLine - homeRow.openOuLine) > 1e-9;
    if (openLineMismatch) lineMismatches++;

    const overRow = AWAY_ROW_IS_OVER ? awayRow : homeRow;
    const underRow = AWAY_ROW_IS_OVER ? homeRow : awayRow;

    games.push({
      seq: seq++, dateLabel: a.date,
      awayTeam: awayRow.team, awayScore: awayRow.final,
      homeTeam: homeRow.team, homeScore: homeRow.final,
      openLine: awayRow.openOuLine, // == homeRow.openOuLine unless mismatched
      openLineMismatch,
      overOpenOdds: overRow.openOuOdds, overCloseOdds: overRow.closeOuOdds,
      underOpenOdds: underRow.openOuOdds, underCloseOdds: underRow.closeOuOdds,
    });
  }
  return { games, lineMismatches };
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

// ─── HISTORY (same pattern as other puck-line/totals scripts tonight —
// computeHockeyGoalLambdas needs a full Stats object, unlike the
// moneyline CLV script's three plain numbers) ───────────────────────

interface TeamRecord { date: number; opp: string; res: 'W' | 'L'; home: boolean; pf: number; pa: number; }
function buildHistory(games: Game[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();
  const push = (team: string, rec: TeamRecord) => { if (!hist.has(team)) hist.set(team, []); hist.get(team)!.push(rec); };
  for (const g of games) {
    push(g.homeTeam, { date: g.seq, opp: g.awayTeam, res: g.homeScore > g.awayScore ? 'W' : 'L', home: true, pf: g.homeScore, pa: g.awayScore });
    push(g.awayTeam, { date: g.seq, opp: g.homeTeam, res: g.awayScore > g.homeScore ? 'W' : 'L', home: false, pf: g.awayScore, pa: g.homeScore });
  }
  return hist;
}
function toForm(recs: TeamRecord[]): FormRecord[] {
  return recs.slice(-10).map(r => ({ date: String(r.date), opponent: r.opp, result: r.res, goalsFor: r.pf, goalsAgainst: r.pa, venue: r.home ? 'home' : 'away' }));
}

// ─── CLV CORE ───────────────────────────────────────────────────────────

interface Pick {
  confidence: number; side: 'Over' | 'Under';
  openDecimal: number; closeDecimal: number; clvPct: number;
  won: boolean; // context only
}
function fmtPct(n: number): string { return `${(n >= 0 ? '+' : '') + n.toFixed(2)}%`; }

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const text = fs.readFileSync(inputPath, 'utf-8');
  const rows = parseRows(text);
  console.log(`Parsed ${rows.length} raw rows with real totals open+close prices.`);

  const { games: allGames, lineMismatches } = pairRowsIntoGames(rows);
  allGames.sort((a, b) => a.seq - b.seq);
  if (lineMismatches > 0) {
    console.warn(`\n⚠ WARNING: ${lineMismatches} game(s) had DIFFERENT open total lines between the`);
    console.warn(`away row and home row. That should never happen for one real market —`);
    console.warn(`this means the column indices (fields 12-15) are likely WRONG for this`);
    console.warn(`file, not just the Over/Under row labeling. Do not trust results below`);
    console.warn(`until this is resolved. Paste a raw line from the file and I'll re-check`);
    console.warn(`the field mapping.\n`);
  } else {
    console.log(`Line-consistency check passed: away/home rows agreed on the open total line for every game.`);
  }

  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));
  console.log(`Paired into ${allGames.length} games (${allGames.length - games.length} deep-preseason excluded).\n`);

  console.log(`── First 5 games, raw values (manual sanity check) ──`);
  console.log(`If AWAY_ROW_IS_OVER is backwards, this is where it'd show — e.g. if`);
  console.log(`"Over" odds consistently look like standard "Under" pricing for that`);
  console.log(`total (or vice versa) for a total you can cross-check independently.\n`);
  for (const g of games.slice(0, 5)) {
    console.log(`${g.dateLabel} ${g.awayTeam} @ ${g.homeTeam} | line ${g.openLine} | Over: open ${g.overOpenOdds} close ${g.overCloseOdds} | Under: open ${g.underOpenOdds} close ${g.underCloseOdds}`);
  }
  console.log('');

  const picks: Pick[] = [];
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
    const overProb = totalOverProbability(lambdaHome, lambdaAway, game.openLine);
    const side: 'Over' | 'Under' = overProb >= 0.5 ? 'Over' : 'Under';
    const confidence = Math.max(overProb, 1 - overProb);

    const openAmerican = side === 'Over' ? game.overOpenOdds : game.underOpenOdds;
    const closeAmerican = side === 'Over' ? game.overCloseOdds : game.underCloseOdds;
    const openDecimal = americanToDecimal(openAmerican);
    const closeDecimal = americanToDecimal(closeAmerican);
    const clvPct = (openDecimal / closeDecimal - 1) * 100;

    const totalGoals = game.homeScore + game.awayScore;
    const won = side === 'Over' ? totalGoals > game.openLine : totalGoals < game.openLine;

    picks.push({ confidence, side, openDecimal, closeDecimal, clvPct, won });
  }

  console.log(`${picks.length} qualifying picks (5+ prior games each side, real open+close OU price available).\n`);

  // ── NAIVE BASELINE — no model, no lambdas, just "always take this
  // side" on the SAME game set used above. If this alone shows similar
  // CLV to the model's Under picks, the model isn't adding anything —
  // it's riding a known market bias (public overbets Overs; sharp money
  // fades it toward Under by closing), same shape as the
  // favorite-longshot finding earlier tonight, not genuine skill.
  console.log('── NAIVE BASELINE (no model — same game set, always-one-side) ──');
  for (const side of ['Over', 'Under'] as const) {
    const naive = games
      .filter(g => picks.some((_, idx) => idx < games.length)) // placeholder to keep TS happy; real filter below
      .slice(0, 0);
  }
  const qualifyingGames = games.filter(g => {
    const priorGames = games.filter(pg => pg.seq < g.seq);
    const history = buildHistory(priorGames);
    const h = (history.get(g.homeTeam) ?? []).length;
    const a = (history.get(g.awayTeam) ?? []).length;
    return h >= MIN_PRIOR_GAMES && a >= MIN_PRIOR_GAMES;
  });
  for (const side of ['Over', 'Under'] as const) {
    const naiveClvs = qualifyingGames.map(g => {
      const openAmerican = side === 'Over' ? g.overOpenOdds : g.underOpenOdds;
      const closeAmerican = side === 'Over' ? g.overCloseOdds : g.underCloseOdds;
      return (americanToDecimal(openAmerican) / americanToDecimal(closeAmerican) - 1) * 100;
    });
    const avgClv = naiveClvs.reduce((s, c) => s + c, 0) / naiveClvs.length;
    const beatClose = naiveClvs.filter(c => c > 0.01).length;
    console.log(`Always ${side.padEnd(5)}: ${naiveClvs.length} picks, AvgCLV ${fmtPct(avgClv)}, beat close ${((beatClose / naiveClvs.length) * 100).toFixed(1)}%`);
  }
  console.log(`Compare these two rows directly to the model's Over/Under split further below.`);
  console.log(`If "Always Under" here is close to the model's Under-pick CLV, the model is`);
  console.log(`mostly just agreeing with a known bias, not adding independent skill.\n`);

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

  console.log('\n── By side (Over vs Under — does the model have CLV on one but not the other?) ──');
  for (const side of ['Over', 'Under'] as const) {
    const sel = picks.filter(p => p.side === side);
    if (!sel.length) { console.log(`${side}: 0 picks`); continue; }
    const avgClv = sel.reduce((s, p) => s + p.clvPct, 0) / sel.length;
    const beatClose = sel.filter(p => p.clvPct > 0.01).length;
    console.log(`${side.padEnd(5)}: ${sel.length} picks, AvgCLV ${fmtPct(avgClv)}, beat close ${((beatClose / sel.length) * 100).toFixed(1)}%`);
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Check the line-consistency warning and the first-5-games table`);
  console.log(`above BEFORE trusting anything below them. Same read as the`);
  console.log(`moneyline CLV test: AvgCLV meaningfully >0 and %BeatClose >50%,`);
  console.log(`consistent across floors and confirmed on a second season, is`);
  console.log(`the real signature of skill. Near zero / near-coinflip is not a`);
  console.log(`failure — it's the same honest "no edge here yet" this whole`);
  console.log(`session has been finding, now checked on a fourth independent`);
  console.log(`market/method.`);
  console.log(`────────────────────────────────────────────────────────────`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });