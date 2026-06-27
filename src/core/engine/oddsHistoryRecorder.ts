import { Repository } from '../database/repository';
import { getDb } from '../database/db';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../utils/logger';

const db = getDb();

export function recordOddsSnapshot(): void {
  const pinnacleOdds = db.prepare(`
    SELECT o.id, o.matchId, o.bookmaker, o.market, o.selection, o.odds, o.impliedProbability, o.timestamp
    FROM odds o
    JOIN matches m ON o.matchId = m.id
    WHERE o.bookmaker = 'Pinnacle'
    AND m.status = 'upcoming'
  `).all() as any[];

  if (!pinnacleOdds.length) {
    logger.info('[OddsHistory] No Pinnacle odds to record');
    return;
  }

  const insert = db.prepare(`
    INSERT INTO odds_history (id, matchId, bookmaker, market, selection, odds, impliedProbability, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((rows: any[]) => {
    for (const row of rows) {
      insert.run(
        uuidv4(),
        row.matchId,
        row.bookmaker,
        row.market,
        row.selection,
        row.odds,
        row.impliedProbability,
        new Date().toISOString()
      );
    }
  });

  insertMany(pinnacleOdds);
  logger.info(`[OddsHistory] Recorded ${pinnacleOdds.length} Pinnacle odds snapshots`);
}