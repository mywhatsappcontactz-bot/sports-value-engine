// src/cli/check-all-leagues.ts
// One-off diagnostic: loops through every league in FCSTATS_LEAGUE_MAP
// and reports parse success + team count, so scraper breakage (e.g.
// FCStats HTML structure drift) is caught before leagues go live.

import { fetchLeagueData, FCSTATS_LEAGUE_MAP } from '../scrapers/football/fcStatsScraper';

async function main() {
  const leagues = Object.keys(FCSTATS_LEAGUE_MAP);
  const results: { league: string; ok: boolean; count: number }[] = [];

  for (const league of leagues) {
    try {
      const data = await fetchLeagueData(league);
      const count = data?.teams.size ?? 0;
      results.push({ league, ok: count > 0, count });
    } catch (err: any) {
      results.push({ league, ok: false, count: 0 });
    }
    // small delay to be polite to FCStats' server
    await new Promise(r => setTimeout(r, 800));
  }

  console.log('\n=== FCStats League Health Check ===\n');
  const maxLen = Math.max(...leagues.map(l => l.length));
  for (const r of results) {
    const status = r.ok ? '✅' : '❌';
    console.log(`${r.league.padEnd(maxLen + 2)} ${status} ${r.count} teams`);
  }

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} leagues OK`);
  if (failed.length) {
    console.log('Failed:', failed.map(f => f.league).join(', '));
  }
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});