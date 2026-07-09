import { getDb } from './src/core/database/db';
const db = getDb();
const odds = db.prepare(`
  SELECT m.homeTeam, m.awayTeam, o.bookmaker, o.market, o.selection, o.odds, o.impliedProbability
  FROM odds o
  JOIN matches m ON m.id = o.matchId
  WHERE m.homeTeam IN ('Hammarby IF', 'Malmo FF', 'Rosenborg', 'Aalesund')
  ORDER BY m.homeTeam, o.bookmaker
`).all();
console.log(JSON.stringify(odds, null, 2));