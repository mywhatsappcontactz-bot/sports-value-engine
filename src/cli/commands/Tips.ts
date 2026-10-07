// src/cli/commands/Tips.ts
process.env.CLI_SILENT = 'true';

import { syncAllFallbackLeagues } from '../../data-bridge/soccerStatsFallbackFixturesSync';
import { syncAllConfiguredLeagues } from '../../data-bridge/soccerStatsFixturesSync';
import { syncAllBasketballFixtures } from '../../data-bridge/basketballFixturesSync';
import { runTipScanner, Tip } from '../../core/engine/tipScanner';
import { logger } from '../../core/utils/logger';
import { syncAllProballersFixtures } from '../../data-bridge/proballersFixturesSync';
import { syncNflFixtures } from '../../data-bridge/nflFixturesSync';
import { syncAllEliteProspectsFixtures } from '../../data-bridge/eliteProspectsFixturesSync';
import { notifyTips } from '../../core/utils/telegramNotifier';

function printTips(tips: Tip[]) {
  console.log('\n' + '═'.repeat(60));
  console.log('   🎯 TIP SCANNER — HIGH CONFIDENCE PICKS');
  console.log('═'.repeat(60) + '\n');

  if (!tips.length) {
    console.log('   No qualifying tips found.\n');
    return;
  }

  for (const tip of tips) {
    const kickoff = new Date(tip.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    console.log(`\n   ${tip.homeTeam} vs ${tip.awayTeam} (${tip.sport})`);
    console.log(`   ${tip.league} | KO: ${kickoff} | ${tip.hoursToKickoff}h away`);
    const priceText = tip.localOdds !== null
      ? `@ ${tip.localOdds} (${tip.localBookmaker})`
      : `(no live price — fair odds ~${tip.impliedFairOdds})`;
    console.log(`   ▶ ${tip.targetSelection} (${tip.targetMarket}) ${priceText}`);
    if (tip.targetMarket === 'team_points_expected') {
    console.log('   Expected   : unvalidated, no line (no confidence figure)');
  } else {
    console.log(`   Confidence : ${tip.confidence}%`);
  }
    console.log(`   Signal     : ${tip.signal}`);
    console.log('   ' + '─'.repeat(60));
  }
  console.log('\n' + '═'.repeat(60) + '\n');
}

async function main() {
  // soccerstats.com is currently Cloudflare Turnstile-blocked (migration
  // to Camoufox in progress, see [[sports-value-engine]] notes) — wrapped
  // individually so a failure here doesn't stop basketball/Proballers
  // from syncing and the tip scanner from still running on whatever
  // fixtures ARE available. Football tips will simply be absent until
  // soccerstats is unblocked; nothing else should be held hostage by it.
  try {
    logger.info('[TipsOnlyScan] Syncing fallback fixtures (24 leagues)...');
    await syncAllFallbackLeagues();
  } catch (err: any) {
    logger.warn('[TipsOnlyScan] Fallback fixtures sync failed — skipping, other sources continue', { error: err.message });
  }

  try {
    logger.info('[TipsOnlyScan] Syncing soccerstats fixtures (6 gap leagues)...');
    await syncAllConfiguredLeagues();
  } catch (err: any) {
    logger.warn('[TipsOnlyScan] Soccerstats fixtures sync failed — skipping, other sources continue', { error: err.message });
  }

  // Free basketball path (NBA + WNBA) — never touches the paid odds API.
  // Dedupes against any existing paid-sourced match rows internally (see
  // basketballFixturesSync.ts header comment) so this is safe to run
  // even on days Scan.ts also ran for basketball.
  logger.info('[TipsOnlyScan] Syncing basketball fixtures (NBA + WNBA, free)...');
  const basketballResults = await syncAllBasketballFixtures(168);
  const totalBasketballSynced = basketballResults.reduce((s, r) => s + r.matchesCreated + r.matchesReused, 0);
  logger.info(`[TipsOnlyScan] Basketball sync complete — ${totalBasketballSynced} matches synced across ${basketballResults.length} leagues.`);

  logger.info('[TipsOnlyScan] Syncing Proballers fixtures (19 international leagues, free)...');
  const proballersResults = await syncAllProballersFixtures();
  const totalProballersSynced = proballersResults.reduce((s, r) => s + r.matchesCreated + r.matchesReused, 0);
  logger.info(`[TipsOnlyScan] Proballers sync complete — ${totalProballersSynced} matches synced across ${proballersResults.length} leagues.`);

  // Hockey (EliteProspects) — free, self-contained sync: unlike football's
  // split fixtures/stats architecture, syncAllEliteProspectsFixtures()
  // writes BOTH matches and stats (homeForm/awayForm/h2h via
  // eliteProspectsStatsToRawStats, called internally inside syncOneLeague)
  // in one pass — confirmed by reading the source directly, not assumed.
  // Wrapped the same defensive way as every other source above — a
  // hockey sync failure must not block football/basketball/Proballers/NFL
  // tips from still running.
  try {
    logger.info('[TipsOnlyScan] Syncing hockey fixtures (EliteProspects, free)...');
    const hockeyResults = await syncAllEliteProspectsFixtures();
    const totalHockeySynced = hockeyResults.reduce((s, r) => s + r.matchesCreated + r.matchesReused, 0);
    logger.info(`[TipsOnlyScan] Hockey sync complete — ${totalHockeySynced} matches synced across ${hockeyResults.length} leagues.`);
  } catch (err: any) {
    logger.warn('[TipsOnlyScan] Hockey fixtures sync failed — skipping, other sources continue', { error: err.message });
  }

  logger.info('[TipsOnlyScan] Syncing NFL fixtures (free ESPN API)...');
  const nflResult = await syncNflFixtures();
  logger.info(`[TipsOnlyScan] NFL sync complete — ${nflResult.matchesCreated + nflResult.matchesReused} matches synced, ${nflResult.statsSaved} stats saved, ${nflResult.insufficientHistory} skipped (not enough history yet).`);

  logger.info('[TipsOnlyScan] Running tip scanner...');
  const tips = runTipScanner(24);
  printTips(tips);
  await notifyTips(tips);
  logger.info(`[TipsOnlyScan] Complete — ${tips.length} tips found.`);
}

main().catch(err => {
  logger.error('[TipsOnlyScan] Fatal error', { error: err.message });
  process.exit(1);
});