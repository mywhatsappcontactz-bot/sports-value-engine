import { getDb } from './src/core/database/db';
const db = getDb();
const teams = db.prepare(`
  SELECT DISTINCT homeTeam, awayTeam FROM matches 
  WHERE sport = 'basketball' AND league = 'WNBA'
  ORDER BY homeTeam
`).all();
console.log(JSON.stringify(teams, null, 2));