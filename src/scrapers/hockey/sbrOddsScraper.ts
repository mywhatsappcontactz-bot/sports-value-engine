// src/scrapers/hockey/sbrOddsScraper.ts
//
// Scrapes sportsbookreviewsonline.com's NHL historical odds archive.
// Confirmed 2026-09-04: no Cloudflare wall (unlike eliteprospects.com),
// plain HTML table, real <table class="table bg-white table-hover
// table-bordered table-sm"> with <td> cells, no cookie/session needed.
//
// Confirmed URL pattern:
//   https://www.sportsbookreviewsonline.com/scoresoddsarchives/nhl-odds-{YY-YY}/
//   e.g. nhl-odds-2022-23 (SBR uses 2-digit second year, NOT "2022-2024"
//   style like EliteProspects — different convention, confirmed by
//   directly viewing the site's own archive list).
//
// Confirmed real column layout (13 <td> header labels, but 16 <td> DATA
// cells per row — PuckLine/OpenOU/CloseOU each pack a line value AND an
// odds value with only one shared header label, confirmed by counting
// cells directly against the header row):
//   0 Date (MMDD, no year)     8 OpenML
//   1 Rot                      9 CloseML
//   2 VH (V/H/N)               10 PuckLine
//   3 Team (SBR's own short   11 PuckLineOdds
//     form, e.g. "SanJose")    12 OpenOU_line
//   4 1st period score         13 OpenOU_odds
//   5 2nd period score         14 CloseOU_line
//   6 3rd period score         15 CloseOU_odds
//   7 Final score
//
// Each real game is TWO CONSECUTIVE <tr> rows: one with VH="V" (away),
// one with VH="H" (home) — confirmed via the VH column directly, not
// inferred from Rot number ordering. Neutral-site games (VH="N", e.g.
// early-season showcase games) are skipped entirely — the moneyline
// model here has no neutral-site handling, and mixing them in would
// silently corrupt the home-ice-advantage assumption.
//
// No year in the Date field — inferred from month: Oct-Dec = season
// start year, Jan-Jun = season start year + 1. Standard NHL season
// calendar, not a guess specific to this site.

import * as cheerio from 'cheerio';
import { logger } from '../../core/utils/logger';

const BASE = 'https://www.sportsbookreviewsonline.com/scoresoddsarchives';

export interface SbrGame {
  dateIso: string;         // YYYY-MM-DD, year inferred from season + month
  homeTeamSbr: string;     // SBR's own short form, e.g. "SanJose"
  awayTeamSbr: string;
  homeScore: number;
  awayScore: number;
  homeCloseMl: number;     // American odds, closing line
  awayCloseMl: number;
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error(`Request timed out after 20s for ${url}`);
    throw new Error(`${err.message} | url: ${url}`);
  } finally {
    clearTimeout(timeout);
  }
}

interface RawRow {
  date: string;
  rot: string;
  vh: string;
  team: string;
  final: number;
  closeMl: number;
}

function parseRow($row: cheerio.Cheerio<any>, $: cheerio.CheerioAPI): RawRow | null {
  const cells = $row.find('td').map((_i: number, el: any) => $(el).text().trim()).get();
  if (cells.length !== 16) return null; // skip header row or any malformed row

  const final = parseInt(cells[7], 10);
  const closeMl = parseInt(cells[9], 10);
  if (isNaN(final) || isNaN(closeMl)) return null;

  return {
    date: cells[0],
    rot: cells[1],
    vh: cells[2],
    team: cells[3],
    final,
    closeMl,
  };
}

/**
 * Converts SBR's MMDD (no year) date into a real ISO date, given the
 * season's start year. Oct-Dec => startYear, Jan-Jun => startYear + 1 —
 * standard NHL season calendar boundary, not site-specific.
 */
function mmddToIso(mmdd: string, seasonStartYear: number): string | null {
  if (mmdd.length < 3 || mmdd.length > 4) return null;
  const month = parseInt(mmdd.slice(0, mmdd.length - 2), 10);
  const day = parseInt(mmdd.slice(-2), 10);
  if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) return null;

  const year = month >= 10 ? seasonStartYear : seasonStartYear + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Fetches and parses one NHL season's real historical odds.
 * @param seasonSbr SBR's own format, e.g. "2022-23" (NOT "2022-2024").
 * @param seasonStartYear e.g. 2022 — used to resolve the year-less date field.
 */
export async function fetchNhlSeasonOdds(seasonSbr: string, seasonStartYear: number): Promise<SbrGame[]> {
  const url = `${BASE}/nhl-odds-${seasonSbr}/`;
  console.log(`  [debug] fetching SBR odds: ${url} ...`);
  const html = await fetchHtml(url);
  console.log(`  [debug] fetch complete, got ${html.length} bytes — starting parse...`);

  const $ = cheerio.load(html);
  const rows: RawRow[] = [];
  $('table tr').each((_i, el) => {
    const parsed = parseRow($(el), $);
    if (parsed) rows.push(parsed);
  });

  console.log(`  [debug] parsed ${rows.length} raw team-rows`);

  const games: SbrGame[] = [];
  let skippedNeutral = 0;
  let skippedMalformedPair = 0;

  // Real games are two consecutive rows. Walk in twos.
  for (let i = 0; i < rows.length - 1; i += 2) {
    const a = rows[i];
    const b = rows[i + 1];

    if (a.vh === 'N' || b.vh === 'N') {
      skippedNeutral++;
      continue;
    }

    let home: RawRow | null = null;
    let away: RawRow | null = null;
    if (a.vh === 'H' && b.vh === 'V') { home = a; away = b; }
    else if (a.vh === 'V' && b.vh === 'H') { home = b; away = a; }
    else {
      skippedMalformedPair++;
      continue;
    }

    const dateIso = mmddToIso(home.date, seasonStartYear);
    if (!dateIso) {
      skippedMalformedPair++;
      continue;
    }

    games.push({
      dateIso,
      homeTeamSbr: home.team,
      awayTeamSbr: away.team,
      homeScore: home.final,
      awayScore: away.final,
      homeCloseMl: home.closeMl,
      awayCloseMl: away.closeMl,
    });
  }

  console.log(`  [debug] built ${games.length} real games (skipped ${skippedNeutral} neutral-site, ${skippedMalformedPair} malformed pairs)`);
  if (games.length === 0) {
    logger.warn('[SbrOddsScraper] Parsed 0 games — page structure may have changed since verification');
  }

  return games;
}

// ─── TEAM NAME MATCHING ───────────────────────────────────────────────
//
// SBR's own team strings are short/squashed forms confirmed directly
// from real data (e.g. "SanJose", "NYRangers", "TampaBay") and are
// internally INCONSISTENT within the same page (e.g. "NewJersey" early
// in a season, "New Jersey" later — confirmed by direct observation,
// not assumed). EliteProspects' exact team-name string format was NOT
// independently confirmed for NHL specifically, so rather than hardcode
// a literal string to match against, each SBR short form maps to a
// normalized KEYWORD (city name) that should appear as a substring in
// whatever EliteProspects' real team name string turns out to be —
// team cities/nicknames themselves are stable public facts, only the
// exact site formatting was uncertain.
const SBR_TEAM_KEYWORDS: Record<string, string> = {
  'SanJose': 'san jose', 'San Jose': 'san jose',
  'NYRangers': 'rangers', 'NY Rangers': 'rangers',
  'NYIslanders': 'islanders', 'NY Islanders': 'islanders',
  'TampaBay': 'tampa bay', 'Tampa Bay': 'tampa bay',
  'LosAngeles': 'los angeles', 'Los Angeles': 'los angeles',
  'SeattleKraken': 'seattle', 'Seattle Kraken': 'seattle',
  'St.Louis': 'st louis', 'St. Louis': 'st louis',
  'NewJersey': 'new jersey', 'New Jersey': 'new jersey',
  'Nashville': 'nashville', 'Boston': 'boston', 'Washington': 'washington',
  'Toronto': 'toronto', 'Montreal': 'montreal', 'Chicago': 'chicago',
  'Colorado': 'colorado', 'Vancouver': 'vancouver', 'Edmonton': 'edmonton',
  'Anaheim': 'anaheim', 'Ottawa': 'ottawa', 'Buffalo': 'buffalo',
  'Arizona': 'arizona', 'Pittsburgh': 'pittsburgh', 'Philadelphia': 'philadelphia',
  'Florida': 'florida', 'Winnipeg': 'winnipeg', 'Minnesota': 'minnesota',
  'Dallas': 'dallas', 'Calgary': 'calgary', 'Detroit': 'detroit',
  'Carolina': 'carolina', 'Columbus': 'columbus', 'Vegas': 'vegas',
};

/**
 * Returns true if an EliteProspects team name string plausibly refers
 * to the same team as an SBR short form. Substring match on a
 * normalized city/nickname keyword — tolerant of exact formatting
 * differences (periods, "St." vs "St", accents) since neither side's
 * precise string format was independently confirmed for every case.
 */
export function sbrTeamMatches(sbrName: string, otherTeamName: string): boolean {
  const keyword = SBR_TEAM_KEYWORDS[sbrName];
  if (!keyword) return false;
  const normalizedOther = otherTeamName.toLowerCase().replace(/[.']/g, '');
  return normalizedOther.includes(keyword);
}