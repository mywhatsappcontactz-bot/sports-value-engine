// src/core/engine/crossLeagueParlayBacktest.ts
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const STAKE = 10000;
const CONFIDENCE_FLOOR = 0.70;
const MIN_ODDS = 1.25;
const MAX_ODDS = 1.65;

const NBA_CSV = process.env.NBA_ODDS_CSV ?? path.join(process.cwd(), 'nba_2008-2026.csv');

// Any league beyond NBA is loaded generically from a CSV with the shape:
// Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Away_Odds
// Add or remove entries here as you get more league data - each is optional,
// missing env vars are simply skipped.
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

// ── NBA LOADING ──
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
        if (confidence >= CONFIDENCE_FLOOR && odds >= MIN_ODDS && odds <= MAX_ODDS) {
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

// ── GENERIC LEAGUE LOADING ──
// Format: Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Away_Odds
function loadLeagueLegs(csvPath: string, leagueLabel: string): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = {
    date: col('Date'), status: col('Status'),
    home: col('Home_Team'), away: col('Away_Team'),
    hs: col('Home_Score'), as: col('Away_Score'),
    ho: col('Home_Odds'), ao: col('Away_Odds'),
  };

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
        if (confidence >= CONFIDENCE_FLOOR && odds >= MIN_ODDS && odds <= MAX_ODDS) {
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

function average(nums: number[]): number {
  if (!nums.length) return NaN;
  return nums.reduce((s,n) => s+n, 0) / nums.length;
}

async function main() {
  const nbaLegs = loadNbaLegs();
  console.log(`NBA qualifying legs (${MIN_ODDS}-${MAX_ODDS}): ${nbaLegs.length}, avg odds: ${average(nbaLegs.map(l=>l.odds)).toFixed(3)}`);

  // Load every other configured league, skipping any without an env var set
  const leagueLegs: { label: string; legs: Leg[] }[] = [];
  for (const { label, envVar } of OTHER_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath) { console.log(`(skipping ${label} - ${envVar} not set)`); continue; }
    if (!fs.existsSync(csvPath)) { console.log(`(skipping ${label} - file not found: ${csvPath})`); continue; }
    const legs = loadLeagueLegs(csvPath, label);
    console.log(`${label} qualifying legs (${MIN_ODDS}-${MAX_ODDS}): ${legs.length}, avg odds: ${average(legs.map(l=>l.odds)).toFixed(3)}`);
    leagueLegs.push({ label, legs });
  }

  if (!leagueLegs.length) { console.log('No other leagues loaded - nothing to cross with NBA.'); return; }

  // Index each league's legs by date
  const byDate: Map<string, Map<string, Leg[]>> = new Map(); // date -> league -> legs
  for (const { label, legs } of leagueLegs) {
    for (const l of legs) {
      if (!byDate.has(l.date)) byDate.set(l.date, new Map());
      const m = byDate.get(l.date)!;
      if (!m.has(label)) m.set(label, []);
      m.get(label)!.push(l);
    }
  }

  // For each NBA leg's date, build a parlay from NBA + one leg from EACH other
  // league that also has a qualifying leg that day (skips leagues with no leg that day)
  let parlays: { won: boolean; odds: number; profit: number; legCount: number }[] = [];
  for (const nbaLeg of nbaLegs) {
    const dayMap = byDate.get(nbaLeg.date);
    if (!dayMap || !dayMap.size) continue;

    const chosenLegs: Leg[] = [nbaLeg];
    for (const { label } of leagueLegs) {
      const candidates = dayMap.get(label);
      if (candidates && candidates.length) chosenLegs.push(candidates[0]);
    }
    if (chosenLegs.length < 2) continue; // need at least NBA + 1 other league

    const combinedOdds = chosenLegs.reduce((p, l) => p * l.odds, 1);
    const allWon = chosenLegs.every(l => l.won);
    const profit = allWon ? STAKE * (combinedOdds - 1) : -STAKE;
    parlays.push({ won: allWon, odds: combinedOdds, profit, legCount: chosenLegs.length });
  }

  console.log(`\nCross-league parlays formed (NBA + >=1 other league, same day): ${parlays.length}`);
  if (!parlays.length) { console.log('No overlapping dates with both legs qualifying.'); return; }

  const wins = parlays.filter(p => p.won).length;
  const staked = parlays.length * STAKE;
  const profit = parlays.reduce((s, p) => s + p.profit, 0);
  const avgOdds = average(parlays.map(p => p.odds));
  const avgLegCount = average(parlays.map(p => p.legCount));

  console.log(`Wins: ${wins} (${((wins/parlays.length)*100).toFixed(1)}%)`);
  console.log(`Average combined parlay odds: ${avgOdds.toFixed(3)}`);
  console.log(`Average legs per parlay: ${avgLegCount.toFixed(2)}`);
  console.log(`Total staked: ₦${staked.toLocaleString()}`);
  console.log(`Total profit/loss: ₦${profit.toLocaleString(undefined,{maximumFractionDigits:0})}`);
  console.log(`REAL ROI: ${((profit/staked)*100).toFixed(2)}%`);
}

main().catch(e => { console.error(e.message); process.exit(1); });