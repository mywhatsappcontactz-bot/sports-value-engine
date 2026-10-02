// src/core/engine/trackLiveBets.ts
//
// Compares your actual logged bets (bet_log.csv) against what the
// backtest predicted for each floor (baseline_stats.json, written by
// leagueDetailedReport.ts). Answers: "is live performance drifting from
// what the model showed historically, or is this normal variance?"
//
// USAGE:
//   1. Run leagueDetailedReport.ts at least once so baseline_stats.json exists.
//   2. After each real bet, add a row to bet_log.csv:
//        Date,League,Floor,Book,HomeTeam,AwayTeam,Selection,OddsTaken,Stake,Result,Notes
//      Result is W, L, or Pending (pending rows are ignored until settled).
//      Floor is the number only (55, 60, 65, 70), matching your book split.
//   3. npx ts-node src/core/engine/trackLiveBets.ts
//
// This does NOT try to be clever about statistical significance beyond a
// simple Wilson-lower-bound check per floor (same method as the league
// ranking) - with live bet counts this low early on, treat every flag as
// "worth watching," not "proven broken." The bar for real concern is
// weeks of drift, not one bad day.

import * as fs from 'fs';
import * as path from 'path';

const FIXED_STAKE = 10_000;
const MIN_BETS_FOR_COMPARISON = 15; // below this, drift is just noise - don't flag

interface LiveBet { date: string; league: string; floor: number; book: string; oddsTaken: number; stake: number; won: boolean; }
interface Baseline { bets: number; winPct: number; avgOdds: number; roiPct: number; }

function parseCsv(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
}

function loadLiveBets(csvPath: string): LiveBet[] {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { date: col('Date'), league: col('League'), floor: col('Floor'), book: col('Book'), odds: col('OddsTaken'), stake: col('Stake'), result: col('Result') };
  const bets: LiveBet[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const result = r[idx.result]?.trim();
    if (result !== 'W' && result !== 'L') continue; // skip Pending / blank
    const floor = parseInt(r[idx.floor]);
    const odds = parseFloat(r[idx.odds]);
    const stake = parseFloat(r[idx.stake]);
    if (isNaN(floor) || isNaN(odds) || isNaN(stake)) continue;
    bets.push({ date: r[idx.date], league: r[idx.league], floor, book: r[idx.book], oddsTaken: odds, stake, won: result === 'W' });
  }
  return bets;
}

function wilsonLowerBound(wins: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (center - margin) / denom;
}

function main() {
  const betLogPath = path.join(process.cwd(), 'bet_log.csv');
  const baselinePath = path.join(process.cwd(), 'baseline_stats.json');

  if (!fs.existsSync(betLogPath)) { console.error(`bet_log.csv not found at ${betLogPath}`); process.exit(1); }
  if (!fs.existsSync(baselinePath)) { console.error(`baseline_stats.json not found - run leagueDetailedReport.ts first.`); process.exit(1); }

  const liveBets = loadLiveBets(betLogPath);
  const baseline: Record<string, Baseline> = JSON.parse(fs.readFileSync(baselinePath, 'utf-8'));

  if (!liveBets.length) { console.log('No settled (W/L) bets logged yet.'); return; }

  const floors = [...new Set(liveBets.map(b => b.floor))].sort((a, b) => a - b);

  console.log('LIVE vs BACKTEST comparison\n');
  console.log('Floor  Bets  Win%(live)  Win%(backtest)  WilsonLB%  AvgOdds(live)  AvgOdds(backtest)  ROI%(live)  Flag');

  for (const floor of floors) {
    const bets = liveBets.filter(b => b.floor === floor);
    const wins = bets.filter(b => b.won).length;
    const winPct = (wins / bets.length) * 100;
    const avgOdds = bets.reduce((s, b) => s + b.oddsTaken, 0) / bets.length;
    const staked = bets.reduce((s, b) => s + b.stake, 0);
    const profit = bets.reduce((s, b) => s + (b.won ? b.stake * (b.oddsTaken - 1) : -b.stake), 0);
    const roiPct = (profit / staked) * 100;
    const wlb = wilsonLowerBound(wins, bets.length) * 100;

    const base = baseline[`floor_${floor}`];
    if (!base) {
      console.log(`${floor}%    ${String(bets.length).padStart(4)}  ${winPct.toFixed(1).padStart(9)}%  (no baseline for floor_${floor} in baseline_stats.json)`);
      continue;
    }

    let flag = '';
    if (bets.length < MIN_BETS_FOR_COMPARISON) {
      flag = `too few bets (<${MIN_BETS_FOR_COMPARISON}) to compare yet`;
    } else {
      const oddsGap = avgOdds - base.avgOdds;
      const winGapVsWLB = wlb - base.winPct; // is even the worst-case live win rate still near backtest?
      const flags: string[] = [];
      if (oddsGap < -0.10) flags.push(`odds running ${Math.abs(oddsGap).toFixed(2)} below backtest avg - check for line shading/limits`);
      if (winGapVsWLB < -8) flags.push(`win rate meaningfully below backtest even in your best statistical case`);
      flag = flags.length ? flags.join('; ') : 'in line with backtest';
    }

    console.log(`${floor}%    ${String(bets.length).padStart(4)}  ${winPct.toFixed(1).padStart(9)}%  ${base.winPct.toFixed(1).padStart(13)}%  ${wlb.toFixed(1).padStart(8)}%  ${avgOdds.toFixed(3).padStart(12)}  ${base.avgOdds.toFixed(3).padStart(17)}  ${roiPct.toFixed(2).padStart(9)}%  ${flag}`);
  }

  console.log('\nWilsonLB% = worst-case (95% confidence) live win rate given how many bets you\'ve');
  console.log('placed so far. Compare this to backtest win% - if it\'s still close, the drift you');
  console.log('might be seeing in the raw live win% is just normal variance at a small sample.');
}

main();