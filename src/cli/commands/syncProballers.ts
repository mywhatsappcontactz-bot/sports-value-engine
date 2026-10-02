// src/cli/commands/syncProballers.ts
//
// Runnable entry point for proballersFixturesSync.ts's
// syncAllProballersFixtures() — none existed before this (the sync file
// only exported functions, no `require.main === module` runner block
// like scrape.ts has for football).
//
// This is STEP 1 of getting real Proballers tips: it pulls upcoming
// fixtures + builds/saves stats for the 20 approved leagues (see
// EXCLUDED_LEAGUES in proballersFixturesSync.ts). Once this has run and
// saved real stats, whatever command already runs runTipScanner() for
// your other sports (football/WNBA/etc.) will pick up Proballers
// matches automatically — tipScanner.ts is sport-agnostic, it just reads
// whatever's in the matches/stats tables.
//
// Run with: npx ts-node src/cli/commands/syncProballers.ts

import { syncAllProballersFixtures } from '../../data-bridge/proballersFixturesSync';

async function main() {
  console.log('Syncing Proballers fixtures (20 approved leagues)...\n');
  console.log('NOTE: leagues currently between seasons will correctly sync 0 usable');
  console.log('stats rows (real fixtures found, but rejected by the validator for');
  console.log('insufficient current-season form) — that\'s expected, not an error,');
  console.log('until each league\'s season actually starts.\n');

  const results = await syncAllProballersFixtures();

  console.log('\n=== Per-league results ===');
  for (const r of results) {
    console.log(
      `  ${r.league.padEnd(30)} fixtures=${String(r.fixturesFound).padEnd(4)} ` +
      `created=${String(r.matchesCreated).padEnd(4)} reused=${String(r.matchesReused).padEnd(4)} ` +
      `saved=${String(r.statsSaved).padEnd(4)} rejected=${String(r.statsRejected).padEnd(4)} ` +
      `errors=${r.errors}`
    );
  }

  const totalSaved = results.reduce((s, r) => s + r.statsSaved, 0);
  console.log(`\nTotal stats rows saved across all leagues: ${totalSaved}`);
  if (totalSaved === 0) {
    console.log('0 saved likely means every league is still between seasons — this is');
    console.log('expected right now (2026-08), not a bug. Re-run this once real games');
    console.log('start being played.');
  } else {
    console.log(`${totalSaved} match(es) now have real stats saved — run your usual tip`);
    console.log('scanner command next to generate actual tips from them.');
  }
}

main().catch(err => {
  console.error('[SyncProballers] Fatal error:', err.message);
  process.exit(1);
});