import { getDb } from './src/core/database/db';
const db = getDb();
const stats = db.prepare(`SELECT COUNT(*) as n FROM stats WHERE sport = 'basketball'`).get();
const matches = db.prepare(`SELECT COUNT(*) as n FROM matches WHERE sport = 'basketball'`).get();
console.log('basketball matches:', matches);
console.log('basketball stats:', stats);