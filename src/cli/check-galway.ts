import { getDb } from '../core/database/db';

const db = getDb();
const match = db.prepare(`
  SELECT id, homeTeam, awayTeam FROM matches
  WHERE homeTeam LIKE '%Galway%' AND awayTeam LIKE '%Sligo%'
  ORDER BY startTime DESC LIMIT 1
`).get() as any;

if (!match) {
  console.log('Match not found in DB');
} else {
  console.log('Match:', match);
  const stats = db.prepare(`SELECT * FROM stats WHERE matchId = ?`).get(match.id);
  console.log(JSON.stringify(stats, null, 2));
}