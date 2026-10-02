// src/scrapers/football/fbrefCardsSotScraper.ts
import 'dotenv/config';
import * as cheerio from 'cheerio';
import { logger } from '../../core/utils/logger';

// ─── CONFIG ─────────────────────────────────────────────────
const REQUEST_DELAY_MS = 6500;
const BASE_URL = 'https://fbref.com';

export interface MatchLogRow {
  date: string;
  opponent: string;
  venue: 'Home' | 'Away' | 'Neutral';
  comp: string;
  cardsYellow?: number;
  cardsRed?: number;
  shotsOnTarget?: number;
}

// ─── TEAM FBREF IDS — RESTRUCTURED (see conversation) ───────────────
// Was a flat Record<teamSlug, fbrefId> covering EPL only. Restructured
// to Record<leagueKey, Record<teamSlug, fbrefId>> ahead of adding 5 more
// leagues, to avoid two real risks a flat map would have created:
//   1. Slug collisions — two different countries could plausibly produce
//      the same normalized slug for unrelated teams.
//   2. No way for scrapeAllTeamsCardsAndSot to scope a run to "just
//      Bundesliga" — it would blindly iterate every team from every
//      league every time, wasting FBref requests and violating the
//      "only fetch what this sync run needs" design.
//
// leagueKey values below ('EPL', 'LA_LIGA', etc.) intentionally match
// DOMESTIC_LEAGUE_COMP_NAMES' keys below, so a given league's team IDs
// and its domestic comp-name filter stay paired under the same key.
export const TEAM_FBREF_IDS: Record<string, Record<string, string>> = {
  // ── EPL — unchanged, migrated as-is from the old flat structure ──
  EPL: {
    'arsenal': '18bb7c10',
    'aston-villa': '8602292d',
    'bournemouth': '4ba7cbea',
    'brentford': 'cd051869',
    'brighton-and-hove-albion': 'd07537b9',
    'chelsea': 'cff3d9bb',
    'coventry-city': 'f7e3dfe9',
    'crystal-palace': '47c64c55',
    'everton': 'd3fd31cc',
    'fulham': 'fd962109',
    'hull-city': 'bd8769d1',
    'ipswich-town': 'b74092de',
    'leeds-united': '5bfb9659',
    'liverpool': '822bd0ba',
    'manchester-city': 'b8fd03ef',
    'manchester-united': '19538871',
    'newcastle-united': 'b2b47a98',
    'nottingham-forest': 'e4a775cb',
    'sunderland': '8ef52968',
    'tottenham-hotspur': '361ca564',
    // TODO: still missing —
    // 'west-ham-united': '???',
    // 'wolverhampton-wanderers': '???',
    // 'burnley': '???',
    // 'southampton': '???',
  },

  // ── LA_LIGA — scraped + spot-checked 2026-09-24 (20/20 teams
  // confirmed real, including Málaga/Racing Santander/Dep. A Coruña,
  // which looked suspicious for a top-flight roster but were manually
  // confirmed against the live table — see conversation) ──
  LA_LIGA: {
    'barcelona': '206d90db',
    'atletico-madrid': 'db3b9613',
    'real-betis': 'fc536746',
    'real-madrid': '53a2f082',
    'sevilla': 'ad2be733',
    'alaves': '8d6fd021',
    'deportivo-a-coruna': '2a60ed82',
    'real-sociedad': 'e31d1cd9',
    'villarreal': '2a8183b3',
    'athletic-club': '2b390eca',
    'getafe': '7848bd64',
    'rayo-vallecano': '98e8af82',
    'osasuna': '03c57e2b',
    'celta-vigo': 'f25da7fb',
    'espanyol': 'a8661628',
    'racing-santander': 'dee3bbc8',
    'levante': '9800b6a1',
    'elche': '6c8b07df',
    'valencia': 'dcc91a7b',
    'malaga': '1c896955',
  },

  // ── BUNDESLIGA — scraped 2026-09-24, 18/18, count in expected range.
  // NOT yet manually spot-checked against the live page the way La Liga
  // was — do that before running a real sync against these IDs. ──
  BUNDESLIGA: {
    'dortmund': 'add600ae',
    'bayern-munich': '054efa67',
    'freiburg': 'a486e511',
    'augsburg': '0cdc4311',
    'leverkusen': 'c7a9f859',
    'mainz-05': 'a224b06a',
    'elversberg': 'fe686760',
    'werder-bremen': '62add3bf',
    'rb-leipzig': 'acbb6a5b',
    'eintracht-frankfurt': 'f0ac8ee6',
    'schalke-04': 'c539e393',
    'paderborn-07': 'd9f93f02',
    'koln': 'bc357bf7',
    'hoffenheim': '033ea6b8',
    'stuttgart': '598bc722',
    'hamburger-sv': '26790c6a',
    'union-berlin': '7a41008f',
    'monchengladbach': '32f3ee20',
  },

  // ── SERIE_A — scraped 2026-09-24, 20/20. NOT yet manually
  // spot-checked — do that before running a real sync. ──
  SERIE_A: {
    'roma': 'cf74a709',
    'internazionale': 'd609edc0',
    'lazio': '7213da33',
    'cagliari': 'c4260e09',
    'milan': 'dc56fe14',
    'frosinone': '6a7ad59d',
    'juventus': 'e0652b02',
    'como': '28c9c3cd',
    'napoli': 'd48ad4ff',
    'sassuolo': 'e2befd26',
    'atalanta': '922493f3',
    'lecce': 'ffcbe334',
    'udinese': '04eea015',
    'torino': '105360fe',
    'parma': 'eab4234c',
    'monza': '21680aa4',
    'fiorentina': '421387cf',
    'bologna': '1d8099f8',
    'genoa': '658bf2de',
    'venezia': 'af5d5982',
  },

  // ── LIGUE_1 — scraped 2026-09-24, 18/18. NOT yet manually
  // spot-checked — do that before running a real sync. ──
  LIGUE_1: {
    'monaco': 'fd6114db',
    'lyon': 'd53c0b06',
    'paris-fc': '056a5a75',
    'lille': 'cb188c0c',
    'rennes': 'b3072e00',
    'paris-saint-germain': 'e2d8892c',
    'angers': '69236f98',
    'strasbourg': 'c0d3eab4',
    'le-mans': 'cd5d7aa6',
    'auxerre': '5ae09109',
    'lorient': 'd2c87802',
    'brest': 'fb08dbb3',
    'toulouse': '3f8c4b5f',
    'nice': '132ebc33',
    'lens': 'fd4e0f7d',
    'troyes': '54195385',
    'marseille': '5725cc7b',
    'le-havre': '5c2737db',
  },

  // ── EREDIVISIE — scraped 2026-09-24, 18/18. NOT yet manually
  // spot-checked — do that before running a real sync. ──
  EREDIVISIE: {
    'az-alkmaar': '3986b791',
    'feyenoord': 'fb4ca611',
    'psv-eindhoven': 'e334d850',
    'twente': 'a1f721d3',
    'ajax': '19c3f8c4',
    'fortuna-sittard': 'bd08295c',
    'excelsior': '740cb7d4',
    'groningen': 'bec05adb',
    'go-ahead-eagles': 'e33d6108',
    'heerenveen': '193ff7aa',
    'nec-nijmegen': 'fc629994',
    'sparta-rotterdam': '146a68ce',
    'telstar': '9babc1f9',
    'cambuur': '5c9e307a',
    'utrecht': '2a428619',
    'zwolle': 'e3db180b',
    'ado-den-haag': '4e7459b7',
    'willem-ii': 'f0479d7b',
  },

  // ── PRIMEIRA_LIGA — scraped 2026-09-24, 18/18. NOT yet manually
  // spot-checked — do that before running a real sync. ──
  PRIMEIRA_LIGA: {
    'porto': '5e876ee6',
    'benfica': 'a77c513e',
    'sporting-cp': '13dc44fd',
    'santa-clara': 'f5b64cb1',
    'arouca': '0d36ddd4',
    'braga': '69d84c29',
    'academico-de-viseu': 'a24fd227',
    'estrela': '0cb9f756',
    'moreirense': 'e4502862',
    'gil-vicente-fc': '6a329209',
    'maritimo': 'c1b0f61b',
    'alverca': '8bbf8a25',
    'famalicao': '2de656d5',
    'vitoria-guimaraes': '3f319bc9',
    'nacional': '5c9eb756',
    'rio-ave': 'eea856da',
    'casa-pia': 'b20a2b76',
    'estoril': '00c41b75',
  },
};

// ─── DOMESTIC LEAGUE FILTER ─────────────────────────────────────
// EPL's "Premier League" is the only string in this map ever confirmed
// against a real domestic-league row (the cup value "FA Community
// Shield" was separately confirmed too, but that's not this map).
// The other 5 leagues' names below are FBref's known standard labels
// elsewhere on the site — NOT independently verified against a real
// match row here, same unverified status every earlier addition to this
// file started at. Do NOT trust cards/SOT totals for these 5 leagues
// until each is checked the same way EPL was: run cardsSotSync.ts for a
// team in that league, and confirm the string here matches the real
// "Comp" column value on their matchlog page. Getting this wrong means
// filterToDomesticLeague silently drops every real match for that
// league (see EPL's original caveat comment for why that's the failure
// mode to check for, not pollution).
export const DOMESTIC_LEAGUE_COMP_NAMES: Record<string, string> = {
  EPL: 'Premier League',
  LA_LIGA: 'La Liga',
  BUNDESLIGA: 'Bundesliga',
  SERIE_A: 'Serie A',
  LIGUE_1: 'Ligue 1',
  EREDIVISIE: 'Eredivisie',
  PRIMEIRA_LIGA: 'Primeira Liga',
};

// ─── MANUAL COOKIE SESSION ─────────────────────────────────────
const FBREF_COOKIE = process.env.FBREF_COOKIE;
const FBREF_UA = process.env.FBREF_UA;

if (!FBREF_COOKIE || !FBREF_UA) {
  logger.warn(
    '[FBrefScraper] FBREF_COOKIE and/or FBREF_UA not set in .env — every ' +
      'request will fail. Solve fbref.com\'s Cloudflare challenge manually ' +
      '(visit any fbref.com page in a real browser, open dev tools, copy the ' +
      'cf_clearance cookie value and your User-Agent string) and set both ' +
      'before running a sync.'
  );
}

function looksLikeChallengePage(html: string): boolean {
  const hasChallengeTitle =
    html.includes('<title>Just a moment...</title>') ||
    html.includes('id="challenge-running"') ||
    html.includes('id="challenge-error-title"') ||
    html.includes('Verify you are human') ||
    html.includes('Attention Required');

  return hasChallengeTitle || html.length < 2000;
}

async function fetchFbrefHtml(url: string): Promise<string> {
  if (!FBREF_COOKIE || !FBREF_UA) {
    throw new Error(
      '[FBrefScraper] FBREF_COOKIE / FBREF_UA missing from .env. Solve the ' +
        'Cloudflare challenge manually on fbref.com and set both before retrying.'
    );
  }

  logger.info('[FBrefScraper] Requesting with manual cookie session', { url });

  const res = await fetch(url, {
    headers: {
      Cookie: `cf_clearance=${FBREF_COOKIE}`,
      'User-Agent': FBREF_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });

  if (!res.ok) {
    throw new Error(`[FBrefScraper] HTTP error ${res.status} for ${url}`);
  }

  const raw = await res.text();

  if (looksLikeChallengePage(raw)) {
    logger.warn('[FBrefScraper] Got a challenge page — cookie likely expired or IP mismatch', {
      url,
      htmlLength: raw.length,
    });
    throw new Error(
      `[FBrefScraper] Challenge page for ${url} — cookie has expired (they last roughly ` +
        `30-45 min based on fcstats/soccerstats experience) or your IP changed since ` +
        `solving it. Grab a fresh cf_clearance cookie and re-run.`
    );
  }

  logger.info('[FBrefScraper] Success', { url, htmlLength: raw.length });

  return raw.replace(/<!--/g, '').replace(/-->/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── MISC STATS (CARDS) ─────────────────────────────────────────
export async function scrapeTeamCardsMatchlog(
  teamFbrefId: string,
  teamSlug: string,
  season: string,
): Promise<MatchLogRow[]> {
  const url = `${BASE_URL}/en/squads/${teamFbrefId}/${season}/matchlogs/all_comps/misc/${teamSlug}-Match-Logs-All-Competitions`;
  const html = await fetchFbrefHtml(url);
  const $ = cheerio.load(html);

  const rows: MatchLogRow[] = [];

  $('#matchlogs_for tbody tr').each((_, el) => {
    const $row = $(el);
    if ($row.hasClass('thead')) return;

    const date = $row.find('[data-stat="date"]').text().trim();
    const opponent = $row.find('[data-stat="opponent"]').text().trim();
    const venueRaw = $row.find('[data-stat="venue"]').text().trim();
    const comp = $row.find('[data-stat="comp"]').text().trim();
    const cardsYellowRaw = $row.find('[data-stat="cards_yellow"]').text().trim();
    const cardsRedRaw = $row.find('[data-stat="cards_red"]').text().trim();

    if (!date) return;

    rows.push({
      date,
      opponent,
      venue: (venueRaw as 'Home' | 'Away' | 'Neutral') || 'Neutral',
      comp,
      cardsYellow: cardsYellowRaw ? parseInt(cardsYellowRaw, 10) : undefined,
      cardsRed: cardsRedRaw ? parseInt(cardsRedRaw, 10) : undefined,
    });
  });

  return rows;
}

// ─── SHOOTING STATS (SOT) ────────────────────────────────────────
export async function scrapeTeamSotMatchlog(
  teamFbrefId: string,
  teamSlug: string,
  season: string,
): Promise<MatchLogRow[]> {
  const url = `${BASE_URL}/en/squads/${teamFbrefId}/${season}/matchlogs/all_comps/shooting/${teamSlug}-Match-Logs-All-Competitions`;
  const html = await fetchFbrefHtml(url);
  const $ = cheerio.load(html);

  const rows: MatchLogRow[] = [];

  $('#matchlogs_for tbody tr').each((_, el) => {
    const $row = $(el);
    if ($row.hasClass('thead')) return;

    const date = $row.find('[data-stat="date"]').text().trim();
    const opponent = $row.find('[data-stat="opponent"]').text().trim();
    const venueRaw = $row.find('[data-stat="venue"]').text().trim();
    const comp = $row.find('[data-stat="comp"]').text().trim();
    const sotRaw = $row.find('[data-stat="shots_on_target"]').text().trim();

    if (!date) return;

    rows.push({
      date,
      opponent,
      venue: (venueRaw as 'Home' | 'Away' | 'Neutral') || 'Neutral',
      comp,
      shotsOnTarget: sotRaw ? parseInt(sotRaw, 10) : undefined,
    });
  });

  return rows;
}

// ─── BATCH RUNNER — RESTRUCTURED to take a leagueKey (see conversation) ──
// BREAKING CHANGE from the old signature (season: string) only — every
// caller of this function needs updating to also pass a leagueKey. This
// is the main downstream consequence of the TEAM_FBREF_IDS restructure:
// grep the codebase for scrapeAllTeamsCardsAndSot( to find every call
// site that needs the new argument (cardsSotSync.ts is the known one
// from earlier in this project — there may be others).
// cf_clearance cookies last roughly 30-45 min; a long scrape.ts run can outlast that.
// Once expiry is confirmed, every later request is guaranteed to fail, so stop early.
// Per-team disk cache: a run that dies mid-way (cookie expiry, 429) keeps
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

let cookieExpiredThisRun = false;

export async function scrapeAllTeamsCardsAndSot(
  leagueKey: string,
  season: string,
): Promise<Record<string, { cards: MatchLogRow[]; sot: MatchLogRow[] }>> {
  const teams = TEAM_FBREF_IDS[leagueKey];
  if (!teams) {
    throw new Error(`[FBrefScraper] Unknown leagueKey "${leagueKey}". Known: ${Object.keys(TEAM_FBREF_IDS).join(', ')}`);
  }

  const results: Record<string, { cards: MatchLogRow[]; sot: MatchLogRow[] }> = {};

  if (cookieExpiredThisRun) {
    logger.warn('[FBrefScraper] Skipping league - cookie already confirmed expired earlier this run', { leagueKey });
    return results;
  }

  for (const [teamSlug, teamId] of Object.entries(teams)) {
    if (cookieExpiredThisRun) {
      logger.warn('[FBrefScraper] Stopping mid-league - cookie expired on a previous team this run', { leagueKey, teamSlug });
      break;
    }
    try {
      const cached = readTeamCache(leagueKey, teamSlug, season);
      if (cached) {
        logger.info('[FBrefScraper] Cache hit, skipping fetch', { leagueKey, teamSlug });
        results[teamSlug] = cached;
        continue;
      }
      const cards = await scrapeTeamCardsMatchlog(teamId, teamSlug, season);
      await sleep(REQUEST_DELAY_MS);

      const sot = await scrapeTeamSotMatchlog(teamId, teamSlug, season);
      await sleep(REQUEST_DELAY_MS);

      results[teamSlug] = { cards, sot };
      writeTeamCache(leagueKey, teamSlug, season, { cards, sot });
    } catch (err: any) {
      // Only a confirmed cookie expiry aborts the run; one-off network errors just skip that team.
      if (err && err.message && (err.message.includes('cookie has expired') || err.message.includes('HTTP error 403') || err.message.includes('HTTP error 429'))) {
        cookieExpiredThisRun = true;
        logger.warn('[FBrefScraper] Cookie expiry detected - aborting remaining teams/leagues for this run', { leagueKey, teamSlug });
        break;
      }
      console.error(`[fbrefScraper] Failed for ${leagueKey}/${teamSlug}:`, err);
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return results;
}
