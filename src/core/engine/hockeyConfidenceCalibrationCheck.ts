// src/core/engine/hockeyConfidenceCalibrationCheck.ts
//
// Checks whether the model's raw confidence number actually means
// what it claims across ALL leagues combined, no floor filter (we
// want the full picture, not just the high end) and no MIN_ODDS
// filter either (calibration should be checked on the full
// population, not a pre-filtered subset).
//
// Two views:
//   1. Simple 5-point buckets (50-55%, 55-60%, ... 95-100%): for each,
//      show how many legs fell in it and what fraction actually won.
//      A well-calibrated model has actual rate ~= bucket midpoint.
//   2. Isotonic regression fit via Pool-Adjacent-Violators (PAVA):
//      the same non-decreasing recalibration technique already used
//      elsewhere in this codebase (corners_totals, corners_winner,
//      team_corners_over, tennis, NBA/WNBA). This produces the
//      actual calibrated-probability table you'd plug in to correct
//      the model's output, not just a diagnostic.
//
// PAVA works on legs sorted by raw confidence ascending: it merges
// adjacent groups whenever a later group's average win rate would be
// LOWER than an earlier group's (which would violate "higher
// confidence should never predict a lower win rate") until the
// entire sequence is non-decreasing. The result is blocks of
// [confidence range] -> [calibrated probability].
//
// Usage: no env vars, league list hardcoded (same as other cross-
// league tests). Run from sports-value-engine directory:
//   npx ts-node src/core/engine/hockeyConfidenceCalibrationCheck.ts
import * as fs from 'fs';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

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

interface Leg { confidence: number; won: boolean; wentToOt: boolean; }

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
        const won = g.wentToOt ? false : (favHome ? g.hs > g.as : g.as > g.hs);
        legs.push({ confidence, won, wentToOt: g.wentToOt });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function isotonicRegression(sortedByConfidence: Leg[]): { startConf: number; endConf: number; count: number; calibratedProb: number }[] {
  // Pool-Adjacent-Violators algorithm. Each pool tracks its confidence
  // range, total wins, and count. Merge backward whenever the new
  // pool's win rate would be lower than the previous pool's.
  type Pool = { startConf: number; endConf: number; count: number; wins: number };
  const pools: Pool[] = [];
  for (const leg of sortedByConfidence) {
    pools.push({ startConf: leg.confidence, endConf: leg.confidence, count: 1, wins: leg.won ? 1 : 0 });
    while (pools.length >= 2) {
      const last = pools[pools.length - 1];
      const prev = pools[pools.length - 2];
      const lastRate = last.wins / last.count;
      const prevRate = prev.wins / prev.count;
      if (lastRate < prevRate) {
        // Violates monotonicity - merge the two pools.
        pools.pop(); pools.pop();
        pools.push({
          startConf: prev.startConf,
          endConf: last.endConf,
          count: prev.count + last.count,
          wins: prev.wins + last.wins,
        });
      } else {
        break;
      }
    }
  }
  return pools.map(p => ({ startConf: p.startConf, endConf: p.endConf, count: p.count, calibratedProb: p.wins / p.count }));
}

function main() {
  console.log('Loading legs from all leagues...');
  const allLegs: Leg[] = [];
  for (const { csv, label } of LEAGUES) {
    if (!fs.existsSync(csv)) { console.log(`  ${label}: SKIPPED (file not found: ${csv})`); continue; }
    const legs = loadLeagueLegs(csv, label);
    console.log(`  ${label}: ${legs.length} candidate legs`);
    allLegs.push(...legs);
  }
  console.log(`\nTotal legs across all leagues (no floor/odds filter): ${allLegs.length}\n`);

  console.log('========== SIMPLE 5-POINT CONFIDENCE BUCKETS ==========');
  const bucketWidth = 0.05;
  const buckets = new Map<number, Leg[]>();
  for (const l of allLegs) {
    const key = Math.floor(l.confidence / bucketWidth) * bucketWidth;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(l);
  }
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const bucketLegs = buckets.get(key)!;
    const wins = bucketLegs.filter(l => l.won).length;
    const actualRate = wins / bucketLegs.length;
    const midpoint = key + bucketWidth / 2;
    const gap = (actualRate - midpoint) * 100;
    console.log(`  ${(key*100).toFixed(0)}-${((key+bucketWidth)*100).toFixed(0)}%: ${bucketLegs.length} legs | actual win rate: ${(actualRate*100).toFixed(1)}% | gap vs stated: ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp`);
  }

  console.log('\n========== ISOTONIC CALIBRATION TABLE (Pool-Adjacent-Violators) ==========');
  console.log('(This is the corrected probability table - use calibratedProb instead of raw confidence when the model falls in a given range)\n');
  const sorted = [...allLegs].sort((a, b) => a.confidence - b.confidence);
  const pools = isotonicRegression(sorted);
  for (const p of pools) {
    console.log(`  raw confidence ${(p.startConf*100).toFixed(1)}%-${(p.endConf*100).toFixed(1)}% (n=${p.count}) -> calibrated probability: ${(p.calibratedProb*100).toFixed(1)}%`);
  }
}

main();