const fs = require("fs");
const p = "src/core/database/db.ts";
let s = fs.readFileSync(p, "utf8");

if (s.includes("Migration 004")) { console.log("Already applied."); process.exit(0); }

const anchor = `  const hasAwayCorners = statsColumns.some((col) => col.name === 'awayCornersAvg');
  if (!hasAwayCorners) {
    logger.info('[DB] Migration: adding awayCornersAvg column to stats table');
    db.exec(\`ALTER TABLE stats ADD COLUMN awayCornersAvg REAL\`);
  }
}`;

const idx = s.indexOf(anchor);
console.log("Anchor found at index:", idx);
if (idx === -1) { console.log("ABORT: anchor not found. Nothing changed."); process.exit(1); }

const migration4 = `  const hasAwayCorners = statsColumns.some((col) => col.name === 'awayCornersAvg');
  if (!hasAwayCorners) {
    logger.info('[DB] Migration: adding awayCornersAvg column to stats table');
    db.exec(\`ALTER TABLE stats ADD COLUMN awayCornersAvg REAL\`);
  }

  // Migration 004: add cards/SOT columns to stats if missing.
  // Same root cause as Migration 002/003 - schema.ts had these columns
  // all along, but CREATE TABLE IF NOT EXISTS never alters an existing
  // table. Confirmed missing via a real scrape.ts run (error: "no such
  // column: homeCardsAvg") on every match's cards/SOT aggregation step.
  const hasHomeCards = statsColumns.some((col) => col.name === 'homeCardsAvg');
  if (!hasHomeCards) {
    logger.info('[DB] Migration: adding homeCardsAvg column to stats table');
    db.exec(\`ALTER TABLE stats ADD COLUMN homeCardsAvg REAL\`);
  }

  const hasAwayCards = statsColumns.some((col) => col.name === 'awayCardsAvg');
  if (!hasAwayCards) {
    logger.info('[DB] Migration: adding awayCardsAvg column to stats table');
    db.exec(\`ALTER TABLE stats ADD COLUMN awayCardsAvg REAL\`);
  }

  const hasHomeSot = statsColumns.some((col) => col.name === 'homeSotAvg');
  if (!hasHomeSot) {
    logger.info('[DB] Migration: adding homeSotAvg column to stats table');
    db.exec(\`ALTER TABLE stats ADD COLUMN homeSotAvg REAL\`);
  }

  const hasAwaySot = statsColumns.some((col) => col.name === 'awaySotAvg');
  if (!hasAwaySot) {
    logger.info('[DB] Migration: adding awaySotAvg column to stats table');
    db.exec(\`ALTER TABLE stats ADD COLUMN awaySotAvg REAL\`);
  }
}`;

s = s.replace(anchor, migration4);
fs.writeFileSync(p, s, "utf8");
console.log("Success: Migration 004 added.");
