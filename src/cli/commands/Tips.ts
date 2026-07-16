// src/cli/commands/Tips.ts
process.env.CLI_SILENT = 'true';
import { runTipScanner, suggestAccumulators, Tip, SuggestedAccumulator } from '../../core/engine/tipScanner';

function printAccumulatorSuggestions(suggestions: SuggestedAccumulator[]) {
  console.log('\n\x1b[1m\x1b[32m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m\x1b[32m   💰 SUGGESTED ACCUMULATORS (1.80-2.00 target)\x1b[0m');
  console.log('\x1b[1m\x1b[32m' + '═'.repeat(60) + '\x1b[0m\n');

  if (!suggestions.length) {
    console.log('   \x1b[90mNo combo currently lands in the 1.80-2.00 range — check the full list below.\x1b[0m\n');
    return;
  }

  suggestions.forEach((sugg, i) => {
    const priceNote = sugg.usesLivePricesOnly
      ? '\x1b[32m(all live prices)\x1b[0m'
      : '\x1b[33m(includes fair-odds estimate — verify before betting)\x1b[0m';
    console.log(`   \x1b[1mOption ${i + 1}\x1b[0m — Combined odds: \x1b[1m${sugg.combinedOdds}\x1b[0m | Combined confidence: ${(sugg.combinedProbability * 100).toFixed(1)}% ${priceNote}`);
    for (const leg of sugg.legs) {
      const price = leg.localOdds !== null ? `${leg.localOdds} (${leg.localBookmaker})` : `~${leg.impliedFairOdds} (no live price)`;
      console.log(`     • ${leg.homeTeam} vs ${leg.awayTeam} — ${leg.targetSelection} (${leg.targetMarket}) @ ${price} [${leg.confidence}%]`);
    }
    console.log('');
  });
}

function printTips(tips: Tip[]) {
  console.log('\n\x1b[1m\x1b[33m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m\x1b[33m   🎯 TIP SCANNER — HIGH CONFIDENCE PICKS\x1b[0m');
  console.log('\x1b[1m\x1b[33m' + '═'.repeat(60) + '\x1b[0m\n');

  if (!tips.length) {
    console.log('   \x1b[90mNo qualifying tips found. Scan more frequently or wait for better data.\x1b[0m\n');
    return;
  }

  console.log(`   Qualifying picks : \x1b[32m${tips.length}\x1b[0m`);
  console.log(`   Pick your best 3 and build a 1.80-2.00 accumulator\n`);
  console.log('   ' + '─'.repeat(60));

  for (const tip of tips) {
    const kickoff = new Date(tip.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    console.log(`\n   \x1b[36m${tip.homeTeam} vs ${tip.awayTeam}\x1b[0m \x1b[90m(${tip.sport})\x1b[0m`);
    console.log(`   \x1b[90m${tip.league} | KO: ${kickoff} | ${tip.hoursToKickoff}h away\x1b[0m`);
    const priceText = tip.localOdds !== null
      ? `@ \x1b[1m${tip.localOdds}\x1b[0m (${tip.localBookmaker})`
      : `\x1b[90m(no live price — fair odds ~${tip.impliedFairOdds})\x1b[0m`;
    console.log(`   \x1b[32m▶ ${tip.targetSelection}\x1b[0m (${tip.targetMarket}) ${priceText}`);
    console.log(`   Confidence : \x1b[32m${tip.confidence}%\x1b[0m`);
    console.log(`   Pinnacle   : ${tip.pinnacleAvailable ? (tip.pinnacleAgrees ? 'agrees ✓' : 'diverges ⚠') : 'no line available'}`);
    console.log(`   Signal     : \x1b[33m${tip.signal}\x1b[0m`);
    console.log('   ' + '─'.repeat(60));
  }

  console.log('\n\x1b[33m' + '═'.repeat(60) + '\x1b[0m\n');
}

const hoursArg = process.argv[2] ? parseInt(process.argv[2]) : 6;
const tips = runTipScanner(hoursArg);
const suggestions = suggestAccumulators(tips);
printAccumulatorSuggestions(suggestions);
printTips(tips);