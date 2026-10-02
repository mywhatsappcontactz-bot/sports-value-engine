// src/core/engine/leagueCalibrationFit.ts
// Fits a per-league isotonic calibration table (Pool Adjacent Violators
// Algorithm) mapping the model's ALREADY-CALIBRATED confidence (post
// Proballers pooled table) -> real observed win rate, using our own
// OddsPortal-sourced backtest data. This is a SECOND correction on top of
// the existing pooled calibration - it fixes whatever residual gap is
// left specifically for leagues where the pooled 24-league average
// doesn't fit well (confirmed via calibrationBacktest.ts: FRA/ITA/ACB/
// GRE/TUR all show real overconfidence gaps the pooled table misses).
//
// Output format matches NBA_ISOTONIC_BLOCKS / etc. in probabilityModel.ts
// exactly, so results can be pasted straight in as new per-league tables.
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const CONFIDENCE_FLOOR = 0.70;
const MIN_BLOCK_WEIGHT = 10; // drop blocks with fewer than this many picks - too noisy to trust

const TARGET_LEAGUES: { label: string; envVar: string }[] = [
  { label: 'ACB', envVar: 'ACB_ODDS_CSV' },
  { label: 'FRA', envVar: 'FRA_ODDS_CSV' },
  { label: 'GRE', envVar: 'GRE_ODDS_CSV' },
  { label: 'TUR', envVar: 'TUR_ODDS_CSV' },
  { label: 'ITA', envVar: 'ITA_ODDS_CSV' },
];

interface Leg { won: boolean; confidence: number; }

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
  const legs: Leg[] = [];
  for (const g of games) {
    const homeH = hist.get(g.home) ?? [], awayH = hist.get(g.away) ?? [];
    if (homeH.length >= 5 && awayH.length >= 5) {
      const h2h: H2HRecord[] = games.filter(x => x.date < g.date && ((x.home===g.home&&x.away===g.away)||(x.home===g.away&&x.away===g.home)))
       .map(x => { const flip = x.home !== g.home; const hs=flip?x.as:x.hs, as=flip?x.hs:x.as; return {date:x.date.toISOString(),homeTeam:g.home,awayTeam:g.away,homeScore:hs,awayScore:as,winner:(hs>as?'home':'away') as 'home' | 'away'}; });
      // CHANGED (see conversation): no longer truncates to last 10 — modelBasketball's
      // basketballDecayWinRate now applies exponential decay internally, matching
      // the live scraper path (also untruncated now). Full history passed through.
      const toForm = (recs:any[]):FormRecord[] => recs.map(r=>({date:r.date.toISOString(),opponent:r.opp,result:r.res,goalsFor:r.pf,goalsAgainst:r.pa,venue:r.home?'home':'away'}));
      const matchId = `${leagueLabel.toLowerCase()}-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'basketball', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:leagueLabel}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'basketball',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:leagueLabel}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        if (confidence >= CONFIDENCE_FLOOR) {
          const won = favHome ? g.hs > g.as : g.as > g.hs;
          legs.push({ won, confidence });
        }
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

// Pool Adjacent Violators Algorithm - fits the best non-decreasing
// step function through (confidence, won) points, minimizing squared
// error. This is the standard technique for isotonic calibration,
// same as the fits already in probabilityModel.ts.
function poolAdjacentViolators(points: { x: number; y: number }[]): { x: number; y: number; weight: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const blocks: { sumY: number; n: number; xs: number[] }[] = [];
  for (const p of sorted) {
    blocks.push({ sumY: p.y, n: 1, xs: [p.x] });
    while (
      blocks.length > 1 &&
      blocks[blocks.length - 2].sumY / blocks[blocks.length - 2].n >
      blocks[blocks.length - 1].sumY / blocks[blocks.length - 1].n
    ) {
      const b2 = blocks.pop()!;
      const b1 = blocks.pop()!;
      blocks.push({ sumY: b1.sumY + b2.sumY, n: b1.n + b2.n, xs: [...b1.xs, ...b2.xs] });
    }
  }
  return blocks.map(b => ({
    x: Math.max(...b.xs),
    y: b.sumY / b.n,
    weight: b.n,
  }));
}

async function main() {
  for (const { label, envVar } of TARGET_LEAGUES) {
    const csvPath = process.env[envVar];
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`(skipping ${label} - ${envVar} not set)`); continue; }

    console.log(`\n// ─── ${label} ISOTONIC (fitted on OddsPortal backtest data) ───`);
    const legs = loadLeagueLegs(csvPath, label);
    console.log(`// ${legs.length} predictions used for this fit`);

    const points = legs.map(l => ({ x: l.confidence, y: l.won ? 1 : 0 }));
    const rawBlocks = poolAdjacentViolators(points);

    const trustedBlocks = rawBlocks.filter(b => b.weight >= MIN_BLOCK_WEIGHT);
    const droppedWeight = rawBlocks.filter(b => b.weight < MIN_BLOCK_WEIGHT).reduce((s,b)=>s+b.weight,0);

    if (!trustedBlocks.length) { console.log(`// Not enough data for a reliable fit (all blocks under ${MIN_BLOCK_WEIGHT} weight)`); continue; }

    console.log(`// Reliable range: x=${trustedBlocks[0].x.toFixed(4)}-${trustedBlocks[trustedBlocks.length-1].x.toFixed(4)} (${trustedBlocks.length} blocks, min weight ${MIN_BLOCK_WEIGHT}, ${droppedWeight} picks in excluded noisy blocks)`);
    console.log(`const ${label}_ISOTONIC_BLOCKS: { x: number; y: number }[] = [`);
    for (const b of trustedBlocks) {
      console.log(`  { x: ${b.x.toFixed(4)}, y: ${b.y.toFixed(4)} }, // weight: ${b.weight}`);
    }
    console.log(`];`);
  }

  console.log(`\n\n// To wire these in: add each league's table above near PROBALLERS_ISOTONIC_BLOCKS`);
  console.log(`// in probabilityModel.ts, then update applyBasketballIsotonicCalibration's`);
  console.log(`// league lookup to check for these specific leagues before falling back to`);
  console.log(`// the pooled PROBALLERS_ISOTONIC_BLOCKS for leagues without their own fit.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });