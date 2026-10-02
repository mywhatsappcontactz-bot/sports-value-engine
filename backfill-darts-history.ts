// backfill-darts-history.ts
//
// One-time (or occasional) backfill — NOT part of the regular fetch loop.
// Pulls historical World Matchplay results from dartsdatabase.co.uk using
// CONFIRMED real eids (found via tournament-history.php?tid=13), feeding
// real per-match averages into dartsMatchStore for H2H that's richer than
// what live-darts.com can give during a LIVE tournament (legs only, no
// averages — see dartsFetch.ts's comment on why).
//
// Run this once (or whenever you want to add more historical depth):
//   npx ts-node backfill-darts-history.ts

import { fetchEventResults } from './src/scrapers/darts/dartsDatabaseScraper';
import { recordEventResults } from './src/scrapers/darts/dartsMatchStore';
import { logger } from './src/core/utils/logger';

// Confirmed real eids from dartsdatabase.co.uk's own history table
// (tournament-history.php?tid=13&tna=World+Matchplay) — fetched and
// verified directly, not guessed.
const WORLD_MATCHPLAY_EIDS: { year: string; eid: string }[] = [
  { year: '2025', eid: '25587' },
  { year: '2024', eid: '25234' },
  { year: '2022', eid: '24918' },
  { year: '2021', eid: '24843' },
  { year: '2020', eid: '24219' },
  { year: '2019', eid: '23577' },
  { year: '2018', eid: '22736' },
  { year: '2017', eid: '11003' },
  { year: '2016', eid: '7416' },
  { year: '2015', eid: '6109' },
  { year: '2014', eid: '5382' },
  { year: '2013', eid: '4204' },
  { year: '2012', eid: '3833' },
  { year: '2011', eid: '3231' },
  { year: '2010', eid: '2336' },
  { year: '2009', eid: '1988' },
  { year: '2008', eid: '1144' },
  // 2023 is missing from the confirmed table (skipped in the source data
  // itself — not an oversight here, that year simply wasn't in the
  // fetched history table between 2022 and 2024).
];

async function main() {
  let totalMatchesAdded = 0;

  for (const { year, eid } of WORLD_MATCHPLAY_EIDS) {
    try {
      const results = await fetchEventResults(eid, `World Matchplay ${year}`, year);

      if (!results) {
        logger.warn('[Backfill] No results parsed', { year, eid });
        continue;
      }

      const added = recordEventResults(eid, results.eventName, results.date, results.matches);
      totalMatchesAdded += added;

      console.log(`${year} (eid=${eid}): ${results.matches.length} matches parsed, ${added} new added to store`);

      // Be polite — this hits dartsdatabase.co.uk once per tournament,
      // no need to rush a one-time backfill.
      await new Promise((r) => setTimeout(r, 2000));

    } catch (err: any) {
      logger.error('[Backfill] Failed for year', { year, eid, error: err.message });
    }
  }

  console.log(`\nBackfill complete — ${totalMatchesAdded} total new matches added to dartsMatchStore.`);
}

main().catch(console.error);