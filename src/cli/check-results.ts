import { getDb } from '../core/database/db';

const db = getDb();
const rows = db.prepare(`
  SELECT betType, homeTeam, awayTeam, selection, odds, result, profitLoss, createdAt
  FROM bet_results
  WHERE result IN ('won', 'lost')
  ORDER BY createdAt DESC
  LIMIT 30
`).all();
console.log(JSON.stringify(rows, null, 2));

const summary = db.prepare(`
  SELECT result, COUNT(*) as count FROM bet_results WHERE result IN ('won','lost') GROUP BY result
`).all();
console.log('SUMMARY:', summary);

const allStatuses = db.prepare(`
  SELECT result, COUNT(*) as count FROM bet_results GROUP BY result
`).all();
console.log('ALL STATUSES (including pending):', allStatuses);