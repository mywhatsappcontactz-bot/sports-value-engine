// src/core/engine/anyPairParlayBacktest.ts
// Same-day 2-leg parlays from ANY pair of different leagues (not NBA-anchored).
// e.g. ACB+BBL, NBA+BLS, ACB+BLS, etc - whichever two leagues both have a
// qualifying leg on the same calendar day.
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const STAKE = 10000;
const CONFIDENCE_FLOOR = 0.70;
const SHORT_MIN = 1.21, SHORT_MAX = 1.40;
const EXCLUDED_ODDS = [1.18, 1.20];

const NBA_CSV = process.env.NBA_ODDS_CSV ?? path.join(process.cwd(), 'nba_2008-2026.csv');
const OTHER_LEAGUES: { label: string; envVar: string }[] = [
  { label: 'ACB', envVar: 'ACB_ODDS_CSV' },
  { label: 'BLS', envVar: 'BLS_ODDS_CSV' },
  { label: 'BBL', envVar: 'BBL_ODDS_CSV' },
];

interface Leg { date: string; league: string; team: string; won: boolean; odds: number; }

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
function isExcludedOdds(o: number): boolean { return EXCLUDED_ODDS.some(x => Math.abs(x-o) < 0.001); }
function inShortBand(o: number): boolean { return o >= SHORT_MIN && o <= SHORT_MAX && !isExcludedOdds(o); }

// Derive a consistent "season" label from any date, using a July 1 cutover
// (basketball seasons run roughly Sept/Oct - June, regardless of league),
// so NBA/ACB/BBL/BLS all bucket into the same season labels for comparison.
function getSeasonLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear(), m = d.getMonth() + 1; // 1-12
  return m >= 7 ? `${y}/${y+1}` : `${y-1}/${y}`;
}

function loadNbaLegsShort(): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(NBA_CSV, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { season: col('season'), date: col('date'), regular: col('regular'), away: col('away'), home: col('home'), sh: col('score_home'), sa: col('score_away'), mh: col('moneyline_home'), ma: col('moneyline_away') };
  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    if (parseInt(r[idx.season]) < 2016 || parseInt(r[idx.season]) > 2023) continue;
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
        if (confidence >= CONFIDENCE_FLOOR && inShortBand(odds)) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), league:'NBA', team: favHome?g.home:g.away, won, odds });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function loadLeagueLegsShort(csvPath: string, leagueLabel: string): Leg[] {
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
        if (confidence >= CONFIDENCE_FLOOR && inShortBand(odds)) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), league: leagueLabel, team: favHome?g.home:g.away, won, odds });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

async function main() {
  const allLeagues: { label: string; legs: Leg[] }[] = [{ label: 'NBA', legs: loadNbaLegsShort() }];
  for (const { label, envVar } of OTHER_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`(skipping ${label})`); continue; }
    allLeagues.push({ label, legs: loadLeagueLegsShort(csvPath, label) });
  }
  for (const { label, legs } of allLeagues) console.log(`${label} short-odds qualifying legs: ${legs.length}`);

  console.log('\nQualifying legs per league per season (checking against 50/season expectation):');
  for (const { label, legs } of allLeagues) {
    const bySeasonCount: Record<string, number> = {};
    for (const l of legs) {
      const s = getSeasonLabel(l.date);
      bySeasonCount[s] = (bySeasonCount[s] || 0) + 1;
    }
    console.log(`  ${label}:`);
    for (const s of Object.keys(bySeasonCount).sort()) {
      console.log(`    ${s}: ${bySeasonCount[s]} legs`);
    }
  }

  // Index: date -> league -> legs (take first qualifying leg per league per day)
  const byDate: Map<string, Map<string, Leg>> = new Map();
  for (const { label, legs } of allLeagues) {
    for (const l of legs) {
      if (!byDate.has(l.date)) byDate.set(l.date, new Map());
      const m = byDate.get(l.date)!;
      if (!m.has(label)) m.set(label, l); // first one wins
    }
  }

  // For each day with >=2 leagues qualifying, form EVERY pairwise combination
  // (order doesn't matter - ACB+BBL is the same parlay as BBL+ACB)
  let parlays: { won: boolean; odds: number; profit: number; pairKey: string; season: string }[] = [];
  const pairCounts: Record<string, number> = {};

  for (const [date, leagueMap] of byDate) {
    const entries = [...leagueMap.entries()]; // [league, leg][]
    if (entries.length < 2) continue;
    const season = getSeasonLabel(date);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [labelA, legA] = entries[i];
        const [labelB, legB] = entries[j];
        const pairKey = [labelA, labelB].sort().join('+');
        const combinedOdds = legA.odds * legB.odds;
        const bothWon = legA.won && legB.won;
        const profit = bothWon ? STAKE * (combinedOdds - 1) : -STAKE;
        parlays.push({ won: bothWon, odds: combinedOdds, profit, pairKey, season });
        pairCounts[pairKey] = (pairCounts[pairKey] || 0) + 1;
      }
    }
  }

  console.log(`\nDistinct days with >=2 leagues qualifying (short odds): ${[...byDate.values()].filter(m => m.size >= 2).length}`);
  console.log(`Total 2-leg parlays across ALL league pairs: ${parlays.length}`);
  if (!parlays.length) { console.log('No overlapping short-odds days across any two leagues.'); return; }

  const wins = parlays.filter(p => p.won).length;
  const staked = parlays.length * STAKE;
  const profit = parlays.reduce((s, p) => s + p.profit, 0);
  const avgOdds = parlays.reduce((s,p)=>s+p.odds,0) / parlays.length;
  console.log(`\nOVERALL: ${parlays.length} parlays | wins: ${wins} (${(wins/parlays.length*100).toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} (breakeven: ${(100/avgOdds).toFixed(1)}%)`);
  console.log(`Total staked: ₦${staked.toLocaleString()} | P/L: ₦${profit.toLocaleString(undefined,{maximumFractionDigits:0})} | ROI: ${(profit/staked*100).toFixed(2)}%`);

  console.log('\nBreakdown by league pair:');
  for (const pairKey of Object.keys(pairCounts).sort()) {
    const subset = parlays.filter(p => p.pairKey === pairKey);
    const w = subset.filter(p=>p.won).length;
    const st = subset.length * STAKE;
    const pl = subset.reduce((s,p)=>s+p.profit,0);
    console.log(`  ${pairKey}: ${subset.length} parlays | wins: ${w} (${(w/subset.length*100).toFixed(1)}%) | ROI: ${(pl/st*100).toFixed(2)}%`);
  }

  console.log('\nBreakdown by season:');
  const seasons = [...new Set(parlays.map(p => p.season))].sort();
  for (const season of seasons) {
    const subset = parlays.filter(p => p.season === season);
    const w = subset.filter(p=>p.won).length;
    const st = subset.length * STAKE;
    const pl = subset.reduce((s,p)=>s+p.profit,0);
    const avgO = subset.reduce((s,p)=>s+p.odds,0) / subset.length;
    console.log(`  ${season}: ${subset.length} parlays | wins: ${w} (${(w/subset.length*100).toFixed(1)}%) | avg odds: ${avgO.toFixed(3)} | staked: ₦${st.toLocaleString()} | P/L: ₦${pl.toLocaleString(undefined,{maximumFractionDigits:0})} | ROI: ${(pl/st*100).toFixed(2)}%`);
  }

  console.log('\nBreakdown by season + league pair:');
  for (const season of seasons) {
    for (const pairKey of Object.keys(pairCounts).sort()) {
      const subset = parlays.filter(p => p.season === season && p.pairKey === pairKey);
      if (!subset.length) continue;
      const w = subset.filter(p=>p.won).length;
      const st = subset.length * STAKE;
      const pl = subset.reduce((s,p)=>s+p.profit,0);
      console.log(`  ${season} | ${pairKey}: ${subset.length} parlays | wins: ${w} (${(w/subset.length*100).toFixed(1)}%) | ROI: ${(pl/st*100).toFixed(2)}%`);
    }
  }

}

main().catch(e => { console.error(e.message); process.exit(1); });