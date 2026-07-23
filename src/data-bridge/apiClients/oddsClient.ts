// src/data-bridge/apiClients/oddsClient.ts
import * as fs from 'fs';
import * as path from 'path';
import { ApiResponse } from '../baseClient';
import { RawMatch, RawOdds } from '../mockClient';
import { logger } from '../../core/utils/logger';

// ─── CONSTANTS ───────────────────────────────────────────

const BASE_URL = 'https://api.the-odds-api.com/v4';

const SPORT_KEYS: Record<string, string[]> = {
  football: [
    // ── Currently active ──────────────────────────────
    'soccer_finland_veikkausliiga',
    'soccer_sweden_superettan',
    'soccer_sweden_allsvenskan',
    'soccer_norway_eliteserien',
    'soccer_league_of_ireland',
    'soccer_brazil_serie_b',
    'soccer_china_superleague',
    'soccer_italy_serie_a',
    'soccer_brazil_campeonato',
    'soccer_korea_kleague1',

    // ── Starting mid/late July 2026 ───────────────────
    'soccer_denmark_superliga',
    'soccer_bulgaria_professional_league',

    // ── Starting late July 2026 ───────────────────────
    'soccer_scotland_premiership',
    'soccer_belgium_first_div',
    'soccer_austria_bundesliga',
    'soccer_croatia_1_hnl',
    'soccer_switzerland_superleague',

    // ── Starting early August 2026 ────────────────────
    'soccer_efl_champ',
    'soccer_england_league1',
    'soccer_england_league2',
    'soccer_czech_republic_liga',

    // ── EPL — starts August 2026 ──────────────────────
    'soccer_epl',

    // ── Russia/Poland — verify availability ───────────
    'soccer_russia_premier_league',
    'soccer_poland_ekstraklasa',
  ],
  basketball: [
    'basketball_wnba',
  ],
  tennis: [
    
  // ATP
  'tennis_atp_aus_open_singles',
  'tennis_atp_dubai',
  'tennis_atp_qatar_open',
  'tennis_atp_indian_wells',
  'tennis_atp_miami_open',
  'tennis_atp_monte_carlo_masters',
  'tennis_atp_barcelona_open',
  'tennis_atp_madrid_open',
  'tennis_atp_italian_open',
  'tennis_atp_french_open',
  'tennis_atp_queens_club_champ',
  'tennis_atp_halle_open',
  'tennis_atp_wimbledon',
  'tennis_atp_hamburg_open',
  'tennis_atp_canadian_open',
  'tennis_atp_cincinnati_open',
  'tennis_atp_us_open',
  'tennis_atp_china_open',
  'tennis_atp_shanghai_masters',
  'tennis_atp_paris_masters',
  'tennis_atp_munich',
  // WTA
  'tennis_wta_aus_open_singles',
  'tennis_wta_dubai',
  'tennis_wta_qatar_open',
  'tennis_wta_indian_wells',
  'tennis_wta_miami_open',
  'tennis_wta_madrid_open',
  'tennis_wta_italian_open',
  'tennis_wta_french_open',
  'tennis_wta_german_open',
  'tennis_wta_queens_club_champ',
  'tennis_wta_bad_homburg_open',
  'tennis_wta_wimbledon',
  'tennis_wta_stuttgart_open',
  'tennis_wta_strasbourg',
  'tennis_wta_canadian_open',
  'tennis_wta_cincinnati_open',
  'tennis_wta_us_open',
  'tennis_wta_china_open',
  'tennis_wta_wuhan_open',
  'tennis_wta_charleston_open',
],
  
  hockey: [
    'icehockey_nhl',
  ],
};

// CHANGED: was a single market string per sport (football only ever got
// 'totals' — moneyline and handicap odds were NEVER fetched for football,
// meaning those bets could never fire regardless of model support).
// Now each sport lists the markets to fetch, ONE AT A TIME (separate API
// calls per market) — safer than combining, since a rejection/error on
// one market doesn't take down the others, and easier to debug per-market
// failures in the logs.
const SPORT_MARKETS: Record<string, string[]> = {
  football:   ['totals'],           // Over/Under only, per user preference
  basketball: ['h2h', 'totals'],    // moneyline + Over/Under
  tennis:     ['h2h'],              // match result only
  hockey:     ['h2h'],              // match result only
};

