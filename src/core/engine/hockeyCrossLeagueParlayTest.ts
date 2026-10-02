// src/core/engine/hockeyCrossLeagueParlayTest.ts
//
// CORRECTED cross-league 2-leg parlay test. Uses the same corrected
// per-leg methodology as hockeyRealisticSingleLeagueTest.ts (OT/
// shootout = automatic loss for a regulation-time moneyline pick,
// final score never consulted for those games) applied across all 11
// previously-tested leagues at once, then forms 2-leg parlays by
// pairing every qualifying leg with every OTHER qualifying leg from a
// DIFFERENT league that fell on the SAME calendar date.
//
// Per user decision:
//   - Pairing rule: same date only (both legs' games happened same day)
//   - League pool: all 11 previously-tested leagues (Mestis excluded -
//     its CSV loaded 0 games, separate data issue)
//   - Floors: test all 4 floors (55/60/65/70%), same as single-league tests
//
// A parlay requires BOTH legs to win to pay out; if either leg's game
// went to OT/shootout, that leg is an automatic loss and so is the
// whole parlay - the corrected single-leg logic propagates through.
//
// NOTE ON COMBINATORICS: on a date with N qualifying legs across
// different leagues, this forms all C(N,2) cross-league pairs, not a
// capped number of parlays you'd realistically place. This measures
// "is there aggregate value in this pairing strategy at all" rather
// than modeling a specific bet-sizing plan - read the ROI as a
// signal, not a literal bankroll projection.
//
// Usage: no env vars needed, league file list is hardcoded below to
// match the exact files already used in the single-league tests.
// Run from the sports-value-engine directory:
//   npx ts-node src/core/engine/hockeyCrossLeagueParlayTest.ts
import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const MIN_ODDS = 1.5;
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

// Same files/labels as the confirmed single-league test runs.
const LEAGUES: { csv: string; label: string }[] = [
  { csv: 'denmark_all.csv', label: 'Denmark' },
  { csv: 'nhl_all.csv', label: 'NHL' },
  { csv: 'ahl_all.csv', label: 'AHL' },
  { csv: 'eihl_all.csv', label: 'EIHL' },
  { csv: 'liiga_all.csv', label: 'Liiga' },
  { csv: 'shl_all.csv', label: 'SHL' },
  { csv: 'del_clean.csv', label: 'DEL' },
  { csv: 'DEL2_split.csv', label: 'DEL2' },
  { csv: 'ICEHockeyLeague_split.csv', label: 'ICEHL' },
  { csv: 'khl_all.csv', label: 'KHL' },
  { csv: 'sweden_clean.csv', label: 'Sweden' },
];

interface Leg { date: string; league: string; won: boolean; odds: number; confidence: number; wentToOt: boolean; }

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

// Same per-league leg-loading logic as hockeyRealisticSingleLeagueTest.ts,
// with a `league` tag added to each leg.
function loadLeagueLegs(csvPath: string, label: string): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { date: col('Date'), status: col('Status'), home: col('Home_Team'), away: col('Away_Team'), hs: col('Home_Score'), as: col('Away_Score'), ho: col('Home_Odds'), ao: col('Away_Odds') };

  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number; wentToOt: boolean };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const status = r[idx.status]?.trim();
    if (status !== 'Finished' && status !== 'After OT' && status !== 'After Pen.') continue;
    const date = parseFlexibleDate(r[idx.date]);
    if (isNaN(date.getTime())) continue;
    const hs = parseInt(r[idx.hs]), as = parseInt(r[idx.as]);
    if (isNaN(hs) || isNaN(as)) continue;
    const ho = parseFloat(r[idx.ho]), ao = parseFloat(r[idx.ao]);
    if (isNaN(ho) || isNaN(ao)) continue;
    const wentToOt = status === 'After OT' || status === 'After Pen.';
    games.push({ date, home: r[idx.home].trim(), away: r[idx.away].trim(), hs, as, ho, ao, wentToOt });
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
      const matchId = `${label}-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'hockey', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:label.toLowerCase()}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'hockey',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:label.toLowerCase()}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        const won = g.wentToOt ? false : (favHome ? g.hs > g.as : g.as > g.hs);
        legs.push({ date: g.date.toISOString().slice(0,10), league: label, won, odds, confidence, wentToOt: g.wentToOt });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

interface Parlay { date: string; won: boolean; odds: number; legs: [Leg, Leg]; }

function buildParlays(qualifyingLegs: Leg[]): Parlay[] {
  const byDate = new Map<string, Leg[]>();
  for (const l of qualifyingLegs) {
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date)!.push(l);
  }
  const parlays: Parlay[] = [];
  for (const [date, legs] of byDate) {
    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        if (legs[i].league === legs[j].league) continue; // cross-league only
        const odds = legs[i].odds * legs[j].odds;
        const won = legs[i].won && legs[j].won;
        parlays.push({ date, won, odds, legs: [legs[i], legs[j]] });
      }
    }
  }
  return parlays;
}

function computeStreaks(items: {won: boolean}[]): { win: number; loss: number } {
  let win = 0, loss = 0, cw = 0, cl = 0;
  for (const p of items) {
    if (p.won) { cw++; win = Math.max(win, cw); cl = 0; }
    else { cl++; loss = Math.max(loss, cl); cw = 0; }
  }
  return { win, loss };
}

function computeMaxDrawdown(items: {won: boolean; odds: number}[]): { maxAbs: number; maxPct: number } {
  let balance = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxAbs = 0, maxPct = 0;
  for (const p of items) {
    balance += p.won ? FIXED_STAKE * (p.odds - 1) : -FIXED_STAKE;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxAbs) { maxAbs = dd; maxPct = peak > 0 ? (dd/peak)*100 : 0; }
  }
  return { maxAbs, maxPct };
}

function fmtNaira(n: number): string { return `₦${Math.round(n).toLocaleString()}`; }

async function main() {
  console.log('Loading legs from all leagues...');
  const allLegs: Leg[] = [];
  for (const { csv, label } of LEAGUES) {
    if (!fs.existsSync(csv)) { console.log(`  ${label}: SKIPPED (file not found: ${csv})`); continue; }
    const legs = loadLeagueLegs(csv, label);
    console.log(`  ${label}: ${legs.length} candidate legs`);
    allLegs.push(...legs);
  }
  console.log(`\nTotal legs across all leagues: ${allLegs.length}\n`);

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n========== FLOOR ${(floor*100).toFixed(0)}%, MIN ODDS ${MIN_ODDS} (per leg) ==========`);
    const qualifying = allLegs.filter(l => l.confidence >= floor && l.odds >= MIN_ODDS);
    const parlays = buildParlays(qualifying);

    if (!parlays.length) { console.log('  0 parlays formed (need 2+ qualifying legs from different leagues on the same date).'); continue; }

    const wins = parlays.filter(p => p.won).length;
    const avgOdds = parlays.reduce((s,p)=>s+p.odds,0) / parlays.length;
    const breakeven = 100/avgOdds;
    const staked = parlays.length * FIXED_STAKE;
    const profit = parlays.reduce((s,p) => s + (p.won ? FIXED_STAKE*(p.odds-1) : -FIXED_STAKE), 0);
    const roi = (profit/staked)*100;

    console.log(`  ${parlays.length} parlays | wins: ${wins} (${(wins/parlays.length*100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg parlay odds: ${avgOdds.toFixed(3)} | ROI: ${roi.toFixed(2)}%`);

    const { win, loss } = computeStreaks(parlays);
    const dd = computeMaxDrawdown(parlays);
    console.log(`  Longest win streak: ${win} | Longest loss streak: ${loss} | Max drawdown: ${fmtNaira(dd.maxAbs)} (${dd.maxPct.toFixed(1)}%)`);

    const seasons = [...new Set(parlays.map(p => getSeasonLabel(p.date)))].sort();
    for (const season of seasons) {
      const sl = parlays.filter(p => getSeasonLabel(p.date) === season);
      const sw = sl.filter(p => p.won).length;
      const sst = sl.length * FIXED_STAKE;
      const spl = sl.reduce((s,p) => s + (p.won ? FIXED_STAKE*(p.odds-1) : -FIXED_STAKE), 0);
      console.log(`    ${season}: ${sl.length} parlays | ${sw} wins (${(sw/sl.length*100).toFixed(1)}%) | ROI: ${(spl/sst*100).toFixed(2)}%`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });