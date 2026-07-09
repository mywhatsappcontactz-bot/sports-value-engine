import { getDb } from './src/core/database/db';
const db = getDb();

// Check stats for matches that passed validation
const stats = db.prepare(`
  SELECT s.id, m.homeTeam, m.awayTeam, m.league, 
         s.confidenceFactors, s.h2h, s.homeForm, s.awayForm
  FROM stats s
  JOIN matches m ON m.id = s.matchId
  ORDER BY s.createdAt DESC
  LIMIT 3
`).all();

for (const s of stats as any[]) {
  console.log(`\n${s.homeTeam} vs ${s.awayTeam}`);
  const cf = JSON.parse(s.confidenceFactors);
  const h2h = JSON.parse(s.h2h);
  const hf = JSON.parse(s.homeForm);
  const af = JSON.parse(s.awayForm);
  console.log('Confidence factors:', JSON.stringify(cf));
  console.log('H2H count:', h2h.length);
  console.log('Home form:', hf.length, 'games');
  console.log('Away form:', af.length, 'games');
}