import { getDb } from './src/core/database/db';
const db = getDb();
const clv = db.prepare(`PRAGMA table_info(clv_tracking)`).all();
console.log('CLV columns:', JSON.stringify(clv.map((c: any) => c.name)));
const odds = db.prepare(`PRAGMA table_info(odds)`).all();
console.log('odds columns:', JSON.stringify(odds.map((c: any) => c.name)));
const sample = db.prepare(`SELECT * FROM odds LIMIT 3`).all();
console.log('odds sample:', JSON.stringify(sample, null, 2));