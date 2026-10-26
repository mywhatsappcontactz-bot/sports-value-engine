import 'dotenv/config';
import * as fs from 'fs';
import { fetchLeagueSchedule, ProballersGame } from '../src/scrapers/basketball/Proballersscraper';

const LEAGUES = ['Euroleague'];
const SEASONS: (number | undefined)[] = [undefined, 2025, 2024, 2023, 2022, 2021];
const MIN_PRIOR = 5, HCA = 0.075, FLOOR = 0.70;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const src = fs.readFileSync('src/core/engine/probabilityModel.ts', 'utf-8');
const s0 = src.indexOf('const PROBALLERS_ISOTONIC_BLOCKS');
if (s0 < 0) throw new Error('live table not found');
const blocks = [...src.slice(s0, src.indexOf('];', s0)).matchAll(/\{ x: ([0-9.]+), y: ([0-9.]+) \}/g)].map(m => ({ x: +m[1], y: +m[2] }));
if (blocks.length < 20) throw new Error(`parsed only ${blocks.length} blocks`);
console.log(`Live table: ${blocks.length} blocks parsed from probabilityModel.ts`);

function cal(p: number): number {
  if (p <= blocks[0].x) return blocks[0].y;
  if (p >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;
  for (let i = 0; i < blocks.length - 1; i++) if (p >= blocks[i].x && p <= blocks[i + 1].x) {
    const t = (p - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
    return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
  }
  return p;
}

interface Rec { won: boolean }
function wr(r: Rec[]): number {
  if (!r.length) return 0.5;
  let w = 0, v = 0;
  r.forEach((x, i) => { const k = Math.pow(0.85, i); v += (x.won ? 1 : 0) * k; w += k; });
  return v / w;
}

interface Pred { raw: number; cal: number; hit: number }
function predict(games: ProballersGame[]): Pred[] {
  const seen = new Set<number>();
  const sorted = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true))).sort((a, b) => a.date.localeCompare(b.date));
  const out: Pred[] = [];
  for (const g of sorted) {
    const prior = sorted.filter(x => x.date < g.date);
    const hist = new Map<string, { date: string; won: boolean }[]>();
    const push = (t: string, d: string, won: boolean) => { if (!hist.has(t)) hist.set(t, []); hist.get(t)!.push({ date: d, won }); };
    for (const x of prior) { push(x.homeTeam, x.date, x.homeScore > x.awayScore); push(x.awayTeam, x.date, x.awayScore > x.homeScore); }
    const hr = (hist.get(g.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const ar = (hist.get(g.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    if (hr.length < MIN_PRIOR || ar.length < MIN_PRIOR) continue;
    const meet = prior.filter(x => (x.homeTeam === g.homeTeam && x.awayTeam === g.awayTeam) || (x.homeTeam === g.awayTeam && x.awayTeam === g.homeTeam));
    const hw = meet.filter(x => (x.homeTeam === g.homeTeam && x.homeScore > x.awayScore) || (x.awayTeam === g.homeTeam && x.awayScore > x.homeScore)).length;
    const h2h = meet.length ? hw / meet.length : 0.5;
    const homeStr = wr(hr) * 0.6 + h2h * 0.4, awayStr = wr(ar) * 0.6 + (1 - h2h) * 0.4;
    const elo = homeStr / (homeStr + awayStr || 1);
    const ph = Math.max(0.05, Math.min(0.95, elo * 0.85 + 0.04 + HCA));
    const raw = Math.max(ph, 1 - ph);
    out.push({ raw, cal: cal(raw), hit: (ph >= 0.5) === (g.homeScore > g.awayScore) ? 1 : 0 });
  }
  return out;
}

async function getSeason(l: string, s: number | undefined): Promise<ProballersGame[]> {
  for (let a = 1; a <= 3; a++) {
    try { return await fetchLeagueSchedule(l, s); } catch (e: any) { if (a === 3) throw e; await sleep(5000 * a); }
  }
  return [];
}

function row(label: string, p: Pred[], incomplete: boolean) {
  if (!p.length) { console.log(`${label.padEnd(30)} 0 tips`); return; }
  const n = p.length, hit = p.reduce((s, x) => s + x.hit, 0) / n, calAvg = p.reduce((s, x) => s + x.cal, 0) / n;
  const rawAvg = p.reduce((s, x) => s + x.raw, 0) / n, se = 1.96 * Math.sqrt(hit * (1 - hit) / n);
  const gap = (calAvg - hit) * 100;
  console.log(`${label.padEnd(30)} n=${String(n).padEnd(5)} raw=${(rawAvg * 100).toFixed(1)}% cal=${(calAvg * 100).toFixed(1)}% actual=${(hit * 100).toFixed(1)}% (+-${(se * 100).toFixed(1)})  gap=${gap >= 0 ? '+' : ''}${gap.toFixed(1)}${incomplete ? '  [INCOMPLETE DATA]' : ''}`);
}

(async () => {
  const all: Pred[] = [];
  const summary: { l: string; p: Pred[]; bad: boolean }[] = [];
  for (const l of LEAGUES) {
    const games: ProballersGame[] = []; let failed = 0;
    for (const s of SEASONS) { try { games.push(...await getSeason(l, s)); } catch { failed++; } }
    const p = predict(games);
    console.log(`${l}: ${games.length} games, ${failed} season(s) failed, ${p.length} predictions`);
    summary.push({ l, p, bad: failed > 0 }); all.push(...p);
  }
  console.log('\nGap = average calibrated probability minus actual hit rate. Positive = engine overstates (too confident).');
  console.log('\n=== A: tips with RAW confidence >= 0.75 ===');
  for (const s of summary) row(s.l, s.p.filter(x => x.raw >= FLOOR), s.bad);
  row('ALL NEW LEAGUES', all.filter(x => x.raw >= FLOOR), summary.some(s => s.bad));
  console.log('\n=== B: tips with CALIBRATED confidence >= 0.75 ===');
  for (const s of summary) row(s.l, s.p.filter(x => x.cal >= FLOOR), s.bad);
  row('ALL NEW LEAGUES', all.filter(x => x.cal >= FLOOR), summary.some(s => s.bad));
})();
