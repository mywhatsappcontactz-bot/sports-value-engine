// src/core/engine/hockeyCrossLeagueParlayDeepTest.ts  (FIXED)
// Fixes vs previous version:
//   1. LEAGUES now points at the correctly-split, correctly-labeled files
//      (del_clean.csv=DEL, DEL2_split.csv=DEL2, ICEHockeyLeague_split.csv=ICEHL,
//      sweden_clean.csv=HockeyAllsvenskan) instead of the old mismapped ones.
//   2. allLegs is now globally sorted by date BEFORE building parlays, so
//      the Map iteration order in buildParlays is truly chronological -
//      this is what the drawdown/streak numbers actually depend on being
//      correct. Previously legs were concatenated league-by-league, which
//      silently shuffled the effective order and made every drawdown/
//      streak number in the old report untrustworthy.
import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const STAKE = 10000;
const INITIAL_CAPITAL = 1_000_000;
const TOP_PAIRS = ['AHL+Liiga', 'AHL+KHL', 'DEL+HockeyAllsvenskan', 'DEL+KHL'];

const LEAGUES: { label: string; csv: string }[] = [
  { label: 'NHL', csv: 'nhl_all.csv' },
  { label: 'KHL', csv: 'khl_all.csv' },
  { label: 'DEL', csv: 'del_clean.csv' },
  { label: 'DEL2', csv: 'DEL2_split.csv' },
  { label: 'AHL', csv: 'ahl_all.csv' },
  { label: 'Liiga', csv: 'liiga_all.csv' },
  { label: 'HockeyAllsvenskan', csv: 'sweden_clean.csv' },
  { label: 'ICEHL', csv: 'ICEHockeyLeague_split.csv' },
  { label: 'EIHL', csv: 'eihl_all.csv' },
];

interface Leg { date: string; league: string; won: boolean; odds: number; confidence: number; }
interface Parlay { date: string; pairKey: string; won: boolean; odds: number; }

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

function loadAllPicks(csvPath: string, label: string): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { date: col('Date'), status: col('Status'), home: col('Home_Team'), away: col('Away_Team'), hs: col('Home_Score'), as: col('Away_Score'), ho: col('Home_Odds'), ao: col('Away_Odds') };

  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length || r[idx.status]?.trim() !== 'Finished') continue;
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
        .map(x => { const flip = x.home !== g.home; const hs=flip?x.as:x.hs, as=flip?x.hs:x.as; return {date:x.date.toISOString(),homeTeam:g.home,awayTeam:g.away,homeScore:hs,awayScore:as,winner:(hs>as?'home':'away') as 'home'|'away'}; });
      const toForm = (recs:any[]):FormRecord[] => recs.slice(-10).map(r=>({date:r.date.toISOString(),opponent:r.opp,result:r.res,goalsFor:r.pf,goalsAgainst:r.pa,venue:r.home?'home':'away'}));
      const matchId = `${label}-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'hockey', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:label.toLowerCase()}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'hockey',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:label.toLowerCase()}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        const opponentOdds = favHome ? g.ao : g.ho;
        if (odds <= opponentOdds) { // favorites only
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), league: label, won, odds, confidence });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function buildParlays(allLegsSorted: Leg[], floor: number): Parlay[] {
  const qualifying = allLegsSorted.filter(l => l.confidence >= floor);
  const byDate = new Map<string, Leg[]>();
  for (const l of qualifying) { if (!byDate.has(l.date)) byDate.set(l.date, []); byDate.get(l.date)!.push(l); }

  const parlays: Parlay[] = [];
  for (const [date, legsThatDay] of byDate) {
    const byLeague = new Map<string, Leg>();
    for (const l of legsThatDay) if (!byLeague.has(l.league)) byLeague.set(l.league, l);
    const entries = [...byLeague.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [labelA, legA] = entries[i], [labelB, legB] = entries[j];
        const pairKey = [labelA, labelB].sort().join('+');
        const combinedOdds = legA.odds * legB.odds;
        const bothWon = legA.won && legB.won;
        parlays.push({ date, pairKey, won: bothWon, odds: combinedOdds });
      }
    }
  }
  return parlays;
}

function computeStreaks(parlays: Parlay[]): { win: number; loss: number } {
  let win = 0, loss = 0, cw = 0, cl = 0;
  for (const p of parlays) {
    if (p.won) { cw++; win = Math.max(win, cw); cl = 0; }
    else { cl++; loss = Math.max(loss, cl); cw = 0; }
  }
  return { win, loss };
}

function simulateDrawdown(parlays: Parlay[]): { maxDD: number; maxDDPct: number; finalBalance: number } {
  let balance = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxDD = 0, maxDDPct = 0;
  for (const p of parlays) {
    const outcome = p.won ? STAKE * (p.odds - 1) : -STAKE;
    balance += outcome;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxDDPct) maxDDPct = ddPct;
  }
  return { maxDD, maxDDPct, finalBalance: balance };
}

function reportPair(pairKey: string, parlays: Parlay[]) {
  if (!parlays.length) return;
  const wins = parlays.filter(p=>p.won).length;
  const staked = parlays.length * STAKE;
  const profit = parlays.reduce((s,p)=>s+(p.won?STAKE*(p.odds-1):-STAKE),0);
  const avgOdds = parlays.reduce((s,p)=>s+p.odds,0)/parlays.length;
  const breakeven = 100/avgOdds;
  const { win, loss } = computeStreaks(parlays);
  const { maxDD, maxDDPct } = simulateDrawdown(parlays);

  console.log(`  ${pairKey}: ${parlays.length} parlays | wins: ${wins} (${(wins/parlays.length*100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | ROI: ${(profit/staked*100).toFixed(2)}%`);
  console.log(`    Streaks: longest win ${win}, longest loss ${loss} | Max drawdown: ₦${maxDD.toLocaleString(undefined,{maximumFractionDigits:0})} (${maxDDPct.toFixed(1)}%)`);

  const seasons = [...new Set(parlays.map(p=>getSeasonLabel(p.date)))].sort();
  for (const s of seasons) {
    const subset = parlays.filter(p=>getSeasonLabel(p.date)===s);
    if (!subset.length) continue;
    const sw = subset.filter(p=>p.won).length;
    const sst = subset.length*STAKE;
    const spl = subset.reduce((acc,p)=>acc+(p.won?STAKE*(p.odds-1):-STAKE),0);
    console.log(`      ${s}: ${subset.length} parlays | ${sw} wins (${(sw/subset.length*100).toFixed(1)}%) | ROI: ${(spl/sst*100).toFixed(2)}%`);
  }
}

async function main() {
  const allLegs: Leg[] = [];
  for (const { label, csv } of LEAGUES) {
    if (!fs.existsSync(csv)) { console.log(`(skipping ${label} - ${csv} not found)`); continue; }
    const legs = loadAllPicks(csv, label);
    console.log(`${label}: ${legs.length} favorite candidates loaded (all confidences)`);
    allLegs.push(...legs);
  }

  // CRITICAL FIX: sort ALL legs globally by date once, here, before any
  // floor filtering or parlay building.
  allLegs.sort((a, b) => a.date.localeCompare(b.date));

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n\n########## FLOOR ${(floor*100).toFixed(0)}% ##########`);
    const parlays = buildParlays(allLegs, floor);

    const pairKeys = [...new Set(parlays.map(p=>p.pairKey))].sort();
    console.log(`\n-- All pairs --`);
    for (const key of pairKeys) reportPair(key, parlays.filter(p=>p.pairKey===key));

    console.log(`\n-- Weekly frequency check for top pairs --`);
    for (const key of TOP_PAIRS) {
      const subset = parlays.filter(p=>p.pairKey===key);
      if (!subset.length) { console.log(`  ${key}: 0 parlays at this floor`); continue; }
      const weeks = new Map<string, number>();
      for (const p of subset) {
        const d = new Date(p.date);
        const weekStart = new Date(d); weekStart.setDate(d.getDate() - d.getDay());
        const wk = weekStart.toISOString().slice(0,10);
        weeks.set(wk, (weeks.get(wk)||0)+1);
      }
      const counts = [...weeks.values()];
      const avgPerWeek = counts.reduce((s,c)=>s+c,0)/counts.length;
      console.log(`  ${key}: ${subset.length} parlays across ${weeks.size} distinct weeks | avg ${avgPerWeek.toFixed(2)} parlays/active week`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });