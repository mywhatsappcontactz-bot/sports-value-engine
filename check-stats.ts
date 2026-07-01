import { getDb } from './src/core/database/db';
const db = getDb();
const info = db.prepare(`PRAGMA table_info(stats)`).all();
console.log(JSON.stringify(info, null, 2));
const sample = db.prepare(`SELECT * FROM stats WHERE sport = 'tennis' LIMIT 2`).all();
console.log('sample:', JSON.stringify(sample, null, 2));