// src/core/engine/hockeyCrossLeagueParlay.ts
// Pairs favorites-only picks (odds <= opponentOdds) from two DIFFERENT
// hockey leagues on the SAME DAY into 2-leg parlays. Real combined odds,
// real combined outcomes - no squared assumptions.
import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const CONFIDENCE_FLOOR = 0.55;
const STAKE = 10000;

const LEAGUES: { label: string; csv: string }[] = [
  { label: 'NHL', csv: 'nhl_all.csv' },
  { label: 'KHL', csv: 'khl_all.csv' },
  { label: 'DEL', csv: 'del2_only.csv' }, // adjust paths to your actual files
  { label: 'AHL', csv: 'ahl_all.csv' },
  { label: 'Liiga', csv: 'liiga_all.csv' },
  { label: 'HockeyAllsvenskan', csv: 'sweden_all.csv' },
  { label: 'EIHL', csv: 'eihl_all.csv' },
];

interface Leg { date: string; league: string; won: boolean; odds: number; }

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

function loadFavoritePicks(csvPath: string, label: string): Leg[] {
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
        if (confidence >= CONFIDENCE_FLOOR && odds <= opponentOdds) { // favorites only
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ date: g.date.toISOString().slice(0,10), league: label, won, odds });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

async function main() {
  const allLegs: Leg[] = [];
  for (const { label, csv } of LEAGUES) {
    if (!fs.existsSync(csv)) { console.log(`(skipping ${label} - ${csv} not found)`); continue; }
    const legs = loadFavoritePicks(csv, label);
    console.log(`${label}: ${legs.length} favorite picks loaded`);
    allLegs.push(...legs);
  }

  const byDate = new Map<string, Leg[]>();
  for (const l of allLegs) { if (!byDate.has(l.date)) byDate.set(l.date, []); byDate.get(l.date)!.push(l); }

  const pairParlays: Record<string, { won: boolean; odds: number; profit: number }[]> = {};
  for (const [, legsThatDay] of byDate) {
    const byLeague = new Map<string, Leg>();
    for (const l of legsThatDay) if (!byLeague.has(l.league)) byLeague.set(l.league, l); // first pick per league that day
    const entries = [...byLeague.entries()];
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [labelA, legA] = entries[i], [labelB, legB] = entries[j];
        const pairKey = [labelA, labelB].sort().join('+');
        const combinedOdds = legA.odds * legB.odds;
        const bothWon = legA.won && legB.won;
        const profit = bothWon ? STAKE * (combinedOdds - 1) : -STAKE;
        if (!pairParlays[pairKey]) pairParlays[pairKey] = [];
        pairParlays[pairKey].push({ won: bothWon, odds: combinedOdds, profit });
      }
    }
  }

  console.log(`\n=== CROSS-LEAGUE 2-LEG PARLAYS (favorites only, floor ${CONFIDENCE_FLOOR*100}%) ===`);
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