import 'dotenv/config';
import { fetchLeagueSchedule, ProballersGame } from '../src/scrapers/basketball/Proballersscraper';

const NEW_LEAGUES = [
  'Liga ABA - Adriatic', 'Superliga - Austria', 'Pro A - Germany', 'A League - Hungary',
  'Extraliga - Slovakia', 'SBL - Switzerland', 'B2 League - Japan', 'VTB United League - Russia',
  'Division A - Romania', 'Express League - Iceland', 'SLB - UK', 'Primera FEB - Spain',
];
const CONTROLS = (process.env.CONTROL_LEAGUES ?? 'ACB - Spain|Betclic Elite - France').split('|').filter(Boolean);
const SEASONS: (number | undefined)[] = [undefined, 2025, 2024, 2023, 2022, 2021];
const MIN_PRIOR = 5, FLOOR = 0.75, HOME_BIAS = 0.075, MIN_H2H = 3, H2H_SEASONS = 2, THIN = 25;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const clamp = (p: number) => Math.max(0.05, Math.min(0.95, p));
const seasonYear = (d: string) => (+d.slice(5, 7) >= 8 ? +d.slice(0, 4) : +d.slice(0, 4) - 1);

interface Rec { sy: number; won: boolean }
interface Meet { sy: number; winner: string }
interface Out { predictable: number; eligible: number; aAll: number[]; aElig: number[]; live: number[] }

function add<T>(m: Map<string, T[]>, k: string, v: T) { if (!m.has(k)) m.set(k, []); m.get(k)!.push(v); }
const flat = (r: Rec[]) => r.filter(x => x.won).length / r.length;
function decay(r: Rec[]) {
  let w = 0, v = 0;
  for (let k = r.length - 1, i = 0; k >= 0; k--, i++) { const t = Math.pow(0.85, i); v += (r[k].won ? 1 : 0) * t; w += t; }
  return v / w;
}

function evaluate(games: ProballersGame[]): Out {
  const seen = new Set<number>();
  const sorted = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true))).sort((a, b) => a.date.localeCompare(b.date));
  const team = new Map<string, Rec[]>();
  const meets = new Map<string, Meet[]>();
  const out: Out = { predictable: 0, eligible: 0, aAll: [], aElig: [], live: [] };
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].date === sorted[i].date) j++;
    const day = sorted.slice(i, j);
    for (const g of day) {
      const hr = team.get(g.homeTeam) ?? [], ar = team.get(g.awayTeam) ?? [];
      if (hr.length < MIN_PRIOR || ar.length < MIN_PRIOR) continue;
      out.predictable++;
      const meet = meets.get([g.homeTeam, g.awayTeam].sort().join('||')) ?? [];
      const homeWon = g.homeScore > g.awayScore;
      const h2hAll = meet.length ? meet.filter(m => m.winner === g.homeTeam).length / meet.length : 0.5;
      const hsA = flat(hr) * 0.6 + h2hAll * 0.4 + HOME_BIAS;
      const asA = flat(ar) * 0.6 + (1 - h2hAll) * 0.4;
      const pA = clamp((hsA / (hsA + asA || 1)) * 0.85 + 0.04);
      const hitA = ((pA >= 0.5) === homeWon) ? 1 : 0;
      const sy = seasonYear(g.date);
      const hCur = hr.filter(r => r.sy === sy), aCur = ar.filter(r => r.sy === sy);
      const meetW = meet.filter(m => m.sy >= sy - H2H_SEASONS);
      const eligible = hCur.length >= MIN_PRIOR && aCur.length >= MIN_PRIOR && meetW.length >= MIN_H2H;
      if (eligible) out.eligible++;
      if (Math.max(pA, 1 - pA) >= FLOOR) { out.aAll.push(hitA); if (eligible) out.aElig.push(hitA); }
      if (eligible) {
        const h2hL = meetW.filter(m => m.winner === g.homeTeam).length / meetW.length;
        const hsL = decay(hCur) * 0.6 + h2hL * 0.4, asL = decay(aCur) * 0.6 + (1 - h2hL) * 0.4;
        const pL = clamp((hsL / (hsL + asL || 1)) * 0.85 + 0.04 + HOME_BIAS);
        if (Math.max(pL, 1 - pL) >= FLOOR) out.live.push(((pL >= 0.5) === homeWon) ? 1 : 0);
      }
    }
    for (const g of day) {
      const sy = seasonYear(g.date), hw = g.homeScore > g.awayScore;
      add(team, g.homeTeam, { sy, won: hw }); add(team, g.awayTeam, { sy, won: !hw });
      add(meets, [g.homeTeam, g.awayTeam].sort().join('||'), { sy, winner: hw ? g.homeTeam : g.awayTeam });
    }
    i = j;
  }
  return out;
}

async function getSeason(l: string, s: number | undefined): Promise<ProballersGame[]> {
  for (let a = 1; a <= 3; a++) {
    try { return await fetchLeagueSchedule(l, s); } catch (e: any) { if (a === 3) throw e; await sleep(5000 * a); }
  }
  return [];
}

const fmt = (h: number[]) => {
  if (!h.length) return 'n=0'.padEnd(18);
  const n = h.length, r = h.reduce((a, b) => a + b, 0) / n;
  return `n=${String(n).padEnd(4)} ${(r * 100).toFixed(1).padStart(5)}%${n < THIN ? ' THIN' : '     '}`;
};

(async () => {
  const lines: string[] = [];
  const flagged: string[] = [];
  for (const [title, list] of [['NEW LEAGUES', NEW_LEAGUES.filter(l => !process.env.ONLY || process.env.ONLY.split('|').includes(l))], ['CONTROL (old leagues)', CONTROLS]] as [string, string[]][]) {
    lines.push(`\n--- ${title} ---`);
    lines.push(`${'league'.padEnd(28)} | ${'ALL'.padEnd(18)} | ${'ELIGIBLE subset'.padEnd(18)} | ${'LIVE-STYLE'.padEnd(18)} | coverage`);
    const pool: Out = { predictable: 0, eligible: 0, aAll: [], aElig: [], live: [] };
    for (const l of list) {
      const games: ProballersGame[] = []; let failed = 0;
      for (const s of SEASONS) { try { games.push(...await getSeason(l, s)); } catch (e: any) { failed++; if (failed === 1) console.log('   first error:', String(e.message).slice(0, 160)); } }
      console.log(`${l}: ${games.length} games, ${failed} season(s) failed`);
      const o = evaluate(games);
      const cov = o.predictable ? (100 * o.eligible / o.predictable).toFixed(0) + '%' : 'n/a';
      lines.push(`${l.padEnd(28)} | ${fmt(o.aAll)} | ${fmt(o.aElig)} | ${fmt(o.live)} | ${cov}${failed ? '  INCOMPLETE DATA (' + failed + ' season(s) failed)' : ''}`);
      const liveRate = o.live.length ? o.live.reduce((a, b) => a + b, 0) / o.live.length : null;
      if (liveRate !== null && o.live.length >= THIN && liveRate < 0.70) flagged.push(`${l} (${(liveRate * 100).toFixed(1)}%, n=${o.live.length})`);
      pool.predictable += o.predictable; pool.eligible += o.eligible;
      pool.aAll.push(...o.aAll); pool.aElig.push(...o.aElig); pool.live.push(...o.live);
    }
    lines.push(`${'POOLED'.padEnd(28)} | ${fmt(pool.aAll)} | ${fmt(pool.aElig)} | ${fmt(pool.live)} | ${pool.predictable ? (100 * pool.eligible / pool.predictable).toFixed(0) + '%' : 'n/a'}`);
  }
  console.log('\n=== RESULTS ===');
  console.log('ALL = backtest formula, every game it can predict. ELIGIBLE = same predictions, only games passing the live filters.');
  console.log('LIVE-STYLE = eligible games only, live-style inputs. coverage = eligible games / predictable games. THIN = fewer than 25 tips.');
  lines.forEach(l => console.log(l));
  console.log(`\nLIVE-STYLE below 70% with n>=${THIN}: ${flagged.join(', ') || 'none'}`);
})();
