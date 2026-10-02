const fs = require('fs');
const p = 'src/cli/commands/scrape.ts';
let s = fs.readFileSync(p, 'utf8');

if (s.includes('prefetchedCardsSot')) { console.log('Already applied.'); process.exit(0); }

const a1 = 'async function scrapeFootball(): Promise<void> {';
const a2 = 'cardsSotLeagueData = await syncCardsSotForLeague(CARDS_SOT_SEASON, cardsSotLeagueKey);';
if (!s.includes(a1) || !s.includes(a2)) { console.log('ERROR: anchor not found. Nothing changed.'); process.exit(1); }

const prefetch = a1 + `
  // FBref FIRST: the cf_clearance cookie only lasts ~30-45 min, so all FBref
  // requests run up front, before the slow fixture syncs and soccerstats
  // fetches. Results are cached here and reused by the per-league loop below.
  const prefetchedCardsSot = new Map<string, Awaited<ReturnType<typeof syncCardsSotForLeague>>>();
  for (const key of Object.values(LEAGUE_NAME_TO_CARDS_SOT_KEY)) {
    try {
      logger.info('[Scrape] Prefetching cards/SOT (FBref first)', { key });
      prefetchedCardsSot.set(key, await syncCardsSotForLeague(CARDS_SOT_SEASON, key));
    } catch (err: any) {
      logger.warn('[Scrape] Cards/SOT prefetch failed', { key, error: err.message });
    }
  }
`;
s = s.replace(a1, () => prefetch);
s = s.replace(a2, () => 'cardsSotLeagueData = prefetchedCardsSot.get(cardsSotLeagueKey) ?? null;');

fs.writeFileSync(p, s);
console.log('Success: FBref now runs first.');
