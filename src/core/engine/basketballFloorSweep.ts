// src/core/engine/basketballFloorSweep.ts
// Same rigor as hockeyFloorSweep/leagueDetailedReport, but for basketball
// leagues, correctly using modelBasketball (not the hockey-contamination
// bug from leagueDetailedReport.ts). Tests floors 55/60/65/70 - basketball
// has never been tested below 70% before.
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

const NBA_CSV = process.env.NBA_ODDS_CSV ?? path.join(process.cwd(), 'nba_2008-2026.csv');
const OTHER_LEAGUES: { label: string; envVar: string }[] = [
  { label: 'ACB', envVar: 'ACB_ODDS_CSV' },
  { label: 'BBL', envVar: 'BBL_ODDS_CSV' },
  { label: 'FRA', envVar: 'FRA_ODDS_CSV' },
  { label: 'GRE', envVar: 'GRE_ODDS_CSV' },
  { label: 'TUR', envVar: 'TUR_ODDS_CSV' },
  { label: 'ITA', envVar: 'ITA_ODDS_CSV' },
];

interface Leg { date: string; won: boolean; odds: number; confidence: number; }

function americanToDecimal(a: number): number { return a > 0 ? a/100+1 : 100/Math.abs(a)+1; }
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

function loadNbaLegs(): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(NBA_CSV, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { season: col('season'), date: col('date'), regular: col('regular'), away: col('away'), home: col('home'), sh: col('score_home'), sa: col('score_away'), mh: col('moneyline_home'), ma: col('moneyline_away') };
  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    if (parseInt(r[idx.season]) < 2015 || parseInt(r[idx.season]) > 2023) continue;
    if (r[idx.regular]?.trim().toLowerCase() !== 'true') continue;
    const date = new Date(r[idx.date]);
    if (isNaN(date.getTime())) continue;
    const hs = parseInt(r[idx.sh]), as = parseInt(r[idx.sa]);
    if (isNaN(hs) || isNaN(as) || hs === as) continue;
    const mh = parseFloat(r[idx.mh]), ma = parseFloat(r[idx.ma]);
    if (isNaN(mh) || isNaN(ma)) continue;
    games.push({ date, home: r[idx.home].trim(), away: r[idx.away].trim(), hs, as, ho: americanToDecimal(mh), ao: americanToDecimal(ma) });
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
      const matchId = `nba-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'basketball', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:'nba'}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'basketball',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:'nba'}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        const won = favHome ? g.hs > g.as : g.as > g.hs;
        legs.push({ date: g.date.toISOString().slice(0,10), won, odds, confidence });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function loadLeagueLegs(csvPath: string, leagueLabel: string): Leg[] {
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
      const matchId = `${leagueLabel.toLowerCase()}-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'basketball', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:leagueLabel}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'basketball',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:leagueLabel}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        const won = favHome ? g.hs > g.as : g.as > g.hs;
        legs.push({ date: g.date.toISOString().slice(0,10), won, odds, confidence });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function wilsonLowerBound(wins: number, n: number, z = 1.645): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (center - margin) / denom;
}

function computeStreaks(legs: { won: boolean }[]): { longestWin: number; longestLoss: number } {
  let longestWin = 0, longestLoss = 0, curWin = 0, curLoss = 0;
  for (const l of legs) {
    if (l.won) { curWin++; longestWin = Math.max(longestWin, curWin); curLoss = 0; }
    else { curLoss++; longestLoss = Math.max(longestLoss, curLoss); curWin = 0; }
  }
  return { longestWin, longestLoss };
}

function computeMaxDrawdownFixed(legs: Leg[]): { maxAbs: number; maxPct: number } {
  let balance = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxAbs = 0, maxPct = 0;
  for (const l of legs) {
    balance += l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxAbs) { maxAbs = dd; maxPct = peak > 0 ? (dd/peak)*100 : 0; }
  }
  return { maxAbs, maxPct };
}

function fmtNaira(n: number): string { return `₦${Math.round(n).toLocaleString()}`; }

async function main() {
  const allLeagues: { label: string; legs: Leg[] }[] = [{ label: 'NBA', legs: loadNbaLegs() }];
  for (const { label, envVar } of OTHER_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`(skipping ${label})`); continue; }
    allLeagues.push({ label, legs: loadLeagueLegs(csvPath, label) });
  }
  console.log(`Leagues loaded: ${allLeagues.map(l => l.label).join(', ')}\n`);

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n################## FLOOR ${(floor*100).toFixed(0)}% ##################\n`);
    const rows: any[] = allLeagues.map(({ label, legs }) => {
      const qualifying = legs.filter(l => l.confidence >= floor);
      if (!qualifying.length) return { label, qualifying, bets: 0 };
      const wins = qualifying.filter(l => l.won).length;
      const avgOdds = qualifying.reduce((s,l)=>s+l.odds,0) / qualifying.length;
      const breakeven = 100/avgOdds;
      const staked = qualifying.length * FIXED_STAKE;
      const profit = qualifying.reduce((s,l) => s + (l.won ? FIXED_STAKE*(l.odds-1) : -FIXED_STAKE), 0);
      const roi = (profit/staked)*100;
      const wlb = wilsonLowerBound(wins, qualifying.length) * 100;
      const score = wlb - breakeven;
      return { label, qualifying, bets: qualifying.length, winPct: (wins/qualifying.length)*100, breakeven, avgOdds, roi, score };
    }).filter((r: any) => r.bets > 0).sort((a: any,b: any) => b.score - a.score);

    console.log('-- Cross-league ranking (sample-size-aware) --');
    console.log('Rank  League   Bets  Win%     Breakeven%  AvgOdds  ROI%     WilsonLB-Breakeven');
    rows.forEach((r: any, i: number) => {
      console.log(`${String(i+1).padStart(4)}  ${r.label.padEnd(7)}  ${String(r.bets).padStart(4)}  ${r.winPct.toFixed(1).padStart(5)}%  ${r.breakeven.toFixed(1).padStart(9)}%  ${r.avgOdds.toFixed(3).padStart(7)}  ${r.roi.toFixed(2).padStart(7)}%  ${r.score.toFixed(2).padStart(18)}`);
    });
    console.log('(Score = Wilson-95%-lower-bound win rate minus breakeven win rate. Higher = more');
    console.log(' confident the edge is real even in the worst plausible case, not just luck.)\n');

    for (const { label, qualifying } of rows) {
      console.log(`========== ${label} (floor ${(floor*100).toFixed(0)}%) ==========`);
      const dd = computeMaxDrawdownFixed(qualifying);
      const { longestWin, longestLoss } = computeStreaks(qualifying);
      console.log(`  Max drawdown (fixed stake): ${fmtNaira(dd.maxAbs)} (${dd.maxPct.toFixed(1)}%) | Longest win streak: ${longestWin} | Longest loss streak: ${longestLoss}`);
      const seasons = [...new Set(qualifying.map((l: Leg) => getSeasonLabel(l.date)))].sort();
      for (const season of seasons) {
        const sl = qualifying.filter((l: Leg) => getSeasonLabel(l.date) === season);
        const wins = sl.filter((l: Leg) => l.won).length;
        const staked = sl.length * FIXED_STAKE;
        const profit = sl.reduce((s: number, l: Leg) => s + (l.won ? FIXED_STAKE*(l.odds-1) : -FIXED_STAKE), 0);
        console.log(`    ${season}: ${sl.length} bets | ${wins} wins (${(wins/sl.length*100).toFixed(1)}%) | ROI: ${(profit/staked*100).toFixed(2)}%`);
      }
      console.log('');
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });