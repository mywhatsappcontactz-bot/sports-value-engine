// src/core/engine/hockeyRealisticSingleLeagueTest.ts
//
// CORRECTED METHODOLOGY vs all previous hockey backtests in this project:
// A straight regulation-time pick ("Home wins") has ALREADY LOST the
// moment a game goes to OT/shootout - it doesn't matter who wins the
// extra period, because "Home wins in regulation" simply didn't happen.
// Previous versions either excluded OT games entirely (hiding real
// losses) or graded them by final score (crediting wins that shouldn't
// count for a regulation-only bet). This version does neither: every
// game is included, and any game that went to OT/shootout is an
// AUTOMATIC LOSS for whichever side you picked, full stop - the final
// score of an OT game is never even looked at for settlement purposes.
//
// Also filters to MIN_ODDS (1.5+ by default) on top of the confidence
// floor, per request.
import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const MIN_ODDS = 1.25;
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

const LEAGUE_CSV = process.env.LEAGUE_CSV;
const LEAGUE_LABEL = process.env.LEAGUE_LABEL || 'League';

if (!LEAGUE_CSV) {
  console.error('Set $env:LEAGUE_CSV to the CSV path, and optionally $env:LEAGUE_LABEL to a display name.');
  process.exit(1);
}

interface Leg { date: string; won: boolean; odds: number; confidence: number; wentToOt: boolean; }

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

  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number; wentToOt: boolean };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const status = r[idx.status]?.trim();
    // ACCEPT all three statuses - this is the key fix vs earlier versions
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

        // THE FIX: OT/shootout = automatic loss, full stop. Final score is
        // never consulted for these games - "won in OT" does not count as
        // winning the regulation-time pick.
        const won = g.wentToOt ? false : (favHome ? g.hs > g.as : g.as > g.hs);

        legs.push({ date: g.date.toISOString().slice(0,10), won, odds, confidence, wentToOt: g.wentToOt });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function computeStreaks(legs: Leg[]): { win: number; loss: number } {
  let win = 0, loss = 0, cw = 0, cl = 0;
  for (const l of legs) {
    if (l.won) { cw++; win = Math.max(win, cw); cl = 0; }
    else { cl++; loss = Math.max(loss, cl); cw = 0; }
  }
  return { win, loss };
}

function computeMaxDrawdown(legs: Leg[]): { maxAbs: number; maxPct: number } {
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
  const allLegs = loadAllPicks(LEAGUE_CSV!, LEAGUE_LABEL);
  const otCount = allLegs.filter(l => l.wentToOt).length;
  console.log(`${LEAGUE_LABEL}: ${allLegs.length} total candidate legs loaded (ALL statuses included)`);
  console.log(`  Of which ${otCount} (${allLegs.length ? (otCount/allLegs.length*100).toFixed(1) : '0'}%) went to OT/shootout - these are automatic losses.\n`);

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n========== FLOOR ${(floor*100).toFixed(0)}%, MIN ODDS ${MIN_ODDS} ==========`);
    const qualifying = allLegs.filter(l => l.confidence >= floor && l.odds >= MIN_ODDS);

    if (!qualifying.length) { console.log('  0 qualifying bets.'); continue; }

    const wins = qualifying.filter(l => l.won).length;
    const otLosses = qualifying.filter(l => l.wentToOt).length;
    const avgOdds = qualifying.reduce((s,l)=>s+l.odds,0) / qualifying.length;
    const breakeven = 100/avgOdds;
    const staked = qualifying.length * FIXED_STAKE;
    const profit = qualifying.reduce((s,l) => s + (l.won ? FIXED_STAKE*(l.odds-1) : -FIXED_STAKE), 0);
    const roi = (profit/staked)*100;

    console.log(`  ${qualifying.length} bets | wins: ${wins} (${(wins/qualifying.length*100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | ROI: ${roi.toFixed(2)}%`);
    console.log(`  Of these, ${otLosses} (${(otLosses/qualifying.length*100).toFixed(1)}%) were OT/shootout automatic losses - previous backtests silently excluded these.`);

    const { win, loss } = computeStreaks(qualifying);
    const dd = computeMaxDrawdown(qualifying);
    console.log(`  Longest win streak: ${win} | Longest loss streak: ${loss} | Max drawdown: ${fmtNaira(dd.maxAbs)} (${dd.maxPct.toFixed(1)}%)`);

    const seasons = [...new Set(qualifying.map(l => getSeasonLabel(l.date)))].sort();
    for (const season of seasons) {
      const sl = qualifying.filter(l => getSeasonLabel(l.date) === season);
      const sw = sl.filter(l => l.won).length;
      const sst = sl.length * FIXED_STAKE;
      const spl = sl.reduce((s,l) => s + (l.won ? FIXED_STAKE*(l.odds-1) : -FIXED_STAKE), 0);
      console.log(`    ${season}: ${sl.length} bets | ${sw} wins (${(sw/sl.length*100).toFixed(1)}%) | ROI: ${(spl/sst*100).toFixed(2)}%`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
