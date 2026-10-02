import { runTipScanner } from './src/core/engine/tipScanner';

const tips = runTipScanner(168); // 7-day window, same as your normal scan
const basketballTips = tips.filter(t => t.sport === 'basketball');

console.log(`Total tips: ${tips.length}`);
console.log(`Basketball tips: ${basketballTips.length}`);
basketballTips.forEach(t => {
  console.log(`  ${t.homeTeam} vs ${t.awayTeam} — ${t.targetMarket}: ${t.targetSelection} @ ${t.confidence}%`);
});
