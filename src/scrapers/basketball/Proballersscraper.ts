// src/scrapers/basketball/proballersScraper.ts
//
// Scrapes completed games from proballers.com's schedule page for
// international basketball leagues. Unlike football, ONE page type here
// covers everything the model needs — see reasoning below.
//
// Confirmed schedule URL pattern:
//   https://www.proballers.com/basketball/league/{leagueId}/{slug}/schedule
//
// Each row on that page contains: Date, Time (CET), Home team (name +
// profile link), Away team (name + profile link), Result (score + game
// link). From that alone we can derive everything modelBasketball() in
// probabilityModel.ts needs:
//   - form (W/L)              — compare home/away scores directly
//   - homePpgFor/homePpgAgainst — average scores over recent games
//   - h2h                     — filter the same page's games for any two
//                                specific teams' past meetings
//   - fatigueDays             — gap between a team's most recent game
//                                date and today (same technique realFetcher.ts
//                                already uses for WNBA/NBA)
//
// NOT derivable from this source (same as WNBA/NBA scrapers already
// accept — falls back to model defaults):
//   - pace       → defaults to 100 in modelBasketball()
//   - referee.avgFouls → no adjustment applied
//
// PARSING: uses cheerio (real DOM parsing), NOT regex. An earlier version
// used one large chained lazy-quantifier regex ([\s\S]*? repeated several
// times) across the full page HTML (600-700KB). That worked against the
// ACB page it was verified on, but hung indefinitely on other leagues'
// pages — confirmed via debug logging that the fetch completed fine (real
// bytes received) and the freeze was entirely inside the parse step:
// classic catastrophic regex backtracking, not a network or Cloudflare
// issue (separately confirmed: a real browser opens proballers.com with
// zero human-verification challenge). Cheerio walks the actual DOM tree
// instead, which has no backtracking risk regardless of page size or
// minor per-league markup differences.

import 'dotenv/config';
import * as cheerio from 'cheerio';
import { logger } from '../../core/utils/logger';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

const BASE = 'https://www.proballers.com';
const REQUEST_DELAY_MS = 1500; // politeness delay

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Confirmed IDs/slugs directly from https://www.proballers.com/page/7-leagues-we-cover
// Scoped to established senior domestic leagues with full seasons — excludes
// playoffs, U-age tournaments, qualifiers, and leagues too thin to matter.
export const PROBALLERS_LEAGUE_MAP: Record<string, { id: number; slug: string }> = {
  'ACB - Spain':              { id: 30,  slug: 'spain-liga-endesa' },
  'LBA Serie A - Italy':      { id: 40,  slug: 'italy-lba-serie-a' },
  'BSL - Turkey':             { id: 168, slug: 'turkey-bsl' },
  'NBL - Australia':          { id: 226, slug: 'australia-nbl' },
  'CBA - China':              { id: 159, slug: 'china-cba' },
  'BBL - Germany':            { id: 118, slug: 'germany-easycredit-bbl' },  // was missing trailing "l"
  'A1 - Greece':              { id: 50,  slug: 'greece-gbl' },              // was 'greece-heba-a1' — Proballers now lists this as GBL
  'Betclic Elite - France':   { id: 1,   slug: 'france-betclic-elite' },

  'Ethias League - Belgium':  { id: 141, slug: 'belgium-euromillions-basketball-league' },
  'Liga - Croatia':           { id: 185, slug: 'croatia-liga' },
  'Mattoni NBL - Czechia':    { id: 183, slug: 'czech-republic-mattoni-nbl' },
  'Winner League - Israel':   { id: 172, slug: 'israel-winner-league' },
  'Betsafe LKL - Lithuania':  { id: 200, slug: 'lithuania-betsafe-lkl' },
  'PLK - Poland':             { id: 170, slug: 'poland-plk' },
  'Liga Profissional - Portugal': { id: 139, slug: 'portugal-liga-profissional' },

  'Eredivisie - Netherlands': { id: 208, slug: 'netherlands-eredivisie' },
  'Superleague - Ukraine':    { id: 234, slug: 'ukraine-superleague' },

  'BLNO - Norway':            { id: 325, slug: 'norway-blno' },
  'Ligaen - Denmark':         { id: 238, slug: 'denmark-ligaen' },
  'NBL - Bulgaria':           { id: 186, slug: 'bulgaria-nbl' },
  'Liga A - Argentina':       { id: 188, slug: 'argentina-liga-a' },
  'BSN - Puerto Rico':        { id: 270, slug: 'puerto-rico-bsn' },
  'B1 League - Japan':        { id: 281, slug: 'japan-b1-league' },
  'Philippines - PBA':        { id: 357, slug: 'philippines-pba' },
  'Mexico - Liga SISNova LNBP': { id: 100035, slug: 'mexico-liga-sisnova-lnbp' },
  'A League - Serbia':        { id: 285, slug: 'serbia-kls' },              // was 'serbia-a-league'
  'Liga Nova KBM - Slovenia': { id: 173, slug: 'slovenia-liga-otp-banka' }, // was 'slovenia-liga-nova-kbm'
  'Basketligan - Sweden':     { id: 190, slug: 'sweden-basketligan' },      // was 'sweeden-basketligan' — my earlier "sic" note was wrong, no typo on Proballers' side
};

// ─── TYPES ──────────────────────────────────────────────────────────────

export interface ProballersGame {
  date: string;           // ISO yyyy-mm-dd
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  gameId: number;
  boxscoreUrl: string;    // relative path, e.g. /basketball/game/833570/unicaja-malaga-...
}

// ─── FETCH ──────────────────────────────────────────────────────────────

// ─── COOKIE SESSION (see conversation, 2026-09-25) ─────────────────
// proballers.com started returning HTTP 403 on every request during a
// refit run — same failure mode FBref hit, same fix: a manual
// cf_clearance cookie, solved by hand in a real browser, since this
// scraper's own header comment ("real browser opens proballers.com with
// zero human-verification challenge") is apparently no longer true.
// Set PROBALLERS_COOKIE and PROBALLERS_UA in .env before running
// anything in this file.
const PROBALLERS_COOKIE = process.env.PROBALLERS_COOKIE;
const PROBALLERS_UA = process.env.PROBALLERS_UA;

if (!PROBALLERS_COOKIE || !PROBALLERS_UA) {
  logger.warn(
    '[ProballersScraper] PROBALLERS_COOKIE and/or PROBALLERS_UA not set in .env — ' +
      'requests may fail with 403. Solve proballers.com\'s Cloudflare challenge ' +
      'manually (visit any proballers.com page in a real browser, open dev tools, ' +
      'copy the cf_clearance cookie value and your User-Agent string) and set both.'
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

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout — without this, a stalled response hangs forever
  try {
    const headers: Record<string, string> = { ...HEADERS };
    if (PROBALLERS_COOKIE) headers['Cookie'] = `cf_clearance=${PROBALLERS_COOKIE}`;
    if (PROBALLERS_UA) headers['User-Agent'] = PROBALLERS_UA;

    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

    const html = await res.text();

    if (looksLikeChallengePage(html)) {
      throw new Error(
        `Challenge page for ${url} — cookie has expired or your IP changed since ` +
          `solving it (or PROBALLERS_COOKIE/PROBALLERS_UA aren't set at all). Grab a fresh ` +
          `cf_clearance cookie and re-run.`
      );
    }

    return html;
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after 20s for ${url}`);
    const causeMsg = err.cause ? ` | cause: ${err.cause.message || err.cause}` : '';
    throw new Error(`${err.message}${causeMsg} | url: ${url}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ─── TEAM NAME ALIASES ─────────────────────────────────────────────────
//
// Confirmed 2026-08-18: proballers.com's own pages disagree with each
// other on team naming — fetchUpcomingGames() returned "Baskonia
// Vitoria-Gasteiz" while fetchLeagueSchedule() (historical results) used
// just "Baskonia" for the same club. Since buildTeamForm/headToHead do
// exact-string matching, this silently broke H2H/form lookups for any
// match involving Baskonia (found via checkTeamNameMismatch.ts diagnostic
// — the same team appeared once in each source's distinct-name list,
// never overlapping). Fixed at the SOURCE, in both parse functions below,
// so every downstream consumer (buildTeamForm, headToHead,
// findExistingMatch in proballersFixturesSync.ts) automatically sees one
// canonical name — no changes needed anywhere else.
//
// Add more entries here if the same class of mismatch turns up for other
// teams/leagues — canonicalize to whichever name form is shorter/more
// stable across seasons, matching the pattern below.
const TEAM_NAME_ALIASES: Record<string, string> = {
  'Baskonia Vitoria-Gasteiz': 'Baskonia',
};

function canonicalizeTeamName(name: string): string {
  return TEAM_NAME_ALIASES[name] ?? name;
}

// ─── PARSE (cheerio-based) ────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseDisplayDate(raw: string): string | null {
  // e.g. "Oct 4, 2025"
  const m = raw.match(/([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) return null;
  const [, monAbbr, dayStr, yearStr] = m;
  const month = MONTHS[monAbbr.toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(dayStr, 10);
  const year = parseInt(yearStr, 10);
  const dt = new Date(Date.UTC(year, month, day));
  return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0];
}

function parseSchedule(html: string): ProballersGame[] {
  const $ = cheerio.load(html);
  const games: ProballersGame[] = [];

  $('tr[itemtype="https://schema.org/SportsEvent"]').each((_i, el) => {
    const $row = $(el);

    // FIXED (see conversation): span[itemprop="startDate"] is now a <meta>
    // tag with no text and an unreliable content attribute (showed a
    // 2026 date on a 2024-season row). The real date is still plain text
    // at the end of the row's first <td> — parseDisplayDate's regex
    // finds it regardless of the surrounding whitespace/meta/link noise.
    const dateRaw = $row.find('td.left.first__left').first().text();
    const date = parseDisplayDate(dateRaw);

    const teamLinks = $row.find('a.list-team-entry');
    if (teamLinks.length < 2) return; // not a completed/valid row — skip

    const homeName = canonicalizeTeamName($(teamLinks[0]).find('span.title').first().text().trim());
    const awayName = canonicalizeTeamName($(teamLinks[1]).find('span.title').first().text().trim());

    // Result link: href starts with /basketball/game/{id}/... and text is "N-N"
    const resultLink = $row.find('a[href^="/basketball/game/"]').first();
    const boxscoreUrl = resultLink.attr('href') || '';
    const scoreText = resultLink.text().trim();
    const scoreMatch = scoreText.match(/^(\d+)\s*-\s*(\d+)$/);
    const gameIdMatch = boxscoreUrl.match(/\/basketball\/game\/(\d+)\//);

    if (!date || !homeName || !awayName || !scoreMatch || !gameIdMatch) return;

    games.push({
      date,
      homeTeam: homeName,
      awayTeam: awayName,
      homeScore: parseInt(scoreMatch[1], 10),
      awayScore: parseInt(scoreMatch[2], 10),
      gameId: parseInt(gameIdMatch[1], 10),
      boxscoreUrl,
    });
  });

  if (games.length === 0) {
    logger.warn('[ProballersScraper] Parsed 0 games — page markup may have changed since verification');
  } else {
    logger.info(`[ProballersScraper] Parsed ${games.length} games`);
  }

  return games;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────

export async function fetchLeagueSchedule(leagueName: string, seasonStartYear?: number): Promise<ProballersGame[]> {
  const league = PROBALLERS_LEAGUE_MAP[leagueName];
  if (!league) {
    logger.warn('[ProballersScraper] Unknown league', { leagueName });
    return [];
  }
  const seasonSuffix = seasonStartYear ? `/${seasonStartYear}` : '';
  const url = `${BASE}/basketball/league/${league.id}/${league.slug}/schedule${seasonSuffix}`;
  console.log(`  [debug] fetching ${url} ...`);
  const html = await fetchHtml(url);
  console.log(`  [debug] fetch complete, got ${html.length} bytes — starting parse...`);
  await sleep(REQUEST_DELAY_MS);
  const result = parseSchedule(html);
  console.log(`  [debug] parse complete, ${result.length} games`);
  return result;
}

// ─── DERIVED STATS (form / PPG / H2H / fatigue — all from one game list) ─

export interface TeamFormEntry {
  date: string;
  opponent: string;
  result: 'W' | 'L';
  pointsFor: number;
  pointsAgainst: number;
  venue: 'home' | 'away';
}

// Builds one team's game history from the full schedule, most-recent-first.
export function buildTeamForm(games: ProballersGame[], teamName: string): TeamFormEntry[] {
  const entries: TeamFormEntry[] = [];
  for (const g of games) {
    if (g.homeTeam === teamName) {
      entries.push({
        date: g.date, opponent: g.awayTeam,
        result: g.homeScore > g.awayScore ? 'W' : 'L',
        pointsFor: g.homeScore, pointsAgainst: g.awayScore, venue: 'home',
      });
    } else if (g.awayTeam === teamName) {
      entries.push({
        date: g.date, opponent: g.homeTeam,
        result: g.awayScore > g.homeScore ? 'W' : 'L',
        pointsFor: g.awayScore, pointsAgainst: g.homeScore, venue: 'away',
      });
    }
  }
  return entries.sort((a, b) => b.date.localeCompare(a.date)); // most recent first
}

// CHANGED (see conversation): flat last-10 average replaced with
// exponential decay (0.85^i) over the FULL form array — form here
// already carries the whole season (buildTeamForm applies no
// truncation), so this now uses all of it, weighted by recency, instead
// of hard-cutting at 10 and averaging those flat. Same decay pattern as
// nbaScraper.ts's buildForm / realFetcher.ts's rollingPpg fix, kept
// consistent across both leagues.
export function averagePpg(form: TeamFormEntry[], key: 'pointsFor' | 'pointsAgainst'): number {
  if (!form.length) return 80; // same fallback modelBasketball() already uses
  // form is sorted most-recent-first (see buildTeamForm) — i=0 is the most recent game.
  let weightSum = 0, valueSum = 0;
  form.forEach((e, i) => {
    const w = Math.pow(0.85, i);
    valueSum += e[key] * w;
    weightSum += w;
  });
  return valueSum / weightSum;
}

// ─── UPCOMING GAMES (unplayed fixtures — different markup from results) ──
//
// VERIFIED against real WNBA schedule content. Unplayed games use a
// DIFFERENT link pattern than completed ones: /basketball/game-preview/{id}/{slug}
// with link text "Game preview", instead of /basketball/game/{id}/{slug}
// with a score.

export interface ProballersUpcomingGame {
  date: string;           // ISO yyyy-mm-dd
  time: string | null;    // e.g. "5:00 PM" — raw as shown on the page, null if not parseable
  homeTeam: string;
  awayTeam: string;
  gameId: number;
  previewUrl: string;     // relative path, e.g. /basketball/game-preview/855282/...
}

function parseUpcomingSchedule(html: string): ProballersUpcomingGame[] {
  const $ = cheerio.load(html);
  const games: ProballersUpcomingGame[] = [];

  $('tr[itemtype="https://schema.org/SportsEvent"]').each((_i, el) => {
    const $row = $(el);

    // FIXED (see conversation): span[itemprop="startDate"] is now a <meta>
    // tag with no text and an unreliable content attribute (showed a
    // 2026 date on a 2024-season row). The real date is still plain text
    // at the end of the row's first <td> — parseDisplayDate's regex
    // finds it regardless of the surrounding whitespace/meta/link noise.
    const dateRaw = $row.find('td.left.first__left').first().text();
    const date = parseDisplayDate(dateRaw);

    const timeRaw = $row.find('td.left.second__left').first().text();
    const time = timeRaw ? timeRaw.replace(/&nbsp;|\u00A0/g, ' ').trim() : null;

    const teamLinks = $row.find('a.list-team-entry');
    if (teamLinks.length < 2) return;

    const homeName = canonicalizeTeamName($(teamLinks[0]).find('span.title').first().text().trim());
    const awayName = canonicalizeTeamName($(teamLinks[1]).find('span.title').first().text().trim());

    const previewLink = $row.find('a[href^="/basketball/game-preview/"]').first();
    const previewUrl = previewLink.attr('href') || '';
    const gameIdMatch = previewUrl.match(/\/basketball\/game-preview\/(\d+)\//);

    if (!date || !homeName || !awayName || !gameIdMatch) return;

    games.push({
      date,
      time: time || null,
      homeTeam: homeName,
      awayTeam: awayName,
      gameId: parseInt(gameIdMatch[1], 10),
      previewUrl,
    });
  });

  logger.info(`[ProballersScraper] Parsed ${games.length} upcoming games`);
  return games;
}

/**
 * Fetches upcoming/unplayed games for a league — i.e. what a live tip
 * scanner would actually run against, unlike fetchLeagueSchedule which
 * returns completed results only.
 */
export async function fetchUpcomingGames(leagueName: string): Promise<ProballersUpcomingGame[]> {
  const league = PROBALLERS_LEAGUE_MAP[leagueName];
  if (!league) {
    logger.warn('[ProballersScraper] Unknown league', { leagueName });
    return [];
  }
  const url = `${BASE}/basketball/league/${league.id}/${league.slug}/schedule`;
  const html = await fetchHtml(url);
  await sleep(REQUEST_DELAY_MS);
  return parseUpcomingSchedule(html);
}

export function headToHead(games: ProballersGame[], teamA: string, teamB: string): ProballersGame[] {
  return games.filter(
    g => (g.homeTeam === teamA && g.awayTeam === teamB) || (g.homeTeam === teamB && g.awayTeam === teamA)
  );
}

export function fatigueDays(form: TeamFormEntry[], asOfDate: string): number | undefined {
  if (!form.length) return undefined;
  const lastGame = form[0]; // most recent first
  const last = new Date(lastGame.date).getTime();
  const now = new Date(asOfDate).getTime();
  return Math.round((now - last) / (1000 * 60 * 60 * 24));
}

// ─── BOXSCORE (team-level FGA/FTA/ORB/DRB/TOV — for real pace/ORtg/DRtg) ──
//
// IMPORTANT — UNVERIFIED against real HTML (built from a markdown-rendered
// view of a boxscore page, not raw HTML — confirmed content but NOT
// confirmed exact tags/classes). Left as regex-based since it was already
// flagged unverified before the parseSchedule hang was found; if this
// hangs too once you start using it, apply the same cheerio-based fix.
//
// VERIFY BEFORE TRUSTING:
//   1. Invoke-WebRequest -Uri "https://www.proballers.com/basketball/game/833570/unicaja-malaga-surne-bilbao-2025-10-04" -OutFile boxscore-sample.html
//   2. Select-String -Path boxscore-sample.html -Pattern "Team stats" | Select-Object -First 1 -ExpandProperty LineNumber
//   3. Get-Content boxscore-sample.html | Select-Object -Skip (N-5) -First 40
//   4. Paste that snippet back so the regex below can be corrected against
//      the real table markup if it differs from what's assumed here.

export interface TeamBoxStats {
  team: string;
  fgm: number;
  fga: number;
  ftm: number;
  fta: number;
  orb: number;
  drb: number;
  reb: number;
  ast: number;
  tov: number;
  pts: number;
}

export interface GameBoxscore {
  gameId: number;
  home: TeamBoxStats;
  away: TeamBoxStats;
}

async function fetchGameBoxscore(boxscoreUrl: string, gameId: number): Promise<GameBoxscore | null> {
  const url = `${BASE}${boxscoreUrl}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const table = $('table[aria-label="Team stats"]').first();
  const headers = table.find('thead th').map((_i, th) => $(th).text().trim()).get();
  const teams: TeamBoxStats[] = [];

  table.find('tbody tr').each((_i, tr) => {
    const $tr = $(tr);
    const team = $tr.find('a.list-team-entry').attr('title')?.trim() || '';
    const cells = $tr.find('td').map((_j, td) => $(td).text().trim()).get();
    const get = (h: string): number => parseInt(cells[headers.indexOf(h)], 10);

    const stats: TeamBoxStats = {
      team,
      fgm: get('FGM'), fga: get('FGA'),
      ftm: get('FTM'), fta: get('FTA'),
      orb: get('Or'), drb: get('Dr'), reb: get('Reb'),
      ast: get('Ast'), tov: get('To'), pts: get('Pts'),
    };
    const threePm = get('3PM');
    const values = Object.values(stats).filter(v => typeof v === 'number') as number[];
    if (!team || values.some(isNaN) || isNaN(threePm)) return;
    // Integrity check: points must equal 2*FGM + 3PM + FTM
    if (2 * stats.fgm + threePm + stats.ftm !== stats.pts) {
      logger.warn('[ProballersScraper] Boxscore points integrity check failed', { gameId, team });
      return;
    }
    teams.push(stats);
  });

  if (teams.length !== 2) {
    logger.warn('[ProballersScraper] Boxscore parse did not find exactly 2 teams', { gameId, found: teams.length });
    return null;
  }

  return { gameId, home: teams[0], away: teams[1] };
}

// Standard possessions estimate: FGA - ORB + TOV + 0.44*FTA
function estimatePossessions(t: TeamBoxStats): number {
  return t.fga - t.orb + t.tov + 0.44 * t.fta;
}

export { fetchGameBoxscore, estimatePossessions };

// ─── QUICK TEST ─────────────────────────────────────────────────────────
// Allow running directly: npx ts-node src/scrapers/basketball/proballersScraper.ts

async function main() {
  const leagueName = 'ACB - Spain';
  console.log(`Fetching schedule for ${leagueName}...`);

  const games = await fetchLeagueSchedule(leagueName);
  console.log(`\nTotal games parsed: ${games.length}`);

  console.log('\nFirst 5 games:');
  games.slice(0, 5).forEach(g => {
    console.log(`  ${g.date} | ${g.homeTeam} ${g.homeScore}-${g.awayScore} ${g.awayTeam}`);
  });

  console.log('\nLast 5 games:');
  games.slice(-5).forEach(g => {
    console.log(`  ${g.date} | ${g.homeTeam} ${g.homeScore}-${g.awayScore} ${g.awayTeam}`);
  });

  if (games.length > 0) {
    const sampleTeam = games[0].homeTeam;
    const form = buildTeamForm(games, sampleTeam);
    console.log(`\nSample derived stats for "${sampleTeam}":`);
    console.log(`  Games found: ${form.length}`);
    console.log(`  Avg PPG for (last 10): ${averagePpg(form, 'pointsFor').toFixed(1)}`);
    console.log(`  Avg PPG against (last 10): ${averagePpg(form, 'pointsAgainst').toFixed(1)}`);

    if (games.length > 1) {
      const opponent = games[1].homeTeam !== sampleTeam ? games[1].homeTeam : games[1].awayTeam;
      const h2h = headToHead(games, sampleTeam, opponent);
      console.log(`  H2H vs ${opponent}: ${h2h.length} past meeting(s)`);
    }
  }

  // ── Boxscore test (UNVERIFIED regex — see comment above fetchGameBoxscore) ──
  if (games.length > 0) {
    const sample = games[0];
    console.log(`\nFetching boxscore for ${sample.homeTeam} vs ${sample.awayTeam} (${sample.date})...`);
    try {
      const box = await fetchGameBoxscore(sample.boxscoreUrl, sample.gameId);
      if (box) {
        console.log('  Boxscore parsed successfully:');
        console.log(`    ${box.home.team}: FGA=${box.home.fga} FTA=${box.home.fta} ORB=${box.home.orb} TOV=${box.home.tov} PTS=${box.home.pts}`);
        console.log(`    ${box.away.team}: FGA=${box.away.fga} FTA=${box.away.fta} ORB=${box.away.orb} TOV=${box.away.tov} PTS=${box.away.pts}`);
        console.log(`    Est. possessions — home: ${estimatePossessions(box.home).toFixed(1)}, away: ${estimatePossessions(box.away).toFixed(1)}`);
      } else {
        console.log('  Boxscore parse FAILED — regex does not match real markup. See verification steps in the code comment above fetchGameBoxscore.');
      }
    } catch (err: any) {
      console.log(`  Boxscore fetch error: ${err.message}`);
    }
  }

  // ── Upcoming-games parser test (WNBA — verification only, in-season) ──
  console.log('\nTesting upcoming-games parser against WNBA (verification only, in-season)...');
  try {
    const wnbaUrl = `${BASE}/basketball/league/397/wnba/schedule`;
    const wnbaHtml = await fetchHtml(wnbaUrl);
    const upcoming = parseUpcomingSchedule(wnbaHtml);
    console.log(`  Parsed ${upcoming.length} upcoming games`);
    upcoming.slice(0, 5).forEach(g => {
      console.log(`    ${g.date} | ${g.homeTeam} vs ${g.awayTeam} (gameId ${g.gameId})`);
    });
    if (upcoming.length === 0) {
      console.log('  0 upcoming games found — parser may need adjustment. Check real markup again.');
    }
  } catch (err: any) {
    console.log(`  Upcoming-games test error: ${err.message}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[ProballersScraper] Fatal error:', err.message);
    process.exit(1);
  });
}