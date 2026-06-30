import { getDb } from './src/core/database/db';
const db = getDb();

const bets = db.prepare(`
  SELECT 
    v.id, m.homeTeam, m.awayTeam, m.league, m.startTime,
    v.market, v.selection, v.bookmaker,
    v.bookmakerOdds, v.trueProbability, v.edge, 
    v.kellyStake, v.confidence, v.status
  FROM value_bets v
  JOIN matches m ON m.id = v.matchId
  WHERE v.status = 'pending'
  ORDER BY v.edge DESC
  LIMIT 20
`).all();

console.log(`TOTAL VALUE BETS: ${bets.length}`);
console.log(JSON.stringify(bets, null, 2));