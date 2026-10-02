// src/core/engine/recalibratedRoiBacktest.ts
// Applies the 5 freshly-fitted per-league isotonic tables (from
// leagueCalibrationFit.ts output) ON TOP of the existing model pipeline,
// re-filters to CORRECTED confidence >= 70%, and recomputes real ROI.
// This tells us whether honest calibration turns any league profitable,
// or just correctly shrinks the qualifying pool without creating edge.
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const STAKE = 10000;
const NEW_CONFIDENCE_FLOOR = 0.70; // applied AFTER our own recalibration

// Fitted tables, pasted directly from leagueCalibrationFit.ts's output
const LEAGUE_TABLES: Record<string, { x: number; y: number }[]> = {
  ACB: [
    { x: 0.7033, y: 0.5625 },
    { x: 0.7342, y: 0.6939 },
    { x: 0.7409, y: 0.7143 },
    { x: 0.7791, y: 0.7368 },
    { x: 0.8875, y: 0.8273 },
    { x: 0.9156, y: 0.8824 },
  ],
  FRA: [
    { x: 0.7247, y: 0.6176 },
    { x: 0.7395, y: 0.6667 },
    { x: 0.7409, y: 0.6667 },
    { x: 0.7603, y: 0.7183 },
    { x: 0.8824, y: 0.7277 },
    { x: 0.9205, y: 0.7333 },
  ],
  GRE: [
    { x: 0.7298, y: 0.7273 },
    { x: 0.8901, y: 0.8205 },
  ],
  TUR: [
    { x: 0.7409, y: 0.6716 },
    { x: 0.7444, y: 0.6818 },
    { x: 0.7603, y: 0.7000 },
    { x: 0.7663, y: 0.7619 },
    { x: 0.8568, y: 0.7903 },
    { x: 0.9099, y: 0.8000 },
  ],
  ITA: [
    { x: 0.7663, y: 0.6626 },
    { x: 0.7669, y: 0.7333 },
    { x: 0.8846, y: 0.7426 },
  ],
};

function applyLeagueCalibration(rawConfidence: number, league: string): number {
  const blocks = LEAGUE_TABLES[league];
  if (!blocks) return rawConfidence; // no fit for this league - pass through
  if (rawConfidence <= blocks[0].x) return blocks[0].y;
  if (rawConfidence >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;
  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawConfidence >= blocks[i].x && rawConfidence <= blocks[i + 1].x) {
      const t = (rawConfidence - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawConfidence;
}

const OTHER_LEAGUES: { label: string; envVar: string }[] = [
  { label: 'ACB', envVar: 'ACB_ODDS_CSV' },
  { label: 'FRA', envVar: 'FRA_ODDS_CSV' },
  { label: 'GRE', envVar: 'GRE_ODDS_CSV' },
  { label: 'TUR', envVar: 'TUR_ODDS_CSV' },
  { label: 'ITA', envVar: 'ITA_ODDS_CSV' },
];

interface Leg { won: boolean; odds: number; rawConfidence: number; correctedConfidence: number; }

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
  // NOTE: base confidence floor lowered to catch picks that were previously
  // just under 70% raw too - not needed here since we only had data >=70%
  // raw to begin with, so this stays consistent with our stored dataset.
  const RAW_FLOOR = 0.70;
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
        const rawConfidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        if (rawConfidence >= RAW_FLOOR) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          const correctedConfidence = applyLeagueCalibration(rawConfidence, leagueLabel);
          legs.push({ won, odds, rawConfidence, correctedConfidence });
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
  const breakeven = 100/avgOdds;
  console.log(`  ${label}: ${legs.length} bets | wins: ${wins} (${(wins/legs.length*100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | staked: ₦${staked.toLocaleString()} | P/L: ₦${profit.toLocaleString(undefined,{maximumFractionDigits:0})} | ROI: ${(profit/staked*100).toFixed(2)}%`);
}

async function main() {
  for (const { label, envVar } of OTHER_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`(skipping ${label})`); continue; }
    const allLegs = loadLeagueLegs(csvPath, label);

    console.log(`\n=== ${label} ===`);
    console.log(`  BEFORE recalibration (raw confidence >= 70%):`);
    report('    ', allLegs);

    const correctedQualifying = allLegs.filter(l => l.correctedConfidence >= NEW_CONFIDENCE_FLOOR);
    console.log(`  AFTER recalibration (corrected confidence >= 70%, ${allLegs.length - correctedQualifying.length} picks dropped):`);
    report('    ', correctedQualifying);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });