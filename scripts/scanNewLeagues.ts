process.env.CLI_SILENT = 'true';
import { runTipScanner } from '../src/core/engine/tipScanner';

const hours = Number(process.argv[2] ?? 28);
const NEW = ['Liga ABA - Adriatic','Superliga - Austria','Pro A - Germany','A League - Hungary','Extraliga - Slovakia','SBL - Switzerland','B2 League - Japan','VTB United League - Russia','Division A - Romania','Express League - Iceland','SLB - UK','Primera FEB - Spain'];
const tips = runTipScanner(hours).filter(t => t.sport === 'basketball');
console.log(`Window ${hours}: ${tips.length} basketball tips total`);
const byLeague = new Map<string, number>();
for (const t of tips) byLeague.set(t.league, (byLeague.get(t.league) ?? 0) + 1);
for (const [l, n] of [...byLeague].sort()) console.log(`  ${l.padEnd(32)} ${n}${NEW.includes(l) ? '   <-- new' : ''}`);
for (const t of tips.filter(t => NEW.includes(t.league))) {
  console.log(`\n${t.league} | ${t.homeTeam} vs ${t.awayTeam} | ${t.hoursToKickoff}h`);
  console.log(`  ${t.targetSelection} (${t.targetMarket}) confidence ${t.confidence}%  ${t.localOdds !== null ? '@ ' + t.localOdds : '(no live price)'}`);
}
