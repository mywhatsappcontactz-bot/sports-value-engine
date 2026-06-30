import { getDb } from './src/core/database/db';
const db = getDb();

// Check actual columns first
const cols = db.prepare(`PRAGMA table_info(value_bets)`).all();
console.log('value_bets columns:', JSON.stringify(cols.map((c: any) => c.name)));

const matchCols = db.prepare(`PRAGMA table_info(matches)`).all();
console.log('matches columns:', JSON.stringify(matchCols.map((c: any) => c.name)));