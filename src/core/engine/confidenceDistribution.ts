// src/core/engine/confidenceDistribution.ts
//
// DIAGNOSTIC SCRIPT - not a backtest, doesn't simulate stakes or ROI.
// Reports the RAW distribution of modelHockey()'s confidence output
// across every game in every whitelisted league CSV, bucketed into
// 5-point confidence bands (50-55%, 55-60%, ..., 95-100%).
//
// WHY THIS EXISTS: leagueDetailedReport.ts --ot-convert showed bet
// counts falling off a cliff between the 55% floor (10,080 bets) and
// the 60% floor (1,195 bets) - an 8.4x drop for a 5-point confidence
// increase - alongside ROI getting WORSE as the floor rises, which is
// backwards for a well-calibrated model. This script answers the
// narrower question directly: is the model's confidence output really
// that heavily clustered right around 50-55%, or is something else
// going on (e.g. a filtering bug elsewhere)? No staking, no odds, no
// floors, no OT-convert logic - just "how many games get which
// confidence score."
//
// Every game with enough history (5+ prior games each side, same rule
// as leagueDetailedReport.ts) gets a confidence score computed, no
// matter what its odds were or whether it went to OT - this is about
// the model's raw output, not about which games would qualify as bets.
//
// USAGE:
//   npx ts-node src/core/engine/confidenceDistribution.ts
//   npx ts-node src/core/engine/confidenceDistribution.ts | Tee-Object -FilePath confidence_distribution.txt

import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

interface LeagueConfig { name: string; csvPath: string; }

// Same whitelist/derivation logic as leagueDetailedReport.ts - kept in
// sync deliberately so this script sees exactly the same league set.
const HOCKEY_LEAGUE_WHITELIST = new Set([
  'NHL', 'KHL', 'DEL', 'DEL2', 'LIIGA', 'MESTIS', 'SHL',
  'HOCKEYALLSVENSKAN', 'ICE HOCKEY LEAGUE', 'ICEHL', 'ELITE LEAGUE', 'EIHL', 'AHL',
  'METAL LIGAEN',
]);

function deriveLeagueName(csvPath: string): string {
  try {
    const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/);
    const header = lines[0]?.split(',') ?? [];
    const tIdx = header.indexOf('Tournament');
    if (tIdx !== -1) {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i]?.split(',');
        if (cols?.[tIdx]) return cols[tIdx].replace(/\s+\d{4}\/\d{4}$/, '').trim();
      }
    }
  } catch { /* fall through */ }
  return path.basename(csvPath).replace(/_all\.csv$/i, '').toUpperCase();
}

function discoverLeagues(): LeagueConfig[] {
  const dir = process.cwd();
  const files = fs.readdirSync(dir).filter(f => /_all\.csv$/i.test(f));
  const seen = new Set<string>();
  const leagues: LeagueConfig[] = [];
  for (const f of files) {
    const csvPath = path.join(dir, f);
    const name = deriveLeagueName(csvPath);
    if (!HOCKEY_LEAGUE_WHITELIST.has(name.toUpperCase())) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    leagues.push({ name, csvPath });
  }
  return leagues.sort((a, b) => a.name.localeCompare(b.name));
}

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

// The 10 confidence bands we're bucketing into. Confidence is always
// >= 0.5 by construction (max(homeProb, 1-homeProb)), so bands start
// at 50%.
const BAND_EDGES = [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.001];
function bandLabel(i: number): string {
  const lo = Math.round(BAND_EDGES[i] * 100);
  const hi = Math.min(100, Math.round(BAND_EDGES[i + 1] * 100));
  return `${lo}-${hi}%`;
}
function bandIndex(confidence: number): number {
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    if (confidence >= BAND_EDGES[i] && confidence < BAND_EDGES[i + 1]) return i;
  }
  return BAND_EDGES.length - 2; // clamp for exactly 1.0
}

interface LeagueDistribution { name: string; total: number; bandCounts: number[]; }

function computeDistribution(csvPath: string): { total: number; bandCounts: number[] } {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { date: col('Date'), status: col('Status'), home: col('Home_Team'), away: col('Away_Team'), hs: col('Home_Score'), as: col('Away_Score'), ho: col('Home_Odds'), ao: col('Away_Odds') };

  type G = { date: Date; home: string; away: string; hs: number; as: number };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const status = r[idx.status]?.trim();
    // No status filtering beyond "did the game finish" - includes
    // regulation, OT, and shootout games alike. This is about what the
    // model outputs for a completed game, not about bet eligibility.
    if (status !== 'Finished' && status !== 'After OT' && status !== 'After Pen.') continue;
    const date = parseFlexibleDate(r[idx.date]);
    if (isNaN(date.getTime())) continue;
    const hs = parseInt(r[idx.hs]), as = parseInt(r[idx.as]);
    if (isNaN(hs) || isNaN(as) || hs === as) continue;
    games.push({ date, home: r[idx.home].trim(), away: r[idx.away].trim(), hs, as });
  }
  games.sort((a, b) => a.date.getTime() - b.date.getTime());

  const hist = new Map<string, {date:Date;opp:string;res:'W'|'L';home:boolean;pf:number;pa:number}[]>();
  const push = (t:string,r:any) => { if(!hist.has(t)) hist.set(t,[]); hist.get(t)!.push(r); };

  const bandCounts = new Array(BAND_EDGES.length - 1).fill(0);
  let total = 0;

  for (const g of games) {
    const homeH = hist.get(g.home) ?? [], awayH = hist.get(g.away) ?? [];
    if (homeH.length >= 5 && awayH.length >= 5) {
      const h2h: H2HRecord[] = games.filter(x => x.date < g.date && ((x.home===g.home&&x.away===g.away)||(x.home===g.away&&x.away===g.home)))
       .map(x => { const flip = x.home !== g.home; const hs=flip?x.as:x.hs, as=flip?x.hs:x.as; return {date:x.date.toISOString(),homeTeam:g.home,awayTeam:g.away,homeScore:hs,awayScore:as,winner:(hs>as?'home':'away') as 'home' | 'away'}; });
      const toForm = (recs:any[]):FormRecord[] => recs.slice(-10).map(r=>({date:r.date.toISOString(),opponent:r.opp,result:r.res,goalsFor:r.pf,goalsAgainst:r.pa,venue:r.home?'home':'away'}));
      const matchId = `l-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'hockey', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'hockey',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:'generic'}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const confidence = Math.max(homeProb, 1 - homeProb);
        bandCounts[bandIndex(confidence)]++;
        total++;
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }

  return { total, bandCounts };
}

function printTable(label: string, dists: LeagueDistribution[]) {
  const nBands = BAND_EDGES.length - 1;
  console.log(`\n${label}`);
  const header = ['League'.padEnd(20), 'Total'.padStart(7), ...Array.from({ length: nBands }, (_, i) => bandLabel(i).padStart(9))];
  console.log(header.join(' '));
  for (const d of dists) {
    const row = [d.name.padEnd(20), String(d.total).padStart(7)];
    for (let i = 0; i < nBands; i++) {
      const pct = d.total > 0 ? (d.bandCounts[i] / d.total) * 100 : 0;
      row.push(`${d.bandCounts[i]}(${pct.toFixed(0)}%)`.padStart(9));
    }
    console.log(row.join(' '));
  }
}

async function main() {
  const leagues = discoverLeagues();
  if (!leagues.length) {
    console.error('No league CSVs found in current directory.');
    process.exit(1);
  }
  console.log(`Leagues: ${leagues.map(l => l.name).join(', ')}`);
  console.log('Computing raw modelHockey() confidence distribution per league (no odds, no floors, no staking)...\n');

  const dists: LeagueDistribution[] = [];
  const combined = new Array(BAND_EDGES.length - 1).fill(0);
  let combinedTotal = 0;

  for (const league of leagues) {
    const { total, bandCounts } = computeDistribution(league.csvPath);
    dists.push({ name: league.name, total, bandCounts });
    for (let i = 0; i < combined.length; i++) combined[i] += bandCounts[i];
    combinedTotal += total;
  }

  printTable('-- Per-league confidence distribution --', dists);
  printTable('-- Combined across all leagues --', [{ name: 'ALL LEAGUES', total: combinedTotal, bandCounts: combined }]);

  // Explicit cliff check: what fraction of ALL predictions fall in the
  // 50-55% and 55-60% bands specifically, vs everything 60%+ combined.
  const under55 = combined[0];
  const band55to60 = combined[1];
  const at60plus = combined.slice(2).reduce((s, v) => s + v, 0);
  console.log('\n-- Cliff check --');
  console.log(`50-55% band:  ${under55} (${combinedTotal > 0 ? ((under55/combinedTotal)*100).toFixed(1) : '0'}% of all predictions)`);
  console.log(`55-60% band:  ${band55to60} (${combinedTotal > 0 ? ((band55to60/combinedTotal)*100).toFixed(1) : '0'}% of all predictions)`);
  console.log(`60%+ combined: ${at60plus} (${combinedTotal > 0 ? ((at60plus/combinedTotal)*100).toFixed(1) : '0'}% of all predictions)`);
  console.log('If 50-60% dominates heavily (e.g. >80% of all predictions), the model is rarely');
  console.log('expressing real conviction either way - most games get a near-coinflip score,');
  console.log('and the 55%->60% floor cliff seen in leagueDetailedReport.ts is a direct symptom');
  console.log('of that, not a bug in the backtest script itself.');
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });