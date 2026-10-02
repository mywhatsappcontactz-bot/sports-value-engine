// src/core/engine/hockeyDrawCalibrationCheck.ts
//
// SANITY CHECK before building a real 3-way model: is the bookmaker's
// Draw price already accurate, or is there a gap between what the
// market implies and what actually happens?
//
// For every game: devig the 3-way odds into a fair Draw probability
// (see hockey3WaySingleLeagueTest.ts for the devig method), then
// compare:
//   - overall actual draw rate (OT/Pen games / total games)
//   - overall average market-implied fair draw probability
// and also break this down into probability buckets (e.g. games
// where the market says ~20-25% draw chance - did ~20-25% of THOSE
// actually go to a draw?). A flat market is well-calibrated bucket by
// bucket; a real edge would show up as buckets where actual rate is
// consistently higher than implied rate.
//
// This does NOT place any bets or compute ROI - it only checks
// whether the market's draw pricing is accurate. If it's accurate,
// there's no free edge in backing Draw and a 3-way model isn't worth
// building for this purpose. If there's a consistent gap, that's the
// signal worth building a real model to exploit.
//
// Usage:
//   $env:LEAGUE_CSV="C:\...\nhl_3way.csv"
//   $env:LEAGUE_LABEL="NHL"
//   npx ts-node src/core/engine/hockeyDrawCalibrationCheck.ts
import * as fs from 'fs';

const LEAGUE_CSV = process.env.LEAGUE_CSV;
const LEAGUE_LABEL = process.env.LEAGUE_LABEL || 'League';

if (!LEAGUE_CSV) {
  console.error('Set $env:LEAGUE_CSV to the CSV path, and optionally $env:LEAGUE_LABEL to a display name.');
  process.exit(1);
}

function parseCsvGeneric(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
}

interface Game { actualDraw: boolean; fairDrawProb: number; drawOdds: number; }

function loadGames(csvPath: string): Game[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { status: col('Status'), ho: col('Home_Odds'), draw: col('Draw_Odds'), ao: col('Away_Odds') };

  if (idx.draw === -1) {
    console.error('This CSV has no Draw_Odds column - re-run parseOddsPortalAcb.js (v10) on the raw .txt first.');
    process.exit(1);
  }

  const games: Game[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const status = r[idx.status]?.trim();
    if (status !== 'Finished' && status !== 'After OT' && status !== 'After Pen.') continue;

    const ho = parseFloat(r[idx.ho]), drawOdds = parseFloat(r[idx.draw]), ao = parseFloat(r[idx.ao]);
    if (isNaN(ho) || isNaN(drawOdds) || isNaN(ao)) continue;

    const rawHome = 1 / ho, rawDraw = 1 / drawOdds, rawAway = 1 / ao;
    const overround = rawHome + rawDraw + rawAway;
    const fairDrawProb = rawDraw / overround;

    const actualDraw = status === 'After OT' || status === 'After Pen.';
    games.push({ actualDraw, fairDrawProb, drawOdds });
  }
  return games;
}

function main() {
  const games = loadGames(LEAGUE_CSV!);
  if (!games.length) { console.log('No games with full 3-way odds found.'); return; }

  const actualDraws = games.filter(g => g.actualDraw).length;
  const actualRate = actualDraws / games.length;
  const avgImplied = games.reduce((s, g) => s + g.fairDrawProb, 0) / games.length;

  console.log(`${LEAGUE_LABEL}: ${games.length} games with full 3-way odds\n`);
  console.log(`OVERALL:`);
  console.log(`  Actual draw (OT/shootout) rate: ${(actualRate * 100).toFixed(1)}% (${actualDraws}/${games.length})`);
  console.log(`  Average market-implied fair draw probability: ${(avgImplied * 100).toFixed(1)}%`);
  console.log(`  Gap (actual - implied): ${((actualRate - avgImplied) * 100).toFixed(1)} percentage points`);
  console.log(`  ${actualRate > avgImplied ? '-> Market UNDER-prices draws (potential value backing Draw)' : actualRate < avgImplied ? '-> Market OVER-prices draws (Draw is a bad bet, priced too short)' : '-> Market looks accurate on average'}\n`);

  // Bucket by implied draw probability into 5-point-wide bands, so we
  // can see if the gap is concentrated in specific price ranges
  // rather than uniform (a real, exploitable signal usually only
  // shows up in certain bands, not everywhere).
  const bucketWidth = 0.05;
  const buckets = new Map<number, Game[]>();
  for (const g of games) {
    const bucketKey = Math.floor(g.fairDrawProb / bucketWidth) * bucketWidth;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey)!.push(g);
  }

  console.log(`BY IMPLIED DRAW PROBABILITY BUCKET (bucket needs 20+ games to be meaningful):`);
  const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
  for (const key of sortedKeys) {
    const bucketGames = buckets.get(key)!;
    const bucketActual = bucketGames.filter(g => g.actualDraw).length / bucketGames.length;
    const bucketImplied = bucketGames.reduce((s, g) => s + g.fairDrawProb, 0) / bucketGames.length;
    const gap = (bucketActual - bucketImplied) * 100;
    const flag = bucketGames.length >= 20 ? (Math.abs(gap) >= 3 ? (gap > 0 ? '  <-- UNDER-priced' : '  <-- OVER-priced') : '') : '  (sample too small)';
    console.log(`  ${(key * 100).toFixed(0)}-${((key + bucketWidth) * 100).toFixed(0)}%: ${bucketGames.length} games | actual ${(bucketActual * 100).toFixed(1)}% | implied ${(bucketImplied * 100).toFixed(1)}% | gap ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp${flag}`);
  }
}

main();