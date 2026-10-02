const fs = require('fs');
const p = 'src/scrapers/football/fbrefCardsSotScraper.ts';
let s = fs.readFileSync(p, 'utf8');

if (s.includes('readTeamCache')) { console.log('Already applied.'); process.exit(0); }

const declAnchor = 'let cookieExpiredThisRun = false;';
const loadAnchor = 'const cards = await scrapeTeamCardsMatchlog(teamId, teamSlug, season);';
const saveAnchor = 'results[teamSlug] = { cards, sot };';
const errAnchor = 'console.error(`[fbrefScraper] Failed for ${leagueKey}/${teamSlug}:`, err);';

for (const a of [declAnchor, loadAnchor, saveAnchor, errAnchor]) {
  if (s.split(a).length !== 2) { console.log('ERROR: anchor missing or duplicated: ' + a + ' -- nothing changed.'); process.exit(1); }
}

const helpers = `// Per-team disk cache: a run that dies mid-way (cookie expiry, 429) keeps
// everything fetched so far, and the next run only fetches the missing teams.
// Written ONLY after both cards and SOT succeed, so a half-fetched team is never cached.
const FBREF_CACHE_DIR = 'data/fbref-cache';
const FBREF_CACHE_TTL_MS = 48 * 60 * 60 * 1000;

function teamCachePath(leagueKey: string, teamSlug: string, season: string): string {
  return FBREF_CACHE_DIR + '/' + leagueKey + '__' + season + '__' + teamSlug + '.json';
}

function readTeamCache(leagueKey: string, teamSlug: string, season: string): { cards: MatchLogRow[]; sot: MatchLogRow[] } | null {
  try {
    const nodeFs = require('fs');
    const file = teamCachePath(leagueKey, teamSlug, season);
    if (!nodeFs.existsSync(file)) return null;
    const parsed = JSON.parse(nodeFs.readFileSync(file, 'utf8'));
    if (!parsed.fetchedAt || Date.now() - parsed.fetchedAt > FBREF_CACHE_TTL_MS) return null;
    if (!Array.isArray(parsed.cards) || !Array.isArray(parsed.sot)) return null;
    return { cards: parsed.cards, sot: parsed.sot };
  } catch {
    return null;
  }
}

function writeTeamCache(leagueKey: string, teamSlug: string, season: string, data: { cards: MatchLogRow[]; sot: MatchLogRow[] }): void {
  try {
    const nodeFs = require('fs');
    nodeFs.mkdirSync(FBREF_CACHE_DIR, { recursive: true });
    nodeFs.writeFileSync(teamCachePath(leagueKey, teamSlug, season), JSON.stringify({ fetchedAt: Date.now(), ...data }));
  } catch (e: any) {
    logger.warn('[FBrefScraper] Cache write failed', { leagueKey, teamSlug, error: e.message });
  }
}

`;

s = s.replace(declAnchor, () => helpers + declAnchor);

s = s.replace(loadAnchor, () =>
  "const cached = readTeamCache(leagueKey, teamSlug, season);\n      if (cached) {\n        logger.info('[FBrefScraper] Cache hit, skipping fetch', { leagueKey, teamSlug });\n        results[teamSlug] = cached;\n        continue;\n      }\n      " + loadAnchor);

s = s.replace(saveAnchor, () => saveAnchor + "\n      writeTeamCache(leagueKey, teamSlug, season, { cards, sot });");

s = s.replace(errAnchor, () => errAnchor + "\n      await sleep(REQUEST_DELAY_MS);");

fs.writeFileSync(p, s);
console.log('Success: per-team cache added (48h TTL, data/fbref-cache).');
