import 'dotenv/config';
import { getDb } from '../src/core/database/db';
const rows = getDb().prepare(`SELECT market, predictedProbability p, hit FROM basketball_grading_queue WHERE status='graded'`).all() as any[];
console.log('graded rows:', rows.length);
const g = new Map<string, any[]>();
for (const r of rows) { const b = Math.floor(r.p * 10) * 10; const k = `${r.market} ${b}-${b + 10}%`; if (!g.has(k)) g.set(k, []); g.get(k)!.push(r); }
for (const k of [...g.keys()].sort()) {
  const x = g.get(k)!;
  console.log(k.padEnd(30), 'n=' + String(x.length).padStart(3), 'stated', (100 * x.reduce((a, r) => a + r.p, 0) / x.length).toFixed(1) + '%', 'actual', (100 * x.reduce((a, r) => a + r.hit, 0) / x.length).toFixed(1) + '%');
}
