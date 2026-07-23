// src/cli/debug-league-parse.ts
// Usage: npx ts-node src/cli/debug-league-parse.ts "Bundesliga - Germany"
//
// Dumps every regex match found for a league's table page, plus raw
// HTML length and diagnostics on WHY matching might stop short of the
// expected team count (e.g. FCStats page structure includes a second
// table, pagination, or slightly different row formatting for some rows).

import { FCSTATS_LEAGUE_MAP } from '../scrapers/football/fcStatsScraper';

const BASE = 'https://fcstats.com';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function main() {
  const leagueName = process.argv[2];
  if (!leagueName) {
    console.error('Usage: npx ts-node src/cli/debug-league-parse.ts "League Name"');
    process.exit(1);
  }

  const leaguePath = FCSTATS_LEAGUE_MAP[leagueName];
  if (!leaguePath) {
    console.error(`No FCStats path configured for "${leagueName}"`);
    console.error('Available:', Object.keys(FCSTATS_LEAGUE_MAP).join(', '));
    process.exit(1);
  }

  const url = `${BASE}/${leaguePath}`;
  console.log(`Fetching: ${url}\n`);

  const res = await fetch(url, { headers: HEADERS });
  const html = await res.text();
  console.log(`Raw HTML length: ${html.length} chars\n`);

  // Same regex used in fcStatsScraper.ts's parseLeagueTable
  const teamRegex = /href="club,statistics,([^,]+),(\d+),(\d+)\.php">([^<]+)<\/a><\/td>\s*<td>(\d+)<\/td>/g;
  let m;
  let count = 0;
  const matches: string[] = [];
  let lastIndex = 0;

  while ((m = teamRegex.exec(html)) !== null) {
    count++;
    const [, slug, teamId, seasonId, teamName, gp] = m;
    matches.push(`${count}. ${teamName.trim()} (id=${teamId}, season=${seasonId}, gp=${gp}) @ index ${m.index}`);
    lastIndex = m.index + m[0].length;
  }

  console.log(`Total regex matches: ${count}\n`);
  console.log(matches.join('\n'));

  // Check for signs of a second table / pagination / split structure
  const tableOccurrences = (html.match(/<table/g) || []).length;
  const clubStatsOccurrences = (html.match(/club,statistics,/g) || []).length;
  console.log(`\n<table> tags found: ${tableOccurrences}`);
  console.log(`"club,statistics," href occurrences (raw, before regex filtering): ${clubStatsOccurrences}`);

  if (clubStatsOccurrences > count) {
    console.log(`\n⚠️  Raw href count (${clubStatsOccurrences}) > regex matches (${count}) — some team rows are NOT matching the current regex pattern. Likely a formatting difference (extra whitespace, different tag order, or a second table/section with a different row layout).`);
  }

  // Print HTML snippet right after the last successful match, to see
  // what comes next in the document (often reveals a format change).
  if (lastIndex > 0) {
    console.log(`\n--- HTML snippet after last match (400 chars) ---\n`);
    console.log(html.slice(lastIndex, lastIndex + 400));
  }

  // Also print a snippet around any LATER "club,statistics," occurrence
  // that the regex missed, if one exists past lastIndex.
  const laterIdx = html.indexOf('club,statistics,', lastIndex);
  if (laterIdx !== -1) {
    console.log(`\n--- HTML snippet around a MISSED team row (200 chars before/after) ---\n`);
    console.log(html.slice(Math.max(0, laterIdx - 200), laterIdx + 200));
  }
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});