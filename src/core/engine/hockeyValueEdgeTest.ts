// src/core/engine/hockeyValueEdgeTest.ts
//
// NEW SELECTION MODE: value betting, not confidence-floor betting.
//
// Every previous hockey test selected bets by "is the model's
// confidence above X%?" - a pure certainty filter that says nothing
// about whether the ODDS on offer are actually good value. This test
// uses a different, arguably more correct signal: does the model's
// confidence exceed what the MARKET itself already believes?
//
// For each leg (same corrected per-leg settlement as all other hockey
// tests - OT/shootout is an automatic loss):
//   1. Devig the posted Home/Away odds into a fair market-implied
//      probability for whichever side the model picked (same devig
//      method as hockeyDrawCalibrationCheck.ts, but 2-way here since
//      most CSVs only have Home/Away odds).
//   2. edge = model confidence - market implied probability for that
//      side. Positive edge means the model is MORE confident than
//      the market's own pricing - i.e. the model thinks this is
//      underpriced. Negative/zero edge means the model is just
//      agreeing with (or less sure than) the market, which is not a
//      real signal.
//   3. Test a range of minimum edge thresholds (0%, 3%, 5%, 8%, 10%,
//      15%) instead of a confidence floor. Also reports the OLD
//      confidence-floor-55% baseline for direct comparison.
//
// This directly tests whether "the model disagrees with the market"
// is a better selection signal than "the model is sure of itself" -
// a fundamentally different hypothesis, not a variant of the same one.
//
// Usage: no env vars, league list hardcoded (same as other cross-
// league tests). Run from sports-value-engine directory:
//   npx ts-node src/core/engine/hockeyValueEdgeTest.ts
import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const MIN_ODDS = 1.5;
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;
const EDGE_THRESHOLDS = [0.00, 0.03, 0.05, 0.08, 0.10, 0.15];

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

interface Leg { date: string; league: string; won: boolean; odds: number; confidence: number; marketImplied: number; edge: number; wentToOt: boolean; }

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

        // Devig the 2-way market odds to get the fair implied probability
        // of whichever side the model picked.
        const rawHome = 1 / g.ho, rawAway = 1 / g.ao;
        const overround = rawHome + rawAway;
        const marketImplied = favHome ? (rawHome / overround) : (rawAway / overround);
        const edge = confidence - marketImplied;

        const won = g.wentToOt ? false : (favHome ? g.hs > g.as : g.as > g.hs);
        legs.push({ date: g.date.toISOString().slice(0,10), league: label, won, odds, confidence, marketImplied, edge, wentToOt: g.wentToOt });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
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

function reportBucket(label: string, items: Leg[]) {
  if (!items.length) { console.log(`  [${label}] 0 bets.`); return; }
  const wins = items.filter(l => l.won).length;
  const avgOdds = items.reduce((s,l)=>s+l.odds,0) / items.length;
  const avgEdge = items.reduce((s,l)=>s+l.edge,0) / items.length;
  const breakeven = 100/avgOdds;
  const staked = items.length * FIXED_STAKE;
  const profit = items.reduce((s,l) => s + (l.won ? FIXED_STAKE*(l.odds-1) : -FIXED_STAKE), 0);
  const roi = (profit/staked)*100;
  const { win, loss } = computeStreaks(items);
  const dd = computeMaxDrawdown(items);
  console.log(`  [${label}] ${items.length} bets | wins: ${wins} (${(wins/items.length*100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | avg edge: ${(avgEdge*100).toFixed(1)}pp | ROI: ${roi.toFixed(2)}%`);
  console.log(`    Longest win streak: ${win} | Longest loss streak: ${loss} | Max drawdown: ${fmtNaira(dd.maxAbs)} (${dd.maxPct.toFixed(1)}%)`);
}

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

  // Baseline for comparison: old confidence-floor-55% method.
  console.log('========== BASELINE: confidence >= 55% (old method) ==========');
  reportBucket('confidence >= 55%', allLegs.filter(l => l.confidence >= 0.55 && l.odds >= MIN_ODDS));

  console.log('\n========== NEW METHOD: value edge thresholds (model confidence - market implied prob) ==========');
  for (const threshold of EDGE_THRESHOLDS) {
    const qualifying = allLegs.filter(l => l.edge >= threshold && l.odds >= MIN_ODDS);
    reportBucket(`edge >= ${(threshold*100).toFixed(0)}pp`, qualifying);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });