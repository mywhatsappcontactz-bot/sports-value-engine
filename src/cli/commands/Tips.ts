// src/cli/commands/Tips.ts
process.env.CLI_SILENT = 'true';
import { runTipScanner, Tip } from '../../core/engine/tipScanner';

function printTips(tips: Tip[]) {
  console.log('\n\x1b[1m\x1b[33m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m\x1b[33m   🎯 TIP SCANNER — HIGH CONFIDENCE PICKS\x1b[0m');
  console.log('\x1b[1m\x1b[33m' + '═'.repeat(60) + '\x1b[0m\n');

  if (!tips.length) {
    console.log('   \x1b[90mNo qualifying tips found. Scan more frequently or wait for line movement.\x1b[0m\n');
    return;
  }

  console.log(`   Qualifying picks : \x1b[32m${tips.length}\x1b[0m`);
  console.log(`   Pick your best 3 and build a 1.80-2.00 accumulator\n`);
  console.log('   ' + '─'.repeat(60));

  for (const tip of tips) {
    const kickoff = new Date(tip.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    console.log(`\n   \x1b[36m${tip.homeTeam} vs ${tip.awayTeam}\x1b[0m`);
    console.log(`   \x1b[90m${tip.league} | KO: ${kickoff} | ${tip.hoursToKickoff}h away\x1b[0m`);
    console.log(`   \x1b[32m▶ ${tip.targetSelection}\x1b[0m @ \x1b[1m${tip.localOdds}\x1b[0m (${tip.localBookmaker})`);
    console.log(`   Confidence : \x1b[32m${tip.confidence}%\x1b[0m`);
    console.log(`   Pinnacle   : ${tip.pinnacleLineDirection} ${tip.pinnacleLineValue} dropped ${tip.oddsDropPct}% (${tip.previousOdds} → ${tip.currentOdds})`);
    console.log(`   Signal     : \x1b[33m${tip.signal}\x1b[0m`);
    console.log('   ' + '─'.repeat(60));
  }

  console.log('\n\x1b[33m' + '═'.repeat(60) + '\x1b[0m\n');
}

const hoursArg = process.argv[2] ? parseInt(process.argv[2]) : 6;
const tips = runTipScanner(hoursArg);
printTips(tips);