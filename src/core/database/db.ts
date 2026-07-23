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

  // Migration 002: add homeGoalsAvg/awayGoalsAvg if missing.
  // FIXED: these were already present in schema.ts's CREATE TABLE statement
  // when corners work began, which wrongly suggested they were already live —
  // but CREATE TABLE IF NOT EXISTS never alters an existing table, so if the
  // live DB predates these two columns being added to schema.ts, they were
  // never actually created. Confirmed missing via a real test run
  // (SqliteError: table stats has no column named homeGoalsAvg).
  const hasHomeGoalsAvg = statsColumns.some((col) => col.name === 'homeGoalsAvg');
  if (!hasHomeGoalsAvg) {
    logger.info('[DB] Migration: adding homeGoalsAvg column to stats table');
    db.exec(`ALTER TABLE stats ADD COLUMN homeGoalsAvg REAL`);
  }

  const hasAwayGoalsAvg = statsColumns.some((col) => col.name === 'awayGoalsAvg');
  if (!hasAwayGoalsAvg) {
    logger.info('[DB] Migration: adding awayGoalsAvg column to stats table');
    db.exec(`ALTER TABLE stats ADD COLUMN awayGoalsAvg REAL`);
  }

  // Migration 003: add corners columns to stats if missing
  const hasHomeCorners = statsColumns.some((col) => col.name === 'homeCornersAvg');
  if (!hasHomeCorners) {
    logger.info('[DB] Migration: adding homeCornersAvg column to stats table');
    db.exec(`ALTER TABLE stats ADD COLUMN homeCornersAvg REAL`);
  }

  const hasAwayCorners = statsColumns.some((col) => col.name === 'awayCornersAvg');
  if (!hasAwayCorners) {
    logger.info('[DB] Migration: adding awayCornersAvg column to stats table');
    db.exec(`ALTER TABLE stats ADD COLUMN awayCornersAvg REAL`);
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