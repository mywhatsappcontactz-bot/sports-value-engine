import { getDb } from './src/core/database/db';
const db = getDb();

// Stats saved today
const stats = db.prepare(`
  SELECT s.id, m.homeTeam, m.awayTeam, m.league, s.updatedAt
  FROM stats s
  JOIN matches m ON m.id = s.matchId
  ORDER BY s.updatedAt DESC
  LIMIT 10
`).all();
console.log('RECENT STATS:', JSON.stringify(stats, null, 2));

// Value bets for those same matches
const bets = db.prepare(`
  SELECT v.market, v.edge, v.confidence, v.status, m.homeTeam, m.awayTeam
  FROM value_bets v
  JOIN matches m ON m.id = v.matchId
  ORDER BY v.createdAt DESC
  LIMIT 20
`).all();
console.log('ALL BETS:', JSON.stringify(bets, null, 2));