const SPORT_REGIONS: Record<string, string> = {
  football:   'eu',
  basketball: 'us',
  tennis:     'eu',
  hockey:     'us',
};

const BOOKMAKERS_WHITELIST = ['pinnacle', 'bet365', 'unibet', 'williamhill', 'draftkings', 'fanduel', 'betmgm'];

// ─── PERSISTENT FILE CACHE ────────────────────────────────

interface CacheEntry {
  data: { matches: RawMatch[]; oddsMap: [string, RawOdds[]][] };
  fetchedAt: number;
}

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_DIR = path.join(__dirname, '../../../.cache');

function cacheFilePath(sport: string): string {
  return path.join(CACHE_DIR, `odds-${sport}.json`);
}

function readCache(sport: string): { matches: RawMatch[]; oddsMap: Map<string, RawOdds[]> } | null {
  try {
    const filePath = cacheFilePath(sport);
    if (!fs.existsSync(filePath)) return null;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);

    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;

    return {
      matches: entry.data.matches,
      oddsMap: new Map(entry.data.oddsMap),
    };
  } catch {
    return null;
  }
}

function writeCache(sport: string, data: { matches: RawMatch[]; oddsMap: Map<string, RawOdds[]> }): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const entry: CacheEntry = {
      data: {
        matches: data.matches,
        oddsMap: Array.from(data.oddsMap.entries()),
      },
      fetchedAt: Date.now(),
    };

    fs.writeFileSync(cacheFilePath(sport), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn(`[OddsClient] Failed to write cache for ${sport}`, { error: err.message });
  }
}

// How far ahead to look for fixtures before deciding a league is worth
// spending credits on. The /events endpoint below is FREE (doesn't
// count against quota) — using it as a pre-check avoids paying for
// /odds calls on leagues that are currently off-season and would
// return 0 matches anyway (confirmed from real scan logs: more than
// half of configured football leagues were burning credits for
// nothing every single scan).
const FIXTURE_WINDOW_HOURS = 24;

async function hasUpcomingFixtures(sportKey: string, windowHours: number): Promise<boolean> {
  try {
    const events = await apiFetch<any[]>(`/sports/${sportKey}/events`, {});
    if (!events || !events.length) return false;

    const now = Date.now();
    const cutoff = now + windowHours * 60 * 60 * 1000;

    return events.some(e => {
      const t = new Date(e.commence_time).getTime();
      return t <= cutoff && t >= now - 60 * 60 * 1000; // small buffer for in-play events
    });
  } catch (err: any) {
    // Fail open — if the free check itself errors, don't block the
    // real fetch attempt over it. Worst case: one wasted paid call.
    logger.warn(`[OddsClient] Free fixture check failed for ${sportKey}`, { error: err.message });
    return true;
  }
}

// ─── API HELPER ──────────────────────────────────────────

async function apiFetch<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey = process.env.THE_ODDS_API_KEY;
  if (!apiKey) throw new Error('THE_ODDS_API_KEY not set in environment');

  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set('apiKey', apiKey);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());

  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  const last = res.headers.get('x-requests-last');
  if (remaining) {
    logger.info(`[OddsClient] API credits — used: ${used}, last: ${last}, remaining: ${remaining}`);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TheOddsAPI ${endpoint} failed: ${res.status} — ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── PARSER (ODDS) ────────────────────────────────────────

function parseEvents(
  events: any[],
  sport: string,
  sportKey: string,
): { matches: RawMatch[]; oddsMap: Map<string, RawOdds[]> } {
  const matches: RawMatch[] = [];
  const oddsMap = new Map<string, RawOdds[]>();
  const ts = new Date().toISOString();

  for (const event of events) {
    const externalId = event.id;
    const homeTeam = event.home_team;
    const awayTeam = event.away_team;
    const startTime = event.commence_time;
    const league = event.sport_title || sportKey;

    if (!externalId || !homeTeam || !awayTeam || !startTime) continue;

    matches.push({
      externalId,
      sport,
      league,
      homeTeam,
      awayTeam,
      startTime,
      source: 'theoddsapi',
    });

    const rawOdds: RawOdds[] = [];
    const bookmakers = event.bookmakers || [];

    for (const bookmaker of bookmakers) {
      const slug = bookmaker.key as string;
      if (!BOOKMAKERS_WHITELIST.includes(slug)) continue;

      const bookmakerName = toBookmakerName(slug);
      const markets = bookmaker.markets || [];

      for (const market of markets) {
        const marketKey = market.key as string;
        const marketName = toMarketName(marketKey);
        if (!marketName) continue;

        const outcomes = market.outcomes || [];

        for (const outcome of outcomes) {
          const selection = toSelection(outcome, marketKey);
          if (!selection) continue;

          const odds = outcome.price as number;
          if (!odds || odds <= 1) continue;

          rawOdds.push({
            externalMatchId: externalId,
            bookmaker: bookmakerName,
            market: marketName,
            selection,
            odds,
            timestamp: ts,
          });
        }
      }
    }

    if (rawOdds.length > 0) {
      oddsMap.set(externalId, rawOdds);
    }
  }

  return { matches, oddsMap };
}

function toMarketName(key: string): string | null {
  const map: Record<string, string> = {
    h2h:     'moneyline',
    totals:  'totals',
    // FIXED: was 'spread' (no 'i') — didn't match the 'handicap' key
    // used everywhere else (probabilityModel.ts, valueEngine.ts), so
    // handicap odds were being fetched but silently never matched.
    spreads: 'handicap',
  };
  return map[key] || null;
}

function toSelection(outcome: any, marketKey: string): string | null {
  if (marketKey === 'h2h') {
    return outcome.name || null;
  }
  if (marketKey === 'totals') {
    if (outcome.name && outcome.point !== undefined) {
      return `${outcome.name} ${outcome.point}`;
    }
  }
  if (marketKey === 'spreads') {
    if (outcome.name && outcome.point !== undefined) {
      return `${outcome.name} ${outcome.point}`;
    }
  }
  return null;
}

function toBookmakerName(slug: string): string {
  const map: Record<string, string> = {
    pinnacle:    'Pinnacle',
    bet365:      'Bet365',
    williamhill: 'William Hill',
    unibet:      'Unibet',
    betfair:     'Betfair Exchange',
    bwin:        'Bwin',
  };
  return map[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

// Merges a new oddsMap into an accumulator oddsMap (concatenating odds
// arrays for matches seen in more than one market pass, rather than
// overwriting — needed now that we call the API once per market).
function mergeOddsMaps(
  target: Map<string, RawOdds[]>,
  source: Map<string, RawOdds[]>,
): void {
  for (const [matchId, odds] of source) {
    if (target.has(matchId)) {
      target.get(matchId)!.push(...odds);
    } else {
      target.set(matchId, [...odds]);
    }
  }
}

// Merges matches lists, de-duplicating by externalId (the same match
// will appear once per market pass — h2h, totals, spreads — since each
// is now a separate API call).
function mergeMatches(target: RawMatch[], source: RawMatch[]): RawMatch[] {
  const seen = new Set(target.map(m => m.externalId));
  const merged = [...target];
  for (const m of source) {
    if (!seen.has(m.externalId)) {
      merged.push(m);
      seen.add(m.externalId);
    }
  }
  return merged;
}

// ─── RESULTS / SCORES TYPES ───────────────────────────────

export interface RawScore {
  externalId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  completed: boolean;
  homeScore: number | null;
  awayScore: number | null;
  lastUpdate: string | null;
}

// ─── MAIN CLIENT ─────────────────────────────────────────

export class OddsClient {

  async fetchForSport(sport: string): Promise<{
    matches: RawMatch[];
    oddsMap: Map<string, RawOdds[]>;
  }> {
    const cached = readCache(sport);
    if (cached) {
      logger.info(`[OddsClient] Cache hit for ${sport} — skipping API call`);
      return cached;
    }

    const sportKeys = SPORT_KEYS[sport];
    if (!sportKeys?.length) {
      throw new Error(`No sport keys configured for ${sport}`);
    }

    const markets = SPORT_MARKETS[sport];
    if (!markets?.length) {
      throw new Error(`No markets configured for ${sport}`);
    }

    logger.info(`[OddsClient] Fetching odds for ${sport}`, {
      leagues: sportKeys.length,
      markets,
    });

    let allMatches: RawMatch[] = [];
    let allOddsMap = new Map<string, RawOdds[]>();

    // ONE MARKET AT A TIME: separate API call per market per league.
    // Slower (more calls) but isolates failures — if 'spreads' isn't
    // available for a league, 'h2h' and 'totals' still succeed
    // independently instead of the whole request failing together.
    for (const sportKey of sportKeys) {
      // FREE pre-check — skip this league entirely (no credits spent)
      // if it has no fixtures in the next FIXTURE_WINDOW_HOURS. This
      // is what was silently burning credits before: off-season
      // leagues returning 0 matches still cost the same as an active
      // one, every single scan.
      const hasFixtures = await hasUpcomingFixtures(sportKey, FIXTURE_WINDOW_HOURS);
      if (!hasFixtures) {
        logger.info(`[OddsClient] Skipping ${sportKey} — no fixtures within ${FIXTURE_WINDOW_HOURS}h (free check, 0 credits used)`);
        continue;
      }

      for (const market of markets) {
        try {
          const events = await apiFetch<any[]>(`/sports/${sportKey}/odds`, {
            regions: SPORT_REGIONS[sport] || 'eu',
            markets: market,
            oddsFormat: 'decimal',
          });

          const { matches, oddsMap } = parseEvents(events || [], sport, sportKey);
          allMatches = mergeMatches(allMatches, matches);
          mergeOddsMaps(allOddsMap, oddsMap);

          logger.info(`[OddsClient] ${sportKey} [${market}]: ${matches.length} matches, ${oddsMap.size} with odds`);

          await new Promise(r => setTimeout(r, 500));

        } catch (err: any) {
          logger.warn(`[OddsClient] Failed to fetch ${sportKey} [${market}]`, { error: err.message });
        }
      }
    }

    logger.info(`[OddsClient] Total for ${sport}: ${allMatches.length} matches, ${allOddsMap.size} with odds`);

    const data = { matches: allMatches, oddsMap: allOddsMap };
    writeCache(sport, data);

    return data;
  }

  async fetchScores(sport: string, daysFrom: number = 3): Promise<RawScore[]> {
    const sportKeys = SPORT_KEYS[sport];
    if (!sportKeys?.length) {
      throw new Error(`No sport keys configured for ${sport}`);
    }

    const clampedDays = Math.max(1, Math.min(3, daysFrom));
    const allScores: RawScore[] = [];

    for (const sportKey of sportKeys) {
      try {
        const events = await apiFetch<any[]>(`/sports/${sportKey}/scores`, {
          daysFrom: String(clampedDays),
          dateFormat: 'iso',
        });

        for (const event of (events || [])) {
          if (!event.completed) continue;

          const scoresArr = event.scores || [];
          const homeScoreEntry = scoresArr.find((s: any) => s.name === event.home_team);
          const awayScoreEntry = scoresArr.find((s: any) => s.name === event.away_team);

          allScores.push({
            externalId: event.id,
            sport,
            homeTeam: event.home_team,
            awayTeam: event.away_team,
            completed: true,
            homeScore: homeScoreEntry ? parseInt(homeScoreEntry.score, 10) : null,
            awayScore: awayScoreEntry ? parseInt(awayScoreEntry.score, 10) : null,
            lastUpdate: event.last_update || null,
          });
        }

        logger.info(`[OddsClient] ${sportKey}: ${events?.length || 0} events checked, ${allScores.length} completed so far`);

        await new Promise(r => setTimeout(r, 500));

      } catch (err: any) {
        logger.warn(`[OddsClient] Failed to fetch scores for ${sportKey}`, { error: err.message });
      }
    }

    return allScores;
  }

  async fetchOddsForFixture(fixtureId: string): Promise<ApiResponse<RawOdds[]>> {
    logger.warn(`[OddsClient] fetchOddsForFixture not supported on TheOddsAPI — use fetchForSport`);
    return {
      data: [],
      success: true,
      statusCode: 200,
      correlationId: `odds_${Date.now()}`,
    };
  }

  clearCache(sport?: string) {
    if (sport) {
      const filePath = cacheFilePath(sport);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else {
      if (fs.existsSync(CACHE_DIR)) fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    }
  }
}

export const oddsClient = new OddsClient();