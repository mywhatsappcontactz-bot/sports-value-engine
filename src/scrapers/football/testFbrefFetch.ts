// Standalone test — NOT part of the build. Run this alone to confirm
// fetchFbrefHtmlViaBrowser actually clears Cloudflare's challenge before
// wiring it into fbrefCardsSotScraper.ts. Delete or move to a /scripts
// folder once confirmed working; this isn't meant to ship.

import { fetchFbrefHtmlViaBrowser } from './fbrefPlaywrightFetch';

const TEST_URL = 'https://fbref.com/en/squads/18bb7c10/2025-2026/matchlogs/all_comps/misc/Arsenal-Match-Logs-All-Competitions';

async function main() {
  console.log('Fetching:', TEST_URL);
  try {
    const html = await fetchFbrefHtmlViaBrowser(TEST_URL);
    console.log('SUCCESS');
    console.log('HTML length:', html.length);
    console.log('Contains "matchlogs_for":', html.includes('matchlogs_for'));
    console.log('Contains "cards_yellow":', html.includes('cards_yellow'));
  } catch (err) {
    console.log('FAILED');
    console.error(err);
  }
}

main();