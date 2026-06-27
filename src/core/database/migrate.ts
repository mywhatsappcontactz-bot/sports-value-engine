import Database from 'better-sqlite3';
import { logger } from '../utils/logger'; // Use your existing logger

export function runMigrations(db: Database.Database) {
  logger.info('[db] Running schema migrations...');
  
  // These are idempotent because of "IF NOT EXISTS"
  const migrations = [
    `CREATE INDEX IF NOT EXISTS idx_matches_externalId_source ON matches(externalId, source);`,
    `CREATE INDEX IF NOT EXISTS idx_matches_status_startTime ON matches(status, startTime);`,
    `CREATE INDEX IF NOT EXISTS idx_odds_matchId_timestamp ON odds(matchId, timestamp);`
  ];

  try {
    db.transaction(() => {
      for (const sql of migrations) {
        db.prepare(sql).run();
      }
    })();
    logger.info('[db] Migrations applied successfully.');
  } catch (err) {
    logger.error('[db] Migration failed', { error: err });
    throw err; // Stop app startup if migrations fail
  }
}