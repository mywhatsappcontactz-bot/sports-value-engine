// src/scrapers/darts/dartsDatabaseScraper.ts
//
// Primary darts data source — dartsdatabase.co.uk. Free, plain HTML,
// no Cloudflare/bot-blocking (confirmed by direct fetch). Covers ALL
// PDC events (majors + regular Pro Tour/Euro Tour), not just majors.
//
// CONFIRMED LIVE (fetched directly this session):
//   - Homepage (https://www.dartsdatabase.co.uk/) — nav structure,
//     "Today's Games" section, day navigation via ?day=-1/0/1
//   - player-profile-live.php?pid=X — career + current-year stats
//   - display-event.php?eid=X&tna=...&eda=... — per-match results
//     with 3-dart average per player (confirmed via a real
//     PDPA Players Championship 24 page, NOT just majors, AND via a
//     real fetch of the 2025 World Grand Prix event page — eid=25630 —
//     which confirmed the same "PlayerName (avg) N V M PlayerName (avg)"
//     shape holds for sets-format majors too, not just legs-format
//     Pro Tour events)
//   - tournament-history.php?tid=X&tna=... — full year-by-year winner
//     history for a named tournament (confirmed via World Grand Prix,
//     tid=14 — every edition from 1998-2025 listed with a working
//     display-event.php?eid= link, except 2020 which is missing from
//     the table for unknown reasons — worth checking directly if 2020
//     data is ever needed)
//
// NOT YET CONFIRMED (structure below is a best-effort guess pending
// a real fetch + verification, same as any new scraper — expect to
// need a debug/inspection pass similar to what we did for FCStats
// league IDs before trusting this in production):
//   - set-head-2-head.php?p1id=X&p1na=Name — URL confirmed to EXIST
//     (seen as a real link on the player profile page), but its
//     actual page content/HTML structure has not been fetched or
//     parsed yet.
//   - Fixtures/schedule page structure for a day with actual games
//     scheduled (homepage showed "No games scheduled for this day"
//     on the day we checked — need a live matchday to confirm markup).
//
// Given the above, treat this file as a first pass: run the debug
// pattern (view raw HTML around real matches) before trusting
// fetchH2H() or fetchFixtures() results in the actual pipeline.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

const BASE = 'https://www.dartsdatabase.co.uk';

// ─── CLOUDFLARE BYPASS ────────────────────────────────────────────────────────
// CONFIRMED this session: dartsdatabase.co.uk is behind Cloudflare's
// interactive JS challenge (Turnstile) — a plain fetch() with a normal
// browser User-Agent gets HTTP 403 with cf-mitigated: challenge and a
// "Just a moment..." body, on BOTH player-profile-live.php AND
// display-event.php. This contradicts the earlier "no Cloudflare/bot-
// blocking" note at the top of this file — that confirmation was accurate
// for whatever fetched it at the time, but is not holding for a plain
// Node fetch() today.
//
// FIX: uses fetchViaDartsDatabase() from the new
// src/scrapers/shared/dartsDatabaseFetch.ts — same manual-cookie-session
// pattern already established in this codebase for soccerstats.com
// (flareFetch.ts) and eliteprospects.com (eliteProspectsFetch.ts): a
// human solves the Cloudflare challenge once in a real browser, the
// resulting cf_clearance cookie + exact User-Agent get reused for plain
// fetches until the cookie expires (~30-45 min, same as the other two
// sites). See that file for the full mechanism, throttling, and
// challenge-page detection.
//
// Set DARTSDATABASE_COOKIE (the raw cf_clearance token value ONLY — not
// the full cookie string, not "cf_clearance=" prefix, just the token
// itself) and DARTSDATABASE_UA (must exactly match whatever browser
// solved the challenge) in .env before using any function in this file.
import { fetchViaDartsDatabase } from '../shared/dartsDatabaseFetch';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface DartsPlayerStats {
  pid:            string;
  name:           string;
  careerAverage:  number;
  currentAverage: number;
  careerGamesWon: number;
  careerGamesPlayed: number;
  careerWinPct:   number;
  currentGamesWon: number;
  currentGamesPlayed: number;
  currentWinPct:  number;
  nineDarters:    number;
}

export interface DartsFixture {
  eventId:    string;
  eventName:  string;
  date:       string;
  player1:    string;
  player2:    string;
  round:      string | null;
}

export interface DartsMatchResult {
  player1:     string;
  player2:     string;
  player1Avg:  number | null;
  player2Avg:  number | null;
  player1Legs: number;
  player2Legs: number;
  round:       string | null;
}

export interface DartsEventResults {
  eventId:    string;
  eventName:  string;
  date:       string;
  matches:    DartsMatchResult[];
}

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
// Player career/current stats change slowly (once per completed match) —
// safe to cache for a day. Fixtures need to be fresh — short TTL.
// H2H history is effectively static between two specific players outside
// of new meetings — cache longer, same reasoning as FDCO's 3-day TTL.

const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');
const PLAYER_CACHE_TTL_MS  = 24 * 60 * 60 * 1000;      // 24 hours
const FIXTURE_CACHE_TTL_MS = 60 * 60 * 1000;           // 1 hour
const EVENT_CACHE_TTL_MS   = 24 * 60 * 60 * 1000;      // 24 hours (completed events don't change)

function cachePath(prefix: string, key: string): string {
  const safe = key.replace(/[^a-z0-9]/gi, '_').toLowerCase();
  return path.join(CACHE_DIR, `darts-${prefix}-${safe}.json`);
}

function readCache<T>(prefix: string, key: string, ttlMs: number): T | null {
  try {
    const p = cachePath(prefix, key);
    if (!fs.existsSync(p)) return null;
    const entry: { data: T; fetchedAt: number } = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (Date.now() - entry.fetchedAt >= ttlMs) return null;
    return entry.data;
  } catch {
    return null;
  }
}

function writeCache<T>(prefix: string, key: string, data: T): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cachePath(prefix, key), JSON.stringify({ data, fetchedAt: Date.now() }), 'utf-8');
  } catch (err: any) {
    logger.warn('[DartsDB] Failed to write cache', { prefix, key, error: err.message });
  }
}

// ─── HTTP HELPER ─────────────────────────────────────────────────────────────

// fetchHtml() now just delegates to the shared per-site fetch file (see
// import above) — throttling, Cloudflare challenge detection, and error
// messaging all live there, matching how eliteprospects.com/
// soccerstats.com are handled elsewhere in this codebase. Kept as a
// thin wrapper (rather than calling fetchViaDartsDatabase directly at
// every call site) so the rest of this file didn't need touching beyond
// this one function.
async function fetchHtml(url: string): Promise<string> {
  return fetchViaDartsDatabase(url);
}

// ─── NAME MATCHING (same pattern as fcStatsScraper) ──────────────────────────
// Currently unused now that live search/H2H are gone — kept for when
// PLAYER_ID_MAP is built, to fuzzy-match odds/fixture player names
// (which may have slightly different formatting) against map keys.

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function similarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const intersection = [...ta].filter(t => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  return union === 0 ? 0 : intersection / union;
}

// ─── PLAYER STATS ─────────────────────────────────────────────────────────────
// Confirmed structure from player-profile-live.php?pid=3097 (Gabriel Clemens):
//   "Games Won  ### from ### played" / "Winning Pct  ##.##%" / "Average  ##.##"
//   appears TWICE — once under "Career Statistics", once under
//   "Current Years Statistics". Parsing pulls both blocks in document order.

export async function fetchPlayerStats(pid: string): Promise<DartsPlayerStats | null> {
  const cached = readCache<DartsPlayerStats>('player', pid, PLAYER_CACHE_TTL_MS);
  if (cached) {
    logger.info('[DartsDB] Player cache hit', { pid });
    return cached;
  }

  try {
    const html = await fetchHtml(`${BASE}/player-profile-live.php?pid=${pid}`);

    const nameMatch = /<title>([^|<]+?) Player Profile<\/title>/i.exec(html);
    const name = nameMatch ? nameMatch[1].trim() : `Player ${pid}`;

    // Pulls "Games Won ### from ### played", "Winning Pct ##.##%", "Average ##.##"
    // — appears once for Career, once for Current Year, in that document order.
    const gamesWonBlocks = [...html.matchAll(/Games Won[\s\S]{0,60}?(\d+)\s*from\s*(\d+)\s*played/gi)];
    const winPctBlocks   = [...html.matchAll(/Winning Pct[\s\S]{0,60}?([\d.]+)%/gi)];
    const avgBlocks      = [...html.matchAll(/Average[\s\S]{0,60}?([\d.]+)/gi)];
    const nineDartMatch  = /9 Darters[\s\S]{0,60}?(\d+)/i.exec(html);

    if (gamesWonBlocks.length < 2 || avgBlocks.length < 2) {
      logger.warn('[DartsDB] Could not parse expected career+current stat blocks', { pid, name });
      return null;
    }

    const stats: DartsPlayerStats = {
      pid,
      name,
      careerGamesWon:     parseInt(gamesWonBlocks[0][1], 10),
      careerGamesPlayed:  parseInt(gamesWonBlocks[0][2], 10),
      careerWinPct:       parseFloat(winPctBlocks[0]?.[1] ?? '0'),
      careerAverage:      parseFloat(avgBlocks[0][1]),
      currentGamesWon:    parseInt(gamesWonBlocks[1][1], 10),
      currentGamesPlayed: parseInt(gamesWonBlocks[1][2], 10),
      currentWinPct:      parseFloat(winPctBlocks[1]?.[1] ?? '0'),
      currentAverage:     parseFloat(avgBlocks[1][1]),
      nineDarters:        nineDartMatch ? parseInt(nineDartMatch[1], 10) : 0,
    };

    writeCache('player', pid, stats);
    return stats;

  } catch (err: any) {
    logger.error('[DartsDB] Player fetch failed', { pid, error: err.message });
    return null;
  }
}

// ─── H2H — NOT SOURCED FROM THIS SITE ────────────────────────────────────────
// dartsdatabase.co.uk's own H2H search (set-head-2-head.php) was tested
// three separate times (different field names, different encodings) and
// consistently returned an unrelated static block (World Cup of Darts
// doubles-team pairings) regardless of the search input. This isn't a
// parsing bug on our end — the endpoint itself doesn't appear to filter
// by the posted player name in practice.
//
// INSTEAD: build H2H yourself from accumulated fetchEventResults() data.
// Every scan stores match results (player names, scores, dates) via
// upsertStats-style persistence, same pattern as football's FDCO/FCStats
// H2H (computed from stored match history, not a live third-party lookup).
// Once enough events have been scraped over time, a simple query — "find
// all stored matches where both of these player names appear" — gives
// you real H2H without depending on this site's broken search feature.
// This is arguably more robust: it's self-building and never depends on
// dartsdatabase.co.uk staying correct.
//
// See src/core/engine/ (wherever football's H2H-from-history logic lives)
// for the equivalent pattern to replicate here once darts match storage
// is wired into the database.

// ─── EVENT RESULTS ────────────────────────────────────────────────────────────
// Confirmed structure from TWO real display-event.php pages:
//   1. PDPA Players Championship 24 (07/07/2026, legs-format Pro Tour event):
//      rows of "PlayerA (avg)   N V M   PlayerB (avg)"
//      e.g. "Mickey Mansell (91.61)  6 V 4  Mike de Decker (91.68)"
//      No round labels were visible in that pasted sample (flat "Last 128"
//      heading covers a whole round).
//   2. World Grand Prix 2025 (eid=25630, sets-format major): SAME row
//      shape confirmed again — "Luke Humphries (87.64)  2 V 0  Nathan
//      Aspinall (80.83)" — with round headers this time: "Last 32",
//      "Last 16", "Quarter Final", "Semi Final", "Final". Confirms the
//      match-row regex generalizes across both legs-format Pro Tour
//      events AND sets-format majors without changes.
//
// ROUND HEADER FIX (this session): the real WGP page renders "Quarter
// Final" / "Semi Final" — space, not hyphen, singular not plural — not
// "Quarter-Finals" / "Semi-Finals" as originally assumed from the PC24
// sample alone (which never reached those rounds in the pasted excerpt).
// The regex below now accepts both stylings.

export async function fetchEventResults(eventId: string, eventName: string = '', date: string = ''): Promise<DartsEventResults | null> {
  const cached = readCache<DartsEventResults>('event', eventId, EVENT_CACHE_TTL_MS);
  if (cached) {
    logger.info('[DartsDB] Event cache hit', { eventId });
    return cached;
  }

  try {
    const url = `${BASE}/display-event.php?eid=${eventId}`;
    const html = await fetchHtml(url);

    // REWRITTEN this session against REAL raw HTML (confirmed via a
    // direct debug fetch of eid=25630 — the 2025 World Grand Prix page).
    // The previous single-line regex assumed the shape
    // "PlayerName (avg) N V M PlayerName (avg)" with no markup between
    // any of those pieces — true of the RENDERED, tag-stripped text a
    // browser shows, but NOT true of the raw HTML this scraper actually
    // fetches. Real structure, confirmed:
    //
    //   <tr class="match-row">
    //     <td ...><a href="player-profile-live.php?pid=11822" class="w3-text-orange">
    //         Luke Humphries                    </a>
    //       <br />(87.64)                </td>
    //     <td ...>2&nbsp;V&nbsp;0                </td>
    //     <td ...><a href="player-profile-live.php?pid=13326" class="w3-text-orange">
    //         Nathan Aspinall                    </a>
    //       <br />(80.83)                </td>
    //   </tr>
    //
    // The old regex found ZERO matches against this real markup (5/5 WGP
    // event pages fetched successfully but parsed 0 matches each) —
    // this was a genuine parsing bug, not a Cloudflare/fetch problem.
    //
    // NOTE: this also confirms each player's dartsdatabase.co.uk pid is
    // directly present in event page HTML (pid=11822, pid=13326 above).
    // NOT currently captured into DartsMatchResult (would be a type/
    // schema change affecting dartsMatchStore.ts and dartsBacktest.ts
    // too) — flagged as a real future option (could reduce/eliminate
    // manual PLAYER_ID_MAP maintenance by harvesting pids directly from
    // scanned events) but deliberately out of scope for this fix.
    const rowRegex = /<tr class="match-row">([\s\S]*?)<\/tr>/g;
    const nameRegex = /class="w3-text-orange">\s*([^<]+?)\s*<\/a>/g;
    const avgRegex = /\(([\d.]+)\)/g;
    const scoreRegex = /(\d+)&nbsp;V&nbsp;(\d+)/;

    // Round headers appear as plain visible text (e.g. "Last 32",
    // "Quarter Final") somewhere in the surrounding markup — this part
    // of the old logic is UNCHANGED and still valid, since a substring
    // search doesn't care whether tags sit around the text it's looking
    // for, unlike the old per-match regex which needed strict adjacency.
    const roundHeaderRegex = /(Last \d+|Quarter[\s-]?Finals?|Semi[\s-]?Finals?|Final)/gi;

    const matches: DartsMatchResult[] = [];
    let rowMatch;

    while ((rowMatch = rowRegex.exec(html)) !== null) {
      const rowHtml = rowMatch[1];

      const names = [...rowHtml.matchAll(nameRegex)].map(m => m[1].trim());
      const avgs = [...rowHtml.matchAll(avgRegex)].map(m => parseFloat(m[1]));
      const scoreMatch = scoreRegex.exec(rowHtml);

      if (names.length < 2 || avgs.length < 2 || !scoreMatch) {
        logger.debug('[DartsDB] Skipped a match-row block that did not have the expected 2 names / 2 averages / 1 score — markup may have a variant shape not yet seen', {
          eventId,
          namesFound: names.length,
          avgsFound: avgs.length,
          scoreFound: !!scoreMatch,
          rowSnippet: rowHtml.slice(0, 1200),
        });
        continue;
      }

      // Round: find the nearest preceding round-header TEXT (not
      // tag-anchored) before this row started in the full document.
      const precedingText = html.slice(0, rowMatch.index);
      const roundMatches = [...precedingText.matchAll(roundHeaderRegex)];
      const currentRound = roundMatches.length ? roundMatches[roundMatches.length - 1][1] : null;

      matches.push({
        player1: names[0],
        player2: names[1],
        player1Avg: avgs[0],
        player2Avg: avgs[1],
        player1Legs: parseInt(scoreMatch[1], 10),
        player2Legs: parseInt(scoreMatch[2], 10),
        round: currentRound,
      });
    }

    if (matches.length === 0) {
      logger.warn('[DartsDB] No matches parsed from event page', { eventId });
      return null;
    }

    const result: DartsEventResults = {
      eventId,
      eventName,
      date,
      matches,
    };

    writeCache('event', eventId, result);
    return result;

  } catch (err: any) {
    logger.error('[DartsDB] Event fetch failed', { eventId, error: err.message });
    return null;
  }
}

// ─── FIXTURES ─────────────────────────────────────────────────────────────────
// UNVERIFIED STRUCTURE — homepage showed "Today's Games" section but the
// day we checked had "No games scheduled for this day", so the markup
// for an ACTUAL scheduled fixture has not been seen. dayOffset uses the
// confirmed ?day=-1/0/1 query param pattern from the homepage links.
//
// TODO before production use: fetch this on a day with real fixtures
// scheduled and rewrite the regex against actual markup.

export async function fetchFixtures(dayOffset: number = 0): Promise<DartsFixture[]> {
  const cacheKey = `day_${dayOffset}`;
  const cached = readCache<DartsFixture[]>('fixtures', cacheKey, FIXTURE_CACHE_TTL_MS);
  if (cached) {
    logger.info('[DartsDB] Fixtures cache hit', { dayOffset });
    return cached;
  }

  try {
    const url = `${BASE}/?day=${dayOffset}`;
    const html = await fetchHtml(url);

    if (html.includes('No games scheduled for this day')) {
      logger.info('[DartsDB] No fixtures scheduled', { dayOffset });
      writeCache('fixtures', cacheKey, []);
      return [];
    }

    // PLACEHOLDER PARSE — unverified against a real matchday. Best guess
    // based on the event-link pattern seen elsewhere on the site
    // (display-event.php?eid=X&tna=...&eda=...).
    const fixtureRegex = /display-event\.php\?eid=(\d+)&tna=([^&]+)&eda=(\d+)/g;

    const fixtures: DartsFixture[] = [];
    let m;
    while ((m = fixtureRegex.exec(html)) !== null) {
      const [, eid, tna, eda] = m;
      fixtures.push({
        eventId: eid,
        eventName: decodeURIComponent(tna.replace(/\+/g, ' ')),
        date: eda,
        player1: '', // not extractable from this pattern alone — needs real markup
        player2: '',
        round: null,
      });
    }

    if (fixtures.length === 0) {
      logger.warn('[DartsDB] Fixtures page had content but no matches parsed — parser needs adjustment', { dayOffset });
    }

    writeCache('fixtures', cacheKey, fixtures);
    return fixtures;

  } catch (err: any) {
    logger.error('[DartsDB] Fixtures fetch failed', { dayOffset, error: err.message });
    return [];
  }
}

// ─── TOURNAMENT HISTORY (winner list, all editions) ──────────────────────────
// Confirmed structure from tournament-history.php?tid=14&tna=World%20Grand%20Prix
// (World Grand Prix): one row per year, each with a working
// display-event.php?eid=X&tna=...&eda=YYYY link plus winner/runner-up
// pids and names. This is how historical eid values for a named
// tournament are discovered — there's no need to guess or increment eid
// numbers; this page lists them directly, going back to 1998 for WGP
// (2020 missing from the table for unknown reasons — not investigated).
//
// NOT YET WIRED IN AS A LIVE FUNCTION — the eid values below were read
// off this page manually this session for World Grand Prix specifically.
// If other tournaments' historical eids are needed later, fetch their
// own tid via the same tournament-history.php pattern (tid is specific
// per tournament name, e.g. World Grand Prix = 14 — do not assume other
// majors share nearby tid numbers without checking).
export const WORLD_GRAND_PRIX_HISTORICAL_EIDS: { year: number; eid: string }[] = [
  { year: 2025, eid: '25630' },
  { year: 2024, eid: '25180' },
  { year: 2023, eid: '25437' },
  { year: 2022, eid: '25013' },
  { year: 2021, eid: '24984' },
  // Earlier editions exist back to 1998 (see tournament-history.php?tid=14)
  // but player pools that far back are mostly retired/inactive — not
  // included here since the current backtest scope is "recent enough to
  // be relevant to today's PLAYER_ID_MAP", not "every edition ever".
];

// ─── PLAYER SEARCH — NOT VIABLE VIA PLAIN FETCH ──────────────────────────────
// player-searcher.php's results render into <div id="player-results"></div>
// via client-side JS/AJAX after page load — confirmed empty in the raw
// server response. A plain fetch() only gets the empty shell, never the
// actual matching players.
//
// PRACTICAL WORKAROUND: maintain a static PLAYER_ID_MAP (name → pid) for
// your known player pool — realistic for darts since the active PDC Tour
// Card holder pool is small (~100-150 players), unlike thousands of
// footballers across many leagues. Populate this map manually/incrementally
// as new player names appear in fixtures/event results — pid only needs
// to be looked up once per player, ever, since it's a permanent site ID.
//
// Example:
// export const PLAYER_ID_MAP: Record<string, string> = {
//   'gabriel clemens': '3097',
//   // add pids as you encounter new players in fixtures/events
// };
//
// If a name isn't in the map yet, fetchPlayerStats() simply can't run for
// that player until a pid is added — a manageable gap, not a blocker,
// since fetchEventResults() (fixtures/scores) doesn't need a pid at all.