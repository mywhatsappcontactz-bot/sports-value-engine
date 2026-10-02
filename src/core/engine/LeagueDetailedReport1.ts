// src/core/engine/leagueDetailedReport.ts
//
// Auto-detects every league CSV in the current directory (any *_all.csv,
// name derived from the CSV's own Tournament column, not the filename).
// at every floor in FLOORS_TO_TEST, and reports:
//   - Season-by-season profit (fixed stake AND compounding stake)
//   - Month-by-month: bet count, active days, win rate, ROI, profit
//     (fixed + compounding), longest win/loss streak within that month
//   - A cross-league ranking per floor using a Wilson-score lower bound
//     on win rate vs breakeven, so small samples don't get overrated
//     next to raw ROI (see rationale in rankLeagues() below)
//
// USAGE:
//   No env vars needed for new leagues - drop a "<name>_all.csv" file in
//   the current directory and it's picked up automatically on next run.
//
//   To drop a league without deleting its file:
//     $env:EXCLUDE_LEAGUES = "SHL"
//
//   npx ts-node src/core/engine/leagueDetailedReport.ts | Tee-Object -FilePath detailed_report.txt
//
// Stake assumptions (match hockeyFloorSweep.ts):
//   FIXED_STAKE = 10,000 (non-compounding, same stake every bet)
//   PERCENT_STAKE = 1% of CURRENT balance every bet (compounding)
//   INITIAL_CAPITAL = 1,000,000

import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;
const PERCENT_STAKE = 0.01;
const FAVORITES_ONLY = process.argv.includes('--favorites-only') || process.env.FAVORITES_ONLY === '1';

interface LeagueConfig { name: string; csvPath: string; }

// Reads the league's own Tournament column (e.g. "ICE Hockey League 2024/2025")
// and strips the trailing season to get a clean display name. More reliable
// than guessing from the filename, since filenames don't always match the
// league's real name (e.g. icehl_all.csv actually contains "ICE Hockey League").
function deriveLeagueName(csvPath: string): string {
  try {
    const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/);
    const header = lines[0]?.split(',') ?? [];
    const tIdx = header.indexOf('Tournament');
    if (tIdx !== -1) {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]?.split(',');
        if (cols?.[tIdx]) return cols[tIdx].replace(/\s+\d{4}\/\d{4}$/, '').trim();
      }
    }
  } catch { /* fall through to filename-based fallback below */ }
  return path.basename(csvPath).replace(/_all\.csv$/i, '').toUpperCase();
}

