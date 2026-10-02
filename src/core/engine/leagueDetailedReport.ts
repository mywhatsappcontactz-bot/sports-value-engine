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
//   To include OT/shootout games (excluded by default - every prior run
//   only used Status === 'Finished'):
//     npx ts-node src/core/engine/leagueDetailedReport.ts --include-ot-so
//   IMPORTANT: with this flag on, any game that went to OT/shootout is
//   counted as an AUTOMATIC LOSS for whichever side was picked, full
//   stop - regardless of the final score. This matches a real straight
//   regulation-time moneyline bet: if regulation ends tied, that pick
//   has already lost, and who wins the extra period is irrelevant. The
//   home/away odds used to price these games are still the regulation-
//   time 1X2 market's home/away prices (draw price dropped) - that part
//   is unchanged and is the correct price for a regulation-time bet.
//
//   To simulate ALWAYS betting the incl.-OT moneyline market instead of
//   the regulation-time market (NEW):
//     npx ts-node src/core/engine/leagueDetailedReport.ts --ot-convert
//   This is a SEPARATE mode from --include-ot-so, not a variant of it -
//   the original auto-loss mode is untouched and still available on its
//   own flag, so both can be compared side by side. With --ot-convert:
//     - EVERY bet's odds are converted from the regulation-time price to
//       an ESTIMATED incl.-OT price using an empirically-fit formula
//       (see convertRegulationOddsToInclOT below) - not just the ones
//       that happened to go to OT/shootout. This matches reality: you
//       can't know in advance which games will need OT, so if you're
//       playing the incl.-OT market as a standing strategy, you're
//       getting that (slightly lower) price on every single bet, win or
//       lose, whether or not that particular game ever reaches OT.
//     - Every bet is settled using the ACTUAL final winner (OT/SO
//       included). For games that end in regulation this is identical
//       to the regulation-time result (same team wins either way) - the
//       real effect of this mode is the lower payout on wins, applied
//       uniformly, not a settlement change for most games.
//   This exists because a regulation-time-only auto-loss rule is a
//   mismatch with what the model is actually trying to predict (who
//   wins the game, OT/SO included) IF your real-world bookmaker offers
//   an incl.-OT moneyline market - in that case the auto-loss framing
//   is wrong and this conversion mode is the more realistic backtest.
//   If your bookmaker does NOT offer that market, --include-ot-so's
//   auto-loss framing is still the correct one to trust. Confirm which
//   market is actually available before treating --ot-convert's numbers
//   as gospel over --include-ot-so's.
//
//   To enforce a minimum odds floor (your own live-betting rule):
//     $env:MIN_ODDS = "1.50"   (defaults to 1.50 if unset)
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
// Every backtest run so far has silently EXCLUDED every OT/shootout game
// (Status === 'Finished' only). In real live betting you can't know in
// advance which games will need OT, so if your model tips a game and it
// goes to OT, you're in that bet regardless. This flag includes those
// games AND settles them as an automatic loss (see loadAllPicks) - a
// straight regulation-time pick that goes to OT has already lost,
// regardless of who wins the extra period.
const INCLUDE_OT_SO = process.argv.includes('--include-ot-so') || process.env.INCLUDE_OT_SO === '1';
// NEW, separate mode: include OT/shootout games but price them with an
// estimated incl.-OT conversion and settle by the ACTUAL final winner,
// instead of pricing at regulation odds + auto-loss. See file header
// for the full rationale. Independent flag - does not require
// --include-ot-so to also be set, and takes priority over it for
// OT/shootout games specifically if both happen to be passed.
const OT_CONVERT = process.argv.includes('--ot-convert') || process.env.OT_CONVERT === '1';
// User's real-life rule: never play odds below 1.50, regardless of what
// the model/floor says. Not part of the original backtest - testing it
// now, together with INCLUDE_OT_SO, since both represent constraints
// that weren't in the numbers you've seen so far.
const MIN_ODDS = parseFloat(process.env.MIN_ODDS ?? '1.50');

// Converts a regulation-time moneyline price into an ESTIMATED incl.-OT
// price. Fit from 14 real regulation-vs-incl.-OT odds pairs (7 games)
// spanning regulation-time implied win probability 16.1%-76.9%:
//   cut ratio ≈ 0.605 + 0.412 × (regulation-time implied win probability)
//   inclOtOdds = regOdds × cutRatio
// Favorites keep almost all their regulation-time value going to
// incl.-OT (a ~90% favorite keeps ~98% of its price); big underdogs
// lose 30-35% of theirs, since OT/shootout is close to a coinflip
// regardless of who was favored in regulation. UNVALIDATED outside the
// 16.1%-76.9% range - extrapolating to near-locks (>85%) or huge
// longshots (<15%) is riskier; most real lines fall inside the tested
// range anyway. Treat the coefficients (0.605 / 0.412) with moderate
// confidence and the general shape (favorites keep more, dogs lose
// more) with high confidence.
function convertRegulationOddsToInclOT(regOdds: number): number {
  const regImpliedProb = 1 / regOdds;
  const cutRatio = 0.605 + 0.412 * regImpliedProb;
  return regOdds * cutRatio;
}

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

// SAFETY: this script hardcodes sport:'hockey' in every ModelInput it
// builds (see loadAllPicks below), so ANY csv matching *_all.csv gets
// treated as hockey data regardless of what sport it actually contains.
// Auto-discovery without a whitelist previously pulled in basketball
// league CSVs (LNB, BBL, Super Lig, Lega A, Basket League, Elite League)
// sitting in the same working directory from other project work, and
// silently ran the hockey model against them - every number reported for
// those "leagues" was meaningless noise, not a real signal. This
// whitelist is the fix: only these known-hockey league names (matched
// against deriveLeagueName's output, case-insensitive) are ever loaded.
// Add a league here ONLY after confirming its CSV actually contains
// hockey data with the Home_Odds/Away_Odds/Status column format this
// script expects.
const HOCKEY_LEAGUE_WHITELIST = new Set([
  'NHL', 'KHL', 'DEL', 'DEL2', 'LIIGA', 'MESTIS', 'SHL',
  'HOCKEYALLSVENSKAN', 'ICE HOCKEY LEAGUE', 'ICEHL', 'ELITE LEAGUE', 'EIHL', 'AHL',
  // New leagues being onboarded this session - confirm each name below
  // matches the CSV's actual Tournament column before trusting results.
  'METAL LIGAEN',
]);

// Set EXCLUDE_LEAGUES to a comma-separated list to drop specific leagues
// without deleting their CSVs, e.g.:  $env:EXCLUDE_LEAGUES = "SHL"
const EXCLUDED = new Set((process.env.EXCLUDE_LEAGUES ?? '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean));

function discoverLeagues(): LeagueConfig[] {
  const dir = process.cwd();
  const files = fs.readdirSync(dir).filter(f => /_all\.csv$/i.test(f));
  const seen = new Set<string>();
  const leagues: LeagueConfig[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const csvPath = path.join(dir, f);
    const name = deriveLeagueName(csvPath);
    if (!HOCKEY_LEAGUE_WHITELIST.has(name.toUpperCase())) { skipped.push(`${f} (parsed as "${name}")`); continue; }
    if (EXCLUDED.has(name.toUpperCase())) continue;
    if (seen.has(name)) continue; // guards against two files mapping to the same league name
    seen.add(name);
    leagues.push({ name, csvPath });
  }
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} non-whitelisted CSV(s) (not hockey, or an unrecognized league name):`);
    for (const s of skipped) console.log(`  - ${s}`);
    console.log('  If any of these ARE actually hockey, add their exact league name to HOCKEY_LEAGUE_WHITELIST.\n');
  }
  return leagues.sort((a, b) => a.name.localeCompare(b.name));
}

const LEAGUES: LeagueConfig[] = discoverLeagues();

interface Leg { date: string; won: boolean; odds: number; opponentOdds: number; confidence: number; wentToOT: boolean; otPriced: boolean; }

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

  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number; wentToOT: boolean };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const status = r[idx.status]?.trim();
    // Both --include-ot-so and --ot-convert need OT/shootout games loaded -
    // they just disagree on how to price/settle them once loaded (see below).
    const statusOk = (INCLUDE_OT_SO || OT_CONVERT)
      ? (status === 'Finished' || status === 'After OT' || status === 'After Pen.')
      : status === 'Finished';
    if (!statusOk) continue;
    const date = parseFlexibleDate(r[idx.date]);
    if (isNaN(date.getTime())) continue;
    const hs = parseInt(r[idx.hs]), as = parseInt(r[idx.as]);
    if (isNaN(hs) || isNaN(as) || hs === as) continue;
    const ho = parseFloat(r[idx.ho]), ao = parseFloat(r[idx.ao]);
    if (isNaN(ho) || isNaN(ao)) continue;
    games.push({ date, home: r[idx.home].trim(), away: r[idx.away].trim(), hs, as, ho, ao, wentToOT: status !== 'Finished' });
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
        const regOdds = favHome ? g.ho : g.ao;
        const opponentOdds = favHome ? g.ao : g.ho;

        // --ot-convert models "I always bet the incl.-OT market" as a
        // standing strategy - you can't know in advance which games will
        // need OT, so the conversion applies to EVERY bet's odds, not
        // just the ones that happened to go to OT. Settlement is always
        // the ACTUAL final winner (OT/SO included). For games that end
        // in regulation this naturally reduces to the regulation result
        // (same team wins either way) - the real effect of this mode is
        // that the ODDS on every win are the slightly-lower incl.-OT
        // price, not just on the games that went to OT.
        //
        // --include-ot-so (without --ot-convert) keeps the old behavior:
        // regulation price for every game, auto-loss for any game that
        // went to OT/shootout, win/loss by regulation result otherwise.
        let odds: number;
        let won: boolean;
        if (OT_CONVERT) {
          odds = convertRegulationOddsToInclOT(regOdds);
          won = favHome ? g.hs > g.as : g.as > g.hs;
        } else if (g.wentToOT) {
          odds = regOdds;
          won = false;
        } else {
          odds = regOdds;
          won = favHome ? g.hs > g.as : g.as > g.hs;
        }
        const otPriced = OT_CONVERT;

        if (odds >= MIN_ODDS) {
          legs.push({ date: g.date.toISOString().slice(0,10), won, odds, opponentOdds, confidence, wentToOT: g.wentToOT, otPriced });
        }
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
  wentToOT: boolean; otPriced: boolean;
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
      wentToOT: l.wentToOT, otPriced: l.otPriced,
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

function reportOtSoBreakdown(perLeague: { name: string; records: BetRecord[] }[]) {
  if (!INCLUDE_OT_SO && !OT_CONVERT) return;
  console.log('  -- Regulation vs OT/Shootout breakdown --');
  if (OT_CONVERT) {
    console.log('  (OT/SO games are priced at an ESTIMATED incl.-OT conversion and settled by the');
    console.log('   ACTUAL final winner - see file header. This shows how big a share of bets that');
    console.log('   is per league, and its ROI relative to regulation-only bets.)');
  } else {
    console.log('  (OT/SO games are settled as an automatic loss - see file header. This shows');
    console.log('   how big a share of bets that is per league, and its ROI drag.)');
  }
  for (const { name, records } of perLeague) {
    const reg = records.filter(r => !r.wentToOT);
    const ot = records.filter(r => r.wentToOT);
    if (!records.length) continue;
    const summarize = (rs: BetRecord[]) => {
      if (!rs.length) return 'no bets';
      const wins = rs.filter(r => r.won).length;
      const staked = rs.length * FIXED_STAKE;
      const profit = rs.reduce((s, r) => s + r.fixedProfit, 0);
      return `${rs.length} bets | ${((wins / rs.length) * 100).toFixed(1)}% win | ROI ${((profit / staked) * 100).toFixed(2)}%`;
    };
    console.log(`  ${name}: regulation-only [${summarize(reg)}]  |  OT/SO games [${summarize(ot)}]  |  OT/SO share: ${((ot.length / records.length) * 100).toFixed(1)}%`);
  }
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
  const modeLabel = OT_CONVERT
    ? ' (OT-CONVERT MODE - OT/SO games priced via incl.-OT conversion, settled by actual winner)'
    : INCLUDE_OT_SO
      ? ' (INCLUDE-OT-SO MODE - OT/SO games settled as auto-loss)'
      : '';
  console.log(`Leagues loaded: ${LEAGUES.map(l => l.name).join(', ')}${FAVORITES_ONLY ? ' (FAVORITES-ONLY MODE - underdog picks excluded)' : ''}${modeLabel}\n`);

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
    reportOtSoBreakdown(perLeagueRecords);

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
  const baselineFilename = OT_CONVERT
    ? (FAVORITES_ONLY ? 'baseline_stats_ot_convert_favorites_only.json' : 'baseline_stats_ot_convert.json')
    : (FAVORITES_ONLY ? 'baseline_stats_favorites_only.json' : 'baseline_stats.json');
  fs.writeFileSync(path.join(process.cwd(), baselineFilename), JSON.stringify(baseline, null, 2), 'utf-8');
  console.log(`\n\nWrote ${baselineFilename} (per-floor cross-league win%/avgOdds/ROI for live tracking comparison).`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });