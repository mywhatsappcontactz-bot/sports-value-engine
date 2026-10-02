// src/core/engine/hockeyBacktest.ts
// Tests the model's HOCKEY formula (modelHockey - ELO + HOME_ICE_ADVANTAGE +
// HOCKEY_ISOTONIC_BLOCKS) against real NHL data, same rigor as the
// basketball backtests: qualifying legs, win rate, ROI, and a calibration
// check (stated confidence vs actual win rate).
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const STAKE = 10000;
const CONFIDENCE_FLOOR = 0.70;

const NHL_CSV = process.env.NHL_ODDS_CSV ?? path.join(process.cwd(), 'nhl_all.csv');

interface Leg { date: string; won: boolean; odds: number; confidence: number; }

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

function loadHockeyLegs(csvPath: string): Leg[] {
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
      const matchId = `nhl-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'hockey', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:'nhl'}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'hockey',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:'nhl'}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        if (confidence >= CONFIDENCE_FLOOR) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), won, odds, confidence });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

async function main() {
  const legs = loadHockeyLegs(NHL_CSV);
  console.log(`NHL confidence-qualifying legs (>= ${CONFIDENCE_FLOOR*100}%): ${legs.length}\n`);

  if (!legs.length) { console.log('No qualifying legs found.'); return; }

  const wins = legs.filter(l => l.won).length;
  const staked = legs.length * STAKE;
  const profit = legs.reduce((s,l) => s + (l.won ? STAKE*(l.odds-1) : -STAKE), 0);
  const avgOdds = legs.reduce((s,l)=>s+l.odds,0) / legs.length;
  console.log(`=== OVERALL ===`);
  console.log(`${legs.length} bets | wins: ${wins} (${(wins/legs.length*100).toFixed(1)}%, need ${(100/avgOdds).toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | staked: ₦${staked.toLocaleString()} | P/L: ₦${profit.toLocaleString(undefined,{maximumFractionDigits:0})} | ROI: ${(profit/staked*100).toFixed(2)}%`);

  console.log(`\n=== CALIBRATION CHECK (stated confidence vs actual win rate) ===`);
  const BUCKETS = [
    { label: '70-75%', lo: 0.70, hi: 0.75 },
    { label: '75-80%', lo: 0.75, hi: 0.80 },
    { label: '80-85%', lo: 0.80, hi: 0.85 },
    { label: '85-90%', lo: 0.85, hi: 0.90 },
    { label: '90-95%', lo: 0.90, hi: 0.95 },
    { label: '95-100%', lo: 0.95, hi: 1.01 },
  ];
  for (const { label, lo, hi } of BUCKETS) {
    const bucket = legs.filter(l => l.confidence >= lo && l.confidence < hi);
    if (!bucket.length) { console.log(`${label}: 0 picks`); continue; }
    const bWins = bucket.filter(l => l.won).length;
    const actualWinRate = (bWins / bucket.length) * 100;
    const avgStated = (bucket.reduce((s,l)=>s+l.confidence,0) / bucket.length) * 100;
    const gap = actualWinRate - avgStated;
    console.log(`${label}: ${bucket.length} picks | stated: ${avgStated.toFixed(1)}% | actual: ${actualWinRate.toFixed(1)}% | gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pts`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });