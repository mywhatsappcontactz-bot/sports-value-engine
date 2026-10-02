// src/core/engine/calibrationBacktest.ts
// Buckets every confidence-qualifying pick by the MODEL'S STATED CONFIDENCE
// (not odds), then checks actual win rate per bucket. If the model is
// well-calibrated, a bucket labeled "80-85%" should win about 80-85% of the
// time. If actual win rate is consistently lower than stated confidence,
// the model is overconfident by a measurable, specific amount.
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const CONFIDENCE_FLOOR = 0.70;
const BUCKETS = [
  { label: '70-75%', lo: 0.70, hi: 0.75 },
  { label: '75-80%', lo: 0.75, hi: 0.80 },
  { label: '80-85%', lo: 0.80, hi: 0.85 },
  { label: '85-90%', lo: 0.85, hi: 0.90 },
  { label: '90-95%', lo: 0.90, hi: 0.95 },
  { label: '95-100%', lo: 0.95, hi: 1.01 },
];

const NBA_CSV = process.env.NBA_ODDS_CSV ?? path.join(process.cwd(), 'nba_2008-2026.csv');
const OTHER_LEAGUES: { label: string; envVar: string }[] = [
  { label: 'ACB', envVar: 'ACB_ODDS_CSV' },
  { label: 'BLS', envVar: 'BLS_ODDS_CSV' },
  { label: 'BBL', envVar: 'BBL_ODDS_CSV' },
  { label: 'FRA', envVar: 'FRA_ODDS_CSV' },
  { label: 'GRE', envVar: 'GRE_ODDS_CSV' },
  { label: 'TUR', envVar: 'TUR_ODDS_CSV' },
  { label: 'ITA', envVar: 'ITA_ODDS_CSV' },
];

// Extended leg: now also carries the model's stated confidence
interface Leg { date: string; league: string; team: string; won: boolean; odds: number; confidence: number; }

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
        if (confidence >= CONFIDENCE_FLOOR) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), league:'NBA', team: favHome?g.home:g.away, won, odds, confidence });
        }
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
        if (confidence >= CONFIDENCE_FLOOR) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), league: leagueLabel, team: favHome?g.home:g.away, won, odds, confidence });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

async function main() {
  const allLeagues: { label: string; legs: Leg[] }[] = [{ label: 'NBA', legs: loadNbaLegs() }];
  for (const { label, envVar } of OTHER_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`(skipping ${label})`); continue; }
    allLeagues.push({ label, legs: loadLeagueLegs(csvPath, label) });
  }
  const allLegs = allLeagues.flatMap(l => l.legs);

  console.log(`Total confidence-qualifying picks across all leagues: ${allLegs.length}\n`);
  console.log('=== CALIBRATION: stated confidence vs actual win rate ===');
  console.log('(A well-calibrated model has "actual" close to "stated". If actual is');
  console.log(' consistently LOWER, the model is overconfident by that gap.)\n');

  for (const { label, lo, hi } of BUCKETS) {
    const bucket = allLegs.filter(l => l.confidence >= lo && l.confidence < hi);
    if (!bucket.length) { console.log(`${label}: 0 picks`); continue; }
    const wins = bucket.filter(l => l.won).length;
    const actualWinRate = (wins / bucket.length) * 100;
    const avgStatedConfidence = (bucket.reduce((s,l)=>s+l.confidence,0) / bucket.length) * 100;
    const gap = actualWinRate - avgStatedConfidence;
    const avgOdds = bucket.reduce((s,l)=>s+l.odds,0) / bucket.length;
    console.log(`${label}: ${bucket.length} picks | stated: ${avgStatedConfidence.toFixed(1)}% | actual: ${actualWinRate.toFixed(1)}% | gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pts | avg odds: ${avgOdds.toFixed(3)}`);
  }

  console.log('\n=== SAME BREAKDOWN, PER LEAGUE ===');
  for (const { label, legs } of allLeagues) {
    console.log(`\n${label}:`);
    for (const { label: bLabel, lo, hi } of BUCKETS) {
      const bucket = legs.filter(l => l.confidence >= lo && l.confidence < hi);
      if (!bucket.length) continue;
      const wins = bucket.filter(l => l.won).length;
      const actualWinRate = (wins / bucket.length) * 100;
      const avgStatedConfidence = (bucket.reduce((s,l)=>s+l.confidence,0) / bucket.length) * 100;
      const gap = actualWinRate - avgStatedConfidence;
      console.log(`  ${bLabel}: ${bucket.length} picks | stated: ${avgStatedConfidence.toFixed(1)}% | actual: ${actualWinRate.toFixed(1)}% | gap: ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pts`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });