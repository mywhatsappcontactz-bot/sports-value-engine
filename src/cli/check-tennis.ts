// src/cli/list-tennis.ts
// One-off: list-sports.ts doesn't query the Tennis group, so this hits
// the /v4/sports endpoint directly (FREE, doesn't cost credits) and
// filters for tennis_* keys, to find currently-live ATP/WTA/Challenger
// tournament keys now that Wimbledon has ended.
//
// NOTE: this script has no other project imports, so unlike scan.ts /
// check-tennis.ts (which load env as a side effect of importing
// db/config modules), we load it explicitly here.
import 'dotenv/config';

async function main() {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) {
    console.error('THE_ODDS_API_KEY not set in environment');
    process.exit(1);
  }

  // all=true includes inactive/dormant sports too, not just currently-active ones
  const url = `https://api.the-odds-api.com/v4/sports/?apiKey=${apiKey}&all=true`;
  const res = await fetch(url);

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${await res.text()}`);
    process.exit(1);
  }

  const sports: { key: string; group: string; title: string; active: boolean }[] = await res.json();

  console.log(`Total sports returned (all=true): ${sports.length}`);
  console.log(`Sample groups found:`, [...new Set(sports.map(s => s.group))].join(', '));

  const tennis = sports.filter(s => s.key.toLowerCase().includes('tennis') || s.group === 'Tennis');

  console.log(`\n=== TENNIS (${tennis.length}) ===`);
  console.log(tennis.map(s => ({ key: s.key, title: s.title, active: s.active })));
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});