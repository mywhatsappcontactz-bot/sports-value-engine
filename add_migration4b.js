const fs = require("fs");
const p = "src/core/database/db.ts";
let s = fs.readFileSync(p, "utf8");

if (s.includes("Migration 004")) { console.log("Already applied."); process.exit(0); }

const lines = s.split(/\r?\n/);
const startIdx = lines.findIndex(l => l.includes("function runMigrations"));
console.log("runMigrations starts at line:", startIdx);
if (startIdx === -1) { console.log("ABORT: function not found."); process.exit(1); }

// find the closing brace of the function - first line that is just "}"
// at the same indentation level, searching from the start
let endIdx = -1;
for (let i = startIdx + 1; i < lines.length; i++) {
  if (lines[i] === "}") { endIdx = i; break; }
}
console.log("runMigrations ends at line:", endIdx);
if (endIdx === -1) { console.log("ABORT: closing brace not found."); process.exit(1); }

console.log("Last 5 lines before closing brace:");
for (let i = endIdx - 5; i < endIdx; i++) console.log("  " + lines[i]);

const migration4Lines = [
  "",
  "  // Migration 004: add cards/SOT columns to stats if missing.",
  "  // Same root cause as Migration 002/003 - schema.ts had these columns",
  "  // all along, but CREATE TABLE IF NOT EXISTS never alters an existing",
  "  // table. Confirmed missing via a real scrape.ts run (error: \"no such",
  "  // column: homeCardsAvg\") on every match's cards/SOT aggregation step.",
  "  const hasHomeCards = statsColumns.some((col) => col.name === 'homeCardsAvg');",
  "  if (!hasHomeCards) {",
  "    logger.info('[DB] Migration: adding homeCardsAvg column to stats table');",
  "    db.exec(`ALTER TABLE stats ADD COLUMN homeCardsAvg REAL`);",
  "  }",
  "",
  "  const hasAwayCards = statsColumns.some((col) => col.name === 'awayCardsAvg');",
  "  if (!hasAwayCards) {",
  "    logger.info('[DB] Migration: adding awayCardsAvg column to stats table');",
  "    db.exec(`ALTER TABLE stats ADD COLUMN awayCardsAvg REAL`);",
  "  }",
  "",
  "  const hasHomeSot = statsColumns.some((col) => col.name === 'homeSotAvg');",
  "  if (!hasHomeSot) {",
  "    logger.info('[DB] Migration: adding homeSotAvg column to stats table');",
  "    db.exec(`ALTER TABLE stats ADD COLUMN homeSotAvg REAL`);",
  "  }",
  "",
  "  const hasAwaySot = statsColumns.some((col) => col.name === 'awaySotAvg');",
  "  if (!hasAwaySot) {",
  "    logger.info('[DB] Migration: adding awaySotAvg column to stats table');",
  "    db.exec(`ALTER TABLE stats ADD COLUMN awaySotAvg REAL`);",
  "  }",
];

lines.splice(endIdx, 0, ...migration4Lines);

const usesCRLF = s.includes("\r\n");
fs.writeFileSync(p, lines.join(usesCRLF ? "\r\n" : "\n"), "utf8");
console.log("Success: Migration 004 inserted before closing brace at (old) line " + endIdx);
