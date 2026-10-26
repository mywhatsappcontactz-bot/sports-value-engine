// scripts/testProballersSyncOneLeague.ts
//
// Dry run: syncs just ONE Proballers league (ACB - Spain) through the
// real syncOneLeague() pipeline, so any problem with the Cleaner/
// Validator handling of this new data source (flagged UNVERIFIED in
// proballersFixturesSync.ts's own header) fails small and visible,
// rather than discovering it mid-way through all 20 leagues at once.
//
// Run with: npx ts-node scripts/testProballersSyncOneLeague.ts

import { syncOneLeague } from '../src/data-bridge/proballersFixturesSync';

async function main() {
  const leagueName = process.argv[2] ?? 'ACB - Spain';
  console.log(`Dry-run syncing ONE league: ${leagueName}\n`);

  const result = await syncOneLeague(leagueName);

  console.log('\n=== Result ===');
  console.log(result);

  console.log('\n=== What to check ===');
  console.log('- fixturesFound: did it find real upcoming ACB fixtures? (0 is suspicious if ACB is in-season)');
  console.log('- statsSaved vs statsRejected: if rejected > 0, check the [ProballersFixturesSync] warn logs above for why (cleanStats returned null / validation failed)');
  console.log('- errors: should be 0 — any errors mean something broke mid-fixture, check the error logs above');
  console.log('\nIf this looks healthy, safe to run syncAllProballersFixtures() for all 20 leagues next.');
}

main().catch(err => {
  console.error('[TestProballersSyncOneLeague] Fatal error:', err.message);
  process.exit(1);
});