// Set EXCLUDE_LEAGUES to a comma-separated list to drop specific leagues
// without deleting their CSVs, e.g.:  $env:EXCLUDE_LEAGUES = "SHL"
const EXCLUDED = new Set((process.env.EXCLUDE_LEAGUES ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

function discoverLeagues(): LeagueConfig[] {
  const dir = process.cwd();
  const files = fs.readdirSync(dir).filter(f => /_all\.csv$/i.test(f));
  const seen = new Set<string>();
  const leagues: LeagueConfig[] = [];
  for (const f of files) {
    const csvPath = path.join(dir, f);
    const name = deriveLeagueName(csvPath);
    if (EXCLUDED.has(name.toUpperCase())) continue;
    if (seen.has(name)) continue; // guards against two files mapping to the same league name
    seen.add(name);
    leagues.push({ name, csvPath });
  }
  return leagues.sort((a, b) => a.name.localeCompare(b.name));
}

const LEAGUES: LeagueConfig[] = discoverLeagues();

interface Leg { date: string; won: boolean; odds: number; opponentOdds: number; confidence: number; }

function parseCsvGeneric(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
}
function parseFlexibleDate(s: string): Date {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return new Date(trimmed);
  const months: Record<string,string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const m = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return new Date(NaN);
  const [, day, mon, year] = m;
  return new Date(`${year}-${months[mon]}-${day.padStart(2,'0')}`);
}
function getSeasonLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 7 ? `${y}/${y+1}` : `${y-1}/${y}`;
}
function getMonthLabel(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadAllPicks(csvPath: string): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { date: col('Date'), status: col('Status'), home: col('Home_Team'), away: col('Away_Team'), hs: col('Home_Score'), as: col('Away_Score'), ho: col('Home_Odds'), ao: col('Away_Odds') };

  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    if (r[idx.status]?.trim() !== 'Finished') continue;
    const date = parseFlexibleDate(r[idx.date]);
    if (isNaN(date.getTime())) continue;
    const hs = parseInt(r[idx.hs]), as = parseInt(r[idx.as]);
    if (isNaN(hs) || isNaN(as) || hs === as) continue;
    const ho = parseFloat(r[idx.ho]), ao = parseFloat(r[idx.ao]);
    if (isNaN(ho) || isNaN(ao)) continue;
    games.push({ date, home: r[idx.home].trim(), away: r[idx.away].trim(), hs, as, ho, ao });
  }
  games.sort((a,b) => a.date.getTime() - b.date.getTime());

  const hist = new Map<string, {date:Date;opp:string;res:'W'|'L';home:boolean;pf:number;pa:number}[]>();
  const push = (t:string,r:any) => { if(!hist.has(t)) hist.set(t,[]); hist.get(t)!.push(r); };

  const legs: Leg[] = [];
  for (const g of games) {
    const homeH = hist.get(g.home) ?? [], awayH = hist.get(g.away) ?? [];
    if (homeH.length >= 5 && awayH.length >= 5) {
      const h2h: H2HRecord[] = games.filter(x => x.date < g.date && ((x.home===g.home&&x.away===g.away)||(x.home===g.away&&x.away===g.home)))
       .map(x => { const flip = x.home !== g.home; const hs=flip?x.as:x.hs, as=flip?x.hs:x.as; return {date:x.date.toISOString(),homeTeam:g.home,awayTeam:g.away,homeScore:hs,awayScore:as,winner:(hs>as?'home':'away') as 'home' | 'away'}; });
      const toForm = (recs:any[]):FormRecord[] => recs.slice(-10).map(r=>({date:r.date.toISOString(),opponent:r.opp,result:r.res,goalsFor:r.pf,goalsAgainst:r.pa,venue:r.home?'home':'away'}));
      const matchId = `l-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'hockey', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'hockey',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:'generic'}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        const opponentOdds = favHome ? g.ao : g.ho;
        const won = favHome ? g.hs > g.as : g.as > g.hs;
        legs.push({ date: g.date.toISOString().slice(0,10), won, odds, opponentOdds, confidence });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

// A single bet's outcome, in chronological order, with both stake modes'
// per-bet profit and running balance recorded together so month/season
// slicing stays consistent between fixed and compounding views.
interface BetRecord {
  date: string; month: string; season: string; won: boolean; odds: number;
  fixedProfit: number; fixedBalanceAfter: number;
  percentProfit: number; percentBalanceAfter: number;
}

function buildBetRecords(legs: Leg[]): BetRecord[] {
  let percentBalance = INITIAL_CAPITAL;
  let fixedBalance = INITIAL_CAPITAL;
  const records: BetRecord[] = [];
  for (const l of legs) {
    const fixedStake = FIXED_STAKE;
    const fixedProfit = l.won ? fixedStake * (l.odds - 1) : -fixedStake;
    fixedBalance += fixedProfit;

    const percentStake = percentBalance * PERCENT_STAKE;
    const percentProfit = l.won ? percentStake * (l.odds - 1) : -percentStake;
    percentBalance += percentProfit;

    records.push({
      date: l.date, month: getMonthLabel(l.date), season: getSeasonLabel(l.date),
      won: l.won, odds: l.odds,
      fixedProfit, fixedBalanceAfter: fixedBalance,
      percentProfit, percentBalanceAfter: percentBalance,
    });
  }
  return records;
}

// Genuine peak-to-trough drawdown across the FULL unbroken history, not
// bucketed by month/season - this is the number that answers "what's the
// worst continuous losing stretch you'd have actually lived through,"
// which monthly/seasonal tables can hide by resetting at each boundary.
interface DrawdownResult { maxAbs: number; maxPct: number; peakDate: string; troughDate: string; }
function computeMaxDrawdown(records: BetRecord[], balanceKey: 'fixedBalanceAfter' | 'percentBalanceAfter'): DrawdownResult {
  let peak = INITIAL_CAPITAL, peakDate = records[0]?.date ?? '';
  let maxAbs = 0, maxPct = 0, troughDate = '', peakDateAtMaxDD = peakDate;
  for (const r of records) {
    const bal = r[balanceKey];
    if (bal > peak) { peak = bal; peakDate = r.date; }
    const ddAbs = peak - bal;
    const ddPct = peak > 0 ? (ddAbs / peak) * 100 : 0;
    // Snapshot peakDate NOW, at the moment this is the worst drawdown seen -
    // not whatever peak the loop reaches later. Without this, peakDate ends
    // up showing the highest point EVER reached (possibly years after the
    // actual crash), not the peak that the worst crash actually fell from.
    if (ddAbs > maxAbs) { maxAbs = ddAbs; maxPct = ddPct; troughDate = r.date; peakDateAtMaxDD = peakDate; }
  }
  return { maxAbs, maxPct, peakDate: peakDateAtMaxDD, troughDate };
}

function maxBetsInOneDay(records: BetRecord[]): { count: number; date: string } {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.date, (counts.get(r.date) ?? 0) + 1);
  let best = { count: 0, date: '' };
  for (const [date, count] of counts) if (count > best.count) best = { count, date };
  return best;
}

function computeStreaks(records: { won: boolean }[]): { longestWin: number; longestLoss: number } {
  let longestWin = 0, longestLoss = 0, curWin = 0, curLoss = 0;
  for (const r of records) {
    if (r.won) { curWin++; longestWin = Math.max(longestWin, curWin); curLoss = 0; }
    else { curLoss++; longestLoss = Math.max(longestLoss, curLoss); curWin = 0; }
  }
  return { longestWin, longestLoss };
}

function fmtNaira(n: number): string {
  return `₦${Math.round(n).toLocaleString()}`;
}

function reportSeasons(records: BetRecord[]) {
  const seasons = [...new Set(records.map(r => r.season))].sort();
  console.log('  -- Season breakdown --');
  console.log('  Season      Bets   Wins   Win%     ROI%     Profit(Fixed)      Profit(Compound)');
  for (const season of seasons) {
    const rs = records.filter(r => r.season === season);
    if (!rs.length) continue;
    const wins = rs.filter(r => r.won).length;
    const winPct = (wins / rs.length) * 100;
    const staked = rs.length * FIXED_STAKE;
    const fixedProfit = rs.reduce((s, r) => s + r.fixedProfit, 0);
    const roi = (fixedProfit / staked) * 100;
    const percentProfit = rs.reduce((s, r) => s + r.percentProfit, 0);
    console.log(`  ${season.padEnd(10)}  ${String(rs.length).padStart(5)}  ${String(wins).padStart(5)}  ${winPct.toFixed(1).padStart(5)}%  ${roi.toFixed(2).padStart(7)}%  ${fmtNaira(fixedProfit).padStart(16)}  ${fmtNaira(percentProfit).padStart(20)}`);
  }
}

function reportMonths(records: BetRecord[]) {
  const months = [...new Set(records.map(r => r.month))].sort();
  console.log('  -- Monthly breakdown --');
  console.log('  Month     Bets  ActiveDays  Wins  Win%     ROI%     Profit(Fixed)     Profit(Compound)   WinStreak  LossStreak');
  for (const month of months) {
    const rs = records.filter(r => r.month === month);
    if (!rs.length) continue;
    const activeDays = new Set(rs.map(r => r.date)).size;
    const wins = rs.filter(r => r.won).length;
    const winPct = (wins / rs.length) * 100;
    const staked = rs.length * FIXED_STAKE;
    const fixedProfit = rs.reduce((s, r) => s + r.fixedProfit, 0);
    const roi = (fixedProfit / staked) * 100;
    const percentProfit = rs.reduce((s, r) => s + r.percentProfit, 0);
    const { longestWin, longestLoss } = computeStreaks(rs);
    console.log(`  ${month}  ${String(rs.length).padStart(4)}  ${String(activeDays).padStart(10)}  ${String(wins).padStart(4)}  ${winPct.toFixed(1).padStart(5)}%  ${roi.toFixed(2).padStart(7)}%  ${fmtNaira(fixedProfit).padStart(15)}  ${fmtNaira(percentProfit).padStart(18)}  ${String(longestWin).padStart(9)}  ${String(longestLoss).padStart(10)}`);
  }
}

// Wilson score lower bound (95%, z=1.645 for one-sided) on the true win
// rate given `wins` out of `n`. Small samples get pulled hard toward 0.5
// (wide interval); large samples converge toward the observed rate. This
// is what makes a 27% ROI on 91 bets rank differently than a 27% ROI on
// 900 bets, instead of raw ROI treating them the same.
function wilsonLowerBound(wins: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (center - margin) / denom;
}

function rankLeagues(perLeague: { name: string; records: BetRecord[] }[]) {
  console.log('  -- Cross-league ranking (sample-size-aware) --');
  console.log('  Rank  League   Bets  Win%     Breakeven%  AvgOdds  ROI%     WilsonLB-Breakeven');
  const rows = perLeague.map(({ name, records }) => {
    if (!records.length) return null;
    const wins = records.filter(r => r.won).length;
    const avgOdds = records.reduce((s, r) => s + r.odds, 0) / records.length;
    const breakeven = 100 / avgOdds;
    const staked = records.length * FIXED_STAKE;
    const fixedProfit = records.reduce((s, r) => s + r.fixedProfit, 0);
    const roi = (fixedProfit / staked) * 100;
    const wlb = wilsonLowerBound(wins, records.length) * 100;
    const score = wlb - breakeven; // how far the WORST-CASE (95% conf.) win rate sits above breakeven
    return { name, bets: records.length, winPct: (wins / records.length) * 100, breakeven, avgOdds, roi, score };
  }).filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.score - a.score);

  rows.forEach((r, i) => {
    console.log(`  ${String(i + 1).padStart(4)}  ${r.name.padEnd(7)}  ${String(r.bets).padStart(4)}  ${r.winPct.toFixed(1).padStart(5)}%  ${r.breakeven.toFixed(1).padStart(9)}%  ${r.avgOdds.toFixed(3).padStart(7)}  ${r.roi.toFixed(2).padStart(7)}%  ${r.score.toFixed(2).padStart(18)}`);
  });
  console.log('  (Score = Wilson-95%-lower-bound win rate minus breakeven win rate. Higher = more');
  console.log('   confident the edge is real even in the worst plausible case, not just luck from a small sample.)');
}

function computePortfolioDrawdown(floorBooks: Map<number, BetRecord[]>): void {
  console.log('\n\n################## PORTFOLIO (all floor-books combined) ##################\n');
  console.log('Each floor is its own book, own ₦1,000,000 starting bankroll, playing every');
  console.log('qualifying tip across all leagues combined (matches the real plan: one book');
  console.log('per floor). This section sums all 4 books\' balances over time to find the');
  console.log('worst continuous drop in TOTAL capital across the whole operation at once.\n');

  // Tag every bet with which floor's book it belongs to, merge into one
  // timeline, and track each book's running balance as of the latest
  // bet it has seen. After every event, total = sum of all 4 books'
  // most-recent known balance (a book with no bet yet that day just
  // holds its last value - this is a step function, not interpolation).
  type Event = { date: string; floor: number; fixedBalanceAfter: number; percentBalanceAfter: number };
  const events: Event[] = [];
  for (const [floor, records] of floorBooks) {
    for (const r of records) {
      events.push({ date: r.date, floor, fixedBalanceAfter: r.fixedBalanceAfter, percentBalanceAfter: r.percentBalanceAfter });
    }
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  const floors = [...floorBooks.keys()];
  const totalStartCapital = floors.length * INITIAL_CAPITAL;
  const lastFixed = new Map<number, number>(floors.map(f => [f, INITIAL_CAPITAL]));
  const lastPercent = new Map<number, number>(floors.map(f => [f, INITIAL_CAPITAL]));

  let peakFixed = totalStartCapital, peakFixedDate = events[0]?.date ?? '';
  let maxDDFixedAbs = 0, maxDDFixedPct = 0, troughFixedDate = '', peakFixedDateAtMaxDD = peakFixedDate;
  let peakPercent = totalStartCapital, peakPercentDate = events[0]?.date ?? '';
  let maxDDPercentAbs = 0, maxDDPercentPct = 0, troughPercentDate = '', peakPercentDateAtMaxDD = peakPercentDate;

  for (const e of events) {
    lastFixed.set(e.floor, e.fixedBalanceAfter);
    lastPercent.set(e.floor, e.percentBalanceAfter);

    const totalFixed = [...lastFixed.values()].reduce((s, v) => s + v, 0);
    if (totalFixed > peakFixed) { peakFixed = totalFixed; peakFixedDate = e.date; }
    const ddFixedAbs = peakFixed - totalFixed;
    if (ddFixedAbs > maxDDFixedAbs) { maxDDFixedAbs = ddFixedAbs; maxDDFixedPct = (ddFixedAbs / peakFixed) * 100; troughFixedDate = e.date; peakFixedDateAtMaxDD = peakFixedDate; }

    const totalPercent = [...lastPercent.values()].reduce((s, v) => s + v, 0);
    if (totalPercent > peakPercent) { peakPercent = totalPercent; peakPercentDate = e.date; }
    const ddPercentAbs = peakPercent - totalPercent;
    if (ddPercentAbs > maxDDPercentAbs) { maxDDPercentAbs = ddPercentAbs; maxDDPercentPct = (ddPercentAbs / peakPercent) * 100; troughPercentDate = e.date; peakPercentDateAtMaxDD = peakPercentDate; }
  }

  console.log(`Books combined: floor(s) ${floors.map(f => (f * 100).toFixed(0) + '%').join(', ')}`);
  console.log(`Total starting capital (${floors.length} books x ₦1,000,000): ${fmtNaira(totalStartCapital)}`);
  console.log(`Max TOTAL drawdown, fixed stake:      ${fmtNaira(maxDDFixedAbs)} (${maxDDFixedPct.toFixed(1)}%)  [peak ${peakFixedDateAtMaxDD} -> trough ${troughFixedDate}]`);
  console.log(`Max TOTAL drawdown, compounding stake: ${fmtNaira(maxDDPercentAbs)} (${maxDDPercentPct.toFixed(1)}%)  [peak ${peakPercentDateAtMaxDD} -> trough ${troughPercentDate}]`);
  console.log('(Fixed-stake number is the realistic one - compounding assumes stake sizes no');
  console.log(' book would actually accept once a balance grows large, per earlier caveat.)');
}

async function main() {
  if (!LEAGUES.length) {
    console.error('No league CSVs found. Set NHL_CSV/KHL_CSV/DEL_CSV/LIIGA_CSV/SHL_CSV or place *_all.csv files in the current directory.');
    process.exit(1);
  }
  console.log(`Leagues loaded: ${LEAGUES.map(l => l.name).join(', ')}${FAVORITES_ONLY ? ' (FAVORITES-ONLY MODE - underdog picks excluded)' : ''}\n`);

  const allLegsByLeague = new Map<string, Leg[]>();
  for (const league of LEAGUES) {
    console.log(`Loading ${league.name} from ${league.csvPath}...`);
    allLegsByLeague.set(league.name, loadAllPicks(league.csvPath));
  }

  const floorBooks = new Map<number, BetRecord[]>();

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n\n################## FLOOR ${(floor * 100).toFixed(0)}% ##################\n`);

    const perLeagueRecords: { name: string; records: BetRecord[] }[] = [];
    const mergedLegs: Leg[] = [];
    for (const league of LEAGUES) {
      const legs = allLegsByLeague.get(league.name)!
        .filter(l => l.confidence >= floor)
        .filter(l => !FAVORITES_ONLY || l.odds <= l.opponentOdds);
      mergedLegs.push(...legs);
      const records = buildBetRecords(legs);
      perLeagueRecords.push({ name: league.name, records });
    }
    mergedLegs.sort((a, b) => a.date.localeCompare(b.date));
    floorBooks.set(floor, buildBetRecords(mergedLegs));

    rankLeagues(perLeagueRecords);

    for (const { name, records } of perLeagueRecords) {
      console.log(`\n========== ${name} (floor ${(floor * 100).toFixed(0)}%) ==========`);
      if (!records.length) { console.log('  0 bets'); continue; }

      const ddFixed = computeMaxDrawdown(records, 'fixedBalanceAfter');
      const ddPercent = computeMaxDrawdown(records, 'percentBalanceAfter');
      const busiestDay = maxBetsInOneDay(records);
      console.log('  -- Risk (full continuous history, not bucketed by month) --');
      console.log(`  Max drawdown, fixed stake:      ${fmtNaira(ddFixed.maxAbs)} (${ddFixed.maxPct.toFixed(1)}%)  [peak ${ddFixed.peakDate} -> trough ${ddFixed.troughDate}]`);
      console.log(`  Max drawdown, compounding stake: ${fmtNaira(ddPercent.maxAbs)} (${ddPercent.maxPct.toFixed(1)}%)  [peak ${ddPercent.peakDate} -> trough ${ddPercent.troughDate}]`);
      console.log(`  Busiest single day: ${busiestDay.count} bets on ${busiestDay.date} (${fmtNaira(busiestDay.count * FIXED_STAKE)} simultaneous exposure at fixed stake)`);

      reportSeasons(records);
      reportMonths(records);
    }
  }

  computePortfolioDrawdown(floorBooks);

  const baseline: Record<string, { bets: number; winPct: number; avgOdds: number; roiPct: number }> = {};
  for (const [floor, records] of floorBooks) {
    if (!records.length) continue;
    const wins = records.filter(r => r.won).length;
    const avgOdds = records.reduce((s, r) => s + r.odds, 0) / records.length;
    const staked = records.length * FIXED_STAKE;
    const profit = records.reduce((s, r) => s + r.fixedProfit, 0);
    baseline[`floor_${(floor * 100).toFixed(0)}`] = {
      bets: records.length,
      winPct: Math.round((wins / records.length) * 1000) / 10,
      avgOdds: Math.round(avgOdds * 1000) / 1000,
      roiPct: Math.round((profit / staked) * 1000) / 10,
    };
  }
  const baselineFilename = FAVORITES_ONLY ? 'baseline_stats_favorites_only.json' : 'baseline_stats.json';
  fs.writeFileSync(path.join(process.cwd(), baselineFilename), JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`\n\nWrote ${baselineFilename} (per-floor cross-league win%/avgOdds/ROI for live tracking comparison).`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });