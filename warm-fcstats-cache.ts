import 'dotenv/config';
import { fetchLeagueData, FCSTATS_LEAGUE_MAP } from './src/scrapers/football/fcStatsScraper';

async function run() {
  const leagues = Object.keys(FCSTATS_LEAGUE_MAP);
  console.log(`Warming FC Stats cache for ${leagues.length} leagues...`);

  let succeeded = 0;
  let failed = 0;

  for (const league of leagues) {
    try {
      const data = await fetchLeagueData(league);
      if (data) {
        console.log(`✓ ${league}: ${data.teams.size} teams cached`);
        succeeded++;
      } else {
        console.log(`✗ ${league}: no data returned`);
        failed++;
      }
    } catch (err: any) {
      console.log(`✗ ${league}: ${err.message}`);
      failed++;
      // If the cookie just died, no point burning time on remaining leagues
      if (err.message?.includes('expired') || err.message?.includes('Challenge')) {
        console.log('Cookie appears to have expired — stopping early.');
        break;
      }
    }
    // Small delay between requests, same courtesy as other scrapers
    await new Promise((r) => setTimeout(r, 1500));
  }

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
}

run();