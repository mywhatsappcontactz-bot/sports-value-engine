process.env.CLI_SILENT = 'true';

import { syncAllBasketballFixtures } from '../../data-bridge/basketballFixturesSync';
import { syncAllProballersFixtures } from '../../data-bridge/proballersFixturesSync';
import { runTipScanner, Tip } from '../../core/engine/tipScanner';
import { logger } from '../../core/utils/logger';

function printTips(tips: Tip[]) {
  console.log('\n' + '═'.repeat(60));
  console.log('   🏀 BASKETBALL TIPS — HIGH CONFIDENCE PICKS');
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
  logger.info('[TipsBasketballOnly] Syncing basketball fixtures (NBA + WNBA, free)...');
  const basketballResults = await syncAllBasketballFixtures(168);
  const totalBasketballSynced = basketballResults.reduce((s, r) => s + r.matchesCreated + r.matchesReused, 0);
  logger.info(`[TipsBasketballOnly] Basketball sync complete — ${totalBasketballSynced} matches synced across ${basketballResults.length} leagues.`);

  logger.info('[TipsBasketballOnly] Syncing Proballers fixtures (19 international leagues, free)...');
  const proballersResults = await syncAllProballersFixtures();
  const totalProballersSynced = proballersResults.reduce((s, r) => s + r.matchesCreated + r.matchesReused, 0);
  logger.info(`[TipsBasketballOnly] Proballers sync complete — ${totalProballersSynced} matches synced across ${proballersResults.length} leagues.`);

  logger.info('[TipsBasketballOnly] Running tip scanner...');
  const allTips = runTipScanner(28);
  const basketballTips = allTips.filter(t => t.sport === 'basketball');
  printTips(basketballTips);
  logger.info(`[TipsBasketballOnly] Complete — ${basketballTips.length} basketball tips found.`);
}

main().catch(err => {
  logger.error('[TipsBasketballOnly] Fatal error', { error: err.message });
  process.exit(1);
});