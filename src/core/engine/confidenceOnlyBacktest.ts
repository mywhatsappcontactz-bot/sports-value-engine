// src/core/engine/confidenceOnlyBacktest.ts
// Every pick that clears CONFIDENCE_FLOOR, regardless of odds - to see real
// volume and ROI before any odds-band narrowing.
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const STAKE = 10000;
const CONFIDENCE_FLOOR = 0.70;

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
function getSeasonLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 7 ? `${y}/${y+1}` : `${y-1}/${y}`;
}

function loadNbaLegsAllOdds(): Leg[] {
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
          legs.push({ date: g.date.toISOString().slice(0,10), league:'NBA', team: favHome?g.home:g.away, won, odds });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function loadLeagueLegsAllOdds(csvPath: string, leagueLabel: string): Leg[] {
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

  // DIAGNOSTIC: print distinct teams seen for this league, to confirm no
  // cross-contamination between league data files
  const teamsSeen = new Set<string>();
  games.forEach(g => { teamsSeen.add(g.home); teamsSeen.add(g.away); });
  console.log(`  [${leagueLabel} teams seen: ${[...teamsSeen].sort().join(', ')}]`);

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
          legs.push({ date: g.date.toISOString().slice(0,10), league: leagueLabel, team: favHome?g.home:g.away, won, odds });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function report(label: string, legs: Leg[]) {
  if (!legs.length) { console.log(`  ${label}: 0 bets`); return; }
  const wins = legs.filter(l => l.won).length;
  const staked = legs.length * STAKE;
  const profit = legs.reduce((s,l) => s + (l.won ? STAKE*(l.odds-1) : -STAKE), 0);
  const avgOdds = legs.reduce((s,l)=>s+l.odds,0) / legs.length;
  console.log(`  ${label}: ${legs.length} bets | wins: ${wins} (${(wins/legs.length*100).toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | staked: ₦${staked.toLocaleString()} | P/L: ₦${profit.toLocaleString(undefined,{maximumFractionDigits:0})} | ROI: ${(profit/staked*100).toFixed(2)}%`);
}

async function main() {
  const allLeagues: { label: string; legs: Leg[] }[] = [{ label: 'NBA', legs: loadNbaLegsAllOdds() }];
  for (const { label, envVar } of OTHER_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`(skipping ${label})`); continue; }
    allLeagues.push({ label, legs: loadLeagueLegsAllOdds(csvPath, label) });
  }

  console.log(`\n=== ALL CONFIDENCE-QUALIFYING PICKS (>= ${CONFIDENCE_FLOOR*100}%), ANY ODDS ===`);
  for (const { label, legs } of allLeagues) report(label, legs);

  console.log('\nPer-league per-season volume:');
  for (const { label, legs } of allLeagues) {
    const bySeasonCount: Record<string, number> = {};
    for (const l of legs) {
      const s = getSeasonLabel(l.date);
      bySeasonCount[s] = (bySeasonCount[s] || 0) + 1;
    }
    console.log(`  ${label}:`);
    for (const s of Object.keys(bySeasonCount).sort()) console.log(`    ${s}: ${bySeasonCount[s]} legs`);
  }

  console.log('\nPer-league per-season ROI:');
  for (const { label, legs } of allLeagues) {
    const seasons = [...new Set(legs.map(l => getSeasonLabel(l.date)))].sort();
    console.log(`  ${label}:`);
    for (const s of seasons) {
      const subset = legs.filter(l => getSeasonLabel(l.date) === s);
      report(`    ${s}`, subset);
    }
  }

  // === ANY-PAIR SAME-DAY PARLAY COUNTS (across all leagues, any odds) ===
  console.log('\n=== SAME-DAY 2-LEG PARLAYS ACROSS ALL LEAGUE PAIRS (any odds) ===');
  const byDate: Map<string, Map<string, Leg>> = new Map(); // date -> league -> first qualifying leg that day
  for (const { label, legs } of allLeagues) {
    for (const l of legs) {
      if (!byDate.has(l.date)) byDate.set(l.date, new Map());
      const m = byDate.get(l.date)!;
      if (!m.has(label)) m.set(label, l);
    }
  }

  const pairParlays: Record<string, { won: boolean; odds: number; profit: number }[]> = {};
  for (const [, leagueMap] of byDate) {
    const entries = [...leagueMap.entries()];
    if (entries.length < 2) continue;
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [labelA, legA] = entries[i];
        const [labelB, legB] = entries[j];
        const pairKey = [labelA, labelB].sort().join('+');
        const combinedOdds = legA.odds * legB.odds;
        const bothWon = legA.won && legB.won;
        const profit = bothWon ? STAKE * (combinedOdds - 1) : -STAKE;
        if (!pairParlays[pairKey]) pairParlays[pairKey] = [];
        pairParlays[pairKey].push({ won: bothWon, odds: combinedOdds, profit });
      }
    }
  }

  for (const pairKey of Object.keys(pairParlays).sort()) {
    const subset = pairParlays[pairKey];
    const w = subset.filter(p=>p.won).length;
    const st = subset.length * STAKE;
    const pl = subset.reduce((s,p)=>s+p.profit,0);
    const avgO = subset.reduce((s,p)=>s+p.odds,0) / subset.length;
    console.log(`  ${pairKey}: ${subset.length} parlays | wins: ${w} (${(w/subset.length*100).toFixed(1)}%) | avg odds: ${avgO.toFixed(3)} | staked: ₦${st.toLocaleString()} | P/L: ₦${pl.toLocaleString(undefined,{maximumFractionDigits:0})} | ROI: ${(pl/st*100).toFixed(2)}%`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });