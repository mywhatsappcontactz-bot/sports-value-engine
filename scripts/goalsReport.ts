import 'dotenv/config';
import { getDb } from '../src/core/database/db';
const db = getDb();
const rows = db.prepare(`SELECT targetSelection s, predictedProbability p, hit FROM goals_grading_queue WHERE status='graded'`).all() as any[];
console.log('graded rows:', rows.length);
const groups = new Map<string, any[]>();
for (const r of rows) {
  const b = Math.floor(r.p * 20) / 20;
  const k = `${r.s} | ${(b * 100).toFixed(0)}-${((b + 0.05) * 100).toFixed(0)}%`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}
for (const k of [...groups.keys()].sort()) {
  const g = groups.get(k)!;
  const avgP = g.reduce((a, r) => a + r.p, 0) / g.length;
  const rate = g.reduce((a, r) => a + r.hit, 0) / g.length;
  console.log(k.padEnd(24), 'n=' + String(g.length).padStart(3), 'stated', (avgP * 100).toFixed(1) + '%', 'actual', (rate * 100).toFixed(1) + '%');
}
