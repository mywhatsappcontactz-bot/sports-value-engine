// src/scrapers/tennis/tennisFixturesScraper.ts
//
// Reads upcoming ATP/WTA singles fixtures from tennisexplorer.com's
// matches page. Unlike soccerstats.com/fcstats.com, this site has NO
// Cloudflare protection — confirmed via plain fetch() against the live
// page (no cookie, no challenge, real-time date confirmed via the
// "next day" pagination link matching the actual current date).
//
// PURPOSE: neither existing tennis file (tennisAbstractScraper.ts,
// matchStatScraper.ts) can discover fixtures — both require you to
// already know two player names to compare. This file is what's been
// missing: it produces the actual match list (who's playing whom, when,
// what tournament) that tennisAbstractScraper.ts can then be pointed at.
//
// Row structure confirmed against live HTML 2026-08-29:
//
//   <tr class="head flags">
//     <td class="t-name" colspan="2">
//       <a href="/utr-pro-tennis-series-3/2026/atp-men/">
//         <span class="fl fl-us">&nbsp;</span>
//         <span class="type-men2">&nbsp;</span>
//         UTR Pro Tennis Series 3
//       </a>
//     </td>
//     ...
//   </tr>
//   <tr id="s10" class="one fRow bott" onmouseover=... onmouseout=...>
//     <td class="first time" rowspan="2">03:30</td>
//     <td class="t-name"><a href="/player/gordon-95c75/">Gordon A.</a></td>
//     ...
//     <td rowspan="2"><a href="/match-detail/?id=3307015" title="...">info</a></td>
//   </tr>
//   <tr id="s10b" class="one" onmouseover=... onmouseout=...>
//     <td class="t-name"><a href="/player/djakouris-d0c41/">Djakouris C.</a></td>
//     ...
//   </tr>
//
// Every match is TWO consecutive <tr> rows sharing the numeric id prefix
// (s10 / s10b) — kickoff time and the match-detail link only appear on
// the first row (rowspan="2"), player names appear once per row.
//
// Player names on this site are abbreviated ("Gordon A.", last name +
// first initial) — NOT the same format tennisAbstractScraper.ts expects
// (full names, converted via toAbstractName()). Matching these to full
// names for the H2H lookup is a known gap — see note on fetchTodaysFixtures'
// return type below.
//
// IMPORTANT — same-day coverage gap (found 2026-08-31): matches on this
// site flip from scheduled ("s"-prefixed) rows to result ("r"-prefixed)
// rows the moment they start, and disappear from fetchTodaysFixtures()
// output entirely once they have. Confirmed live: US Open's block had
// 0 scheduled rows / 22 result rows by the time a same-day sync ran —
// a full day's slate of tour-level matches silently missed, while
// later-starting lower-tier events (UTR) still showed up. fetchTomorrowsFixtures()
// below pulls the next day's page instead, which cannot have started yet,
// as a safety net — call both, don't rely on fetchTodaysFixtures() alone
// for majors or any event with matches starting throughout the day.

import { logger } from '../../core/utils/logger';

const BASE = 'https://www.tennisexplorer.com';

// tennisexplorer.com's own type= query param values — singles only for
// now (doubles form/H2H isn't meaningfully comparable the same way).
export const TENNIS_TOUR_TYPES = {
  atp: 'atp-single',
  wta: 'wta-single',
} as const;

export type TennisTour = keyof typeof TENNIS_TOUR_TYPES;

export interface TennisFixture {
  player1Name: string;   // abbreviated form as shown on site, e.g. "Gordon A."
  player1Slug: string;   // e.g. "gordon-95c75" — stable per-player id
  player2Name: string;
  player2Slug: string;
  tournament: string;
  tournamentSlug: string; // e.g. "utr-pro-tennis-series-3"
  tour: TennisTour;
  startTimeRaw: string;   // site's own local time, e.g. "03:30" — no
                           // date attached at row level; see fetchTodaysFixtures
                           // for how the date is determined
  sourceMatchId: string;  // tennisexplorer's own numeric match id
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// ─── PARSER ──────────────────────────────────────────────────────────────────
//
// Two-pass: first locate every tournament header and its slug/name,
// then within each tournament's HTML segment (from its header to the
// next header, or end of page), extract every match row-pair.

interface TournamentBlock {
  name: string;
  slug: string;
  tour: TennisTour | null; // null if the URL doesn't match atp-men/wta-women
  startIdx: number;
  endIdx: number;
}

function detectTour(tournamentUrlPath: string): TennisTour | null {
  if (tournamentUrlPath.includes('atp-men')) return 'atp';
  if (tournamentUrlPath.includes('wta-women')) return 'wta';
  return null; // doubles, juniors, etc. — not handled yet
}

function findTournamentBlocks(html: string): TournamentBlock[] {
  const headerRegex =
    /<tr class="head flags">\s*<td class="t-name" colspan="2"><a href="\/([^"]+)\/2026\/([^"]+)\/">(?:<span[^>]*>&nbsp;<\/span>\s*){0,2}([^<]+)<\/a>/g;

  const headerHits: { slug: string; tourPath: string; name: string; idx: number }[] = [];
  let m: RegExpExecArray | null;

  while ((m = headerRegex.exec(html)) !== null) {
    headerHits.push({
      slug: m[1],
      tourPath: m[2],
      name: m[3].trim(),
      idx: m.index,
    });
  }

  const blocks: TournamentBlock[] = [];
  for (let i = 0; i < headerHits.length; i++) {
    const hit = headerHits[i];
    const endIdx = i + 1 < headerHits.length ? headerHits[i + 1].idx : html.length;
    blocks.push({
      name: hit.name,
      slug: hit.slug,
      tour: detectTour(hit.tourPath),
      startIdx: hit.idx,
      endIdx,
    });
  }

  return blocks;
}

// Matches ONE full row-pair (player1 row + player2 row) within a
// tournament's HTML segment. Anchored on the shared "sN" / "sNb" id
// pair so a mismatched row can never bleed into the wrong match.
const MATCH_PAIR_REGEX =
  /<tr id="s(\d+)"[^>]*>\s*<td class="first time"[^>]*>([\d:]+)<\/td>\s*<td class="t-name"><a href="\/player\/([^\/]+)\/">([^<]+)<\/a><\/td>[\s\S]*?<td rowspan="2"><a href="\/match-detail\/\?id=(\d+)"[^>]*>info<\/a><\/td>\s*<\/tr>\s*<tr id="s\1b"[^>]*>\s*<td class="t-name"><a href="\/player\/([^\/]+)\/">([^<]+)<\/a><\/td>/g;

function parseTournamentBlock(html: string, block: TournamentBlock): TennisFixture[] {
  if (!block.tour) return []; // skip doubles/juniors/unrecognized tour types

  const segment = html.slice(block.startIdx, block.endIdx);
  const fixtures: TennisFixture[] = [];

  let m: RegExpExecArray | null;
  MATCH_PAIR_REGEX.lastIndex = 0; // reset shared regex state between blocks
  while ((m = MATCH_PAIR_REGEX.exec(segment)) !== null) {
    const [, , timeRaw, p1Slug, p1Name, matchId, p2Slug, p2Name] = m;

    fixtures.push({
      player1Name: p1Name.trim(),
      player1Slug: p1Slug,
      player2Name: p2Name.trim(),
      player2Slug: p2Slug,
      tournament: block.name,
      tournamentSlug: block.slug,
      tour: block.tour,
      startTimeRaw: timeRaw,
      sourceMatchId: matchId,
    });
  }

  return fixtures;
}

// Shared by fetchTodaysFixtures/fetchTomorrowsFixtures — fetches a given
// tennisexplorer.com matches URL and runs it through the same
// findTournamentBlocks/parseTournamentBlock pipeline.
async function fetchFixturesFromUrl(
  url: string,
  tour: TennisTour,
  logLabel: string,
): Promise<TennisFixture[]> {
  try {
    const html = await fetchHtml(url);
    const blocks = findTournamentBlocks(html);

    const fixtures: TennisFixture[] = [];
    for (const block of blocks) {
      fixtures.push(...parseTournamentBlock(html, block));
    }

    if (fixtures.length === 0) {
      logger.warn(`[TennisFixtures] Parsed 0 fixtures (${logLabel}) — possible markup change or genuinely empty day`, { tour });
    } else {
      logger.info(`[TennisFixtures] Parsed ${fixtures.length} fixtures (${logLabel}) for ${tour}`, {
        tournaments: blocks.filter(b => b.tour).length,
      });
    }

    return fixtures;
  } catch (err: any) {
    logger.error(`[TennisFixtures] Fetch failed (${logLabel})`, { tour, error: err.message });
    return [];
  }
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Fetches today's fixtures for a given tour (ATP or WTA singles).
 *
 * NOTE: no persistent file cache yet (unlike the football scrapers) —
 * this site has no rate-limit risk (no Cloudflare, no cookie to
 * protect), so caching wasn't prioritized for the first version. Add
 * one later if this ends up being called often enough to matter.
 *
 * NOTE: subject to the same-day coverage gap described in the file
 * header — matches that have already started by the time this runs
 * will NOT appear in the result. Call fetchTomorrowsFixtures() as a
 * safety net, especially for majors.
 */
export async function fetchTodaysFixtures(tour: TennisTour): Promise<TennisFixture[]> {
  const typeParam = TENNIS_TOUR_TYPES[tour];
  const url = `${BASE}/matches/?type=${typeParam}`;
  return fetchFixturesFromUrl(url, tour, 'today');
}

/**
 * Fetches tomorrow's fixtures for a given tour (ATP or WTA singles).
 *
 * Immune to the same-day coverage gap fetchTodaysFixtures() has —
 * nothing on tomorrow's page can have started yet, so every match is
 * guaranteed to still be in "s"-prefixed (scheduled) row form. Intended
 * to be called alongside fetchTodaysFixtures(), not instead of it —
 * run this the evening/night before so majors get captured with a full
 * day's safety margin regardless of what time the same-day sync runs.
 *
 * Uses tennisexplorer.com's own ?year=&month=&day= date-navigation
 * params, confirmed live via the site's "next day" pagination link.
 */
export async function fetchTomorrowsFixtures(tour: TennisTour): Promise<TennisFixture[]> {
  const typeParam = TENNIS_TOUR_TYPES[tour];

  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const year = tomorrow.getUTCFullYear();
  const month = String(tomorrow.getUTCMonth() + 1).padStart(2, '0');
  const day = String(tomorrow.getUTCDate()).padStart(2, '0');

  const url = `${BASE}/matches/?type=${typeParam}&year=${year}&month=${month}&day=${day}`;
  return fetchFixturesFromUrl(url, tour, 'tomorrow');
}