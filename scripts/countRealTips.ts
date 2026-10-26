process.env.CLI_SILENT = 'true';
import { runTipScanner } from '../src/core/engine/tipScanner';
const hours = Number(process.argv[2] ?? 168);
const tips = runTipScanner(hours).filter(t => t.sport === 'basketball' && t.targetMarket !== 'team_points_expected');
console.log(`Window ${hours}h: ${tips.length} real basketball tips`);
const by = new Map<string, number>();
for (const t of tips) by.set(t.league, (by.get(t.league) ?? 0) + 1);
for (const [l, n] of [...by].sort()) console.log(`  ${l.padEnd(32)} ${n}`);
