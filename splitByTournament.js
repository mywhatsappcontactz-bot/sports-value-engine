// splitByTournament.js
// Splits a CSV (with a Tournament column like "ICE Hockey League 2024/2025")
// into separate output files, one per distinct league (season suffix
// stripped for grouping, but kept in the data itself).
//
// USAGE:
//   node splitByTournament.js input.csv
//
// Produces one file per league, named after the league (spaces removed),
// e.g. icehl_and_del2_mixed.csv -> "ICEHockeyLeague.csv", "DEL2.csv"

const fs = require('fs');
const path = require('path');

const [,, inputPath] = process.argv;
if (!inputPath) {
  console.error('Usage: node splitByTournament.js <input.csv>');
  process.exit(1);
}

const lines = fs.readFileSync(inputPath, 'utf-8').trim().split(/\r?\n/);
const header = lines[0];
const tIdx = header.split(',').indexOf('Tournament');
if (tIdx === -1) {
  console.error('No Tournament column found in this CSV.');
  process.exit(1);
}

const byLeague = new Map(); // leagueName (season stripped) -> array of data rows

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const cols = line.split(',');
  const tournament = cols[tIdx] || '';
  const leagueName = tournament.replace(/\s+\d{4}\/\d{4}$/, '').trim() || 'UNKNOWN';
  if (!byLeague.has(leagueName)) byLeague.set(leagueName, []);
  byLeague.get(leagueName).push(line);
}

const dir = path.dirname(inputPath);
for (const [league, rows] of byLeague) {
  const safeName = league.replace(/[^a-zA-Z0-9]/g, '');
  const outPath = path.join(dir, `${safeName}_split.csv`);
  fs.writeFileSync(outPath, [header, ...rows].join('\n'), 'utf-8');
  console.log(`${league}: ${rows.length} games -> ${outPath}`);
}