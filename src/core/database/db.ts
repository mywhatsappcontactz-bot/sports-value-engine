import Database from 'better-sqlite3';
import { initializeSchema } from './schema';
import { logger } from '../utils/logger';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data/sports.db');

function runMigrations(db: Database.Database): void {
  // Migration 001: add sport column to stats if missing (pre-schema stats tables)
  const statsColumns = db
    .prepare(`PRAGMA table_info(stats)`)
    .all() as Array<{ name: string }>;

  const hasSport = statsColumns.some((col) => col.name === 'sport');
  if (!hasSport) {
    logger.info('[DB] Migration: adding sport column to stats table');
    db.exec(`ALTER TABLE stats ADD COLUMN sport TEXT NOT NULL DEFAULT 'football'`);
  }
}

export function getDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');        // was missing — needed for CASCADE deletes
  initializeSchema(db);
  runMigrations(db);
  return db;
}

export function withTransaction<T>(db: Database.Database, fn: () => T): T {
  try {
    db.exec('BEGIN TRANSACTION');
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error: any) {
    db.exec('ROLLBACK');
    logger.error('Transaction failed', { error: error.message });
    throw error;
  }
}