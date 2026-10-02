// src/scrapers/football/teamResultsScraper.ts
//
// Reads individual match-by-match results from a team's teamstats.asp
// page — real per-match data (date, opponent, score, venue), unlike
// formtable.asp's aggregate-only numbers. Feeds homeForm/awayForm
// directly, matching FCStats' FormRecord shape.
//
// NOTE (2026-08-16): fetchHtml() uses a manual cf_clearance cookie via
// fetchViaFlare() (see flareFetch.ts) — plain HTTP, not a rendered
// browser. Confirmed against live Turkey data that RAW HTML uses
// single-quoted attributes and a title='X vs Y' attribute — this is
// the ORIGINAL format this file used before an earlier session
// mistakenly "fixed" it against browser-rendered (double-quoted,
// no title attribute) markup from Camoufox/FlareSolverr. If the fetch
// method ever changes back to a real browser, these regexes will need
// to flip back to double-quoted/no-title format again — check raw
// content before assuming either version is current.
//
// Row structure confirmed against real HTML (Turkey, Galatasaray,
// 2026-08-16):
//
//   <tr bgcolor='#FFFFBF' height='38'>
//     <td align='right'><font style='font-size:11px;color:#444444;'>
//       14 Aug
//     </font></td>
//     <td align='right' style='padding-right:4px;'>
//       <b>Galatasaray</b>                        <- home team (bold if page-owner)
//     </td>
//     <td align='center' width='46'>
//       <a href='#m1' class='tooltip4' ...>
//         <font style='color:blue;font-size:14px;font-family:monospace;'>
//           <b>2:2</b>                              <- REAL final score (home:away)
//         </font>
//         <span>...tooltip with goal-by-goal minute markers -- IGNORED</span>
//       </a>
//     </td>
//     ...
//     <td align='center'>
//       <a class='SmallButton' href='pmatch.asp?...' title='Home vs Away' ...>
//     </td>
//   </tr>
//
// Ground truth for home/away comes from the pmatch title attribute
// ('Home vs Away'), NOT from which name is bolded (bold just marks
// whichever team the page belongs to, regardless of venue).

import { logger } from '../../core/utils/logger';
import { FormRecord } from '../../core/database/schema';
import { findTeamSlug } from './soccerStatsTeamSlugs';
import { fetchViaFlare } from '../shared/flareFetch';

async function fetchHtml(url: string): Promise<string> {
  return fetchViaFlare(url);
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function inferDate(day: number, monthAbbr: string): string {
  const month = MONTHS[monthAbbr.toLowerCase()];
  const now = new Date();
  let year = now.getFullYear();
  let candidate = new Date(Date.UTC(year, month, day));
  const diffDays = (candidate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
  if (diffDays > 30) { year -= 1; candidate = new Date(Date.UTC(year, month, day)); }
  return candidate.toISOString().split('T')[0];
}

/**
 * Fetches a team's page and returns their recent match results as
 * FormRecord[] — same shape fcStatsScraper.ts already produces.
 */
export async function fetchTeamResults(
  leagueCode: string,
  teamStatsSlug: string, // e.g. 'u3812-a.-bucaramanga'
  teamName: string,      // the team this page belongs to, for venue detection
): Promise<FormRecord[]> {
  const url = `https://www.soccerstats.com/teamstats.asp?league=${leagueCode}&stats=${teamStatsSlug}`;
  const html = await fetchHtml(url);

  // Safety guard: soccerstats.com occasionally serves the wrong team's
  // page for a given slug. Verify the page's own <title> actually names
  // the team we asked for before parsing anything.
  const titleTagMatch = /<title>([^<]*)<\/title>/.exec(html);
  const pageTitle = titleTagMatch ? titleTagMatch[1] : '';
  if (pageTitle && !pageTitle.includes(teamName)) {
    logger.warn('[TeamResults] Page identity mismatch — soccerstats served the wrong team page', {
      leagueCode,
      teamStatsSlug,
      expectedTeam: teamName,
      pageTitle,
    });
    return [];
  }

  const results: FormRecord[] = [];

  // Confined to single <tr height='38'>...</tr> blocks to prevent a
  // lazy [\s\S]*? on the whole page from bleeding across rows.
  const rowBlockRegex = /<tr[^>]*height='38'>([\s\S]*?)<\/tr>/g;

  const dateRegex = /color:#444444;'>\s*(\d{1,2}) (\w{3})/;
  const scoreRegex = /color:blue;font-size:14px;font-family:monospace;'><b>(\d+):(\d+)<\/b>/;
  const titleRegex = /title='([^']+) vs ([^']+)'/;

  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowBlockRegex.exec(html)) !== null) {
    const row = rowMatch[1];

    const dateM = dateRegex.exec(row);
    const scoreM = scoreRegex.exec(row);
    const titleM = titleRegex.exec(row);
    if (!dateM || !scoreM || !titleM) continue; // e.g. an upcoming fixture row (no score yet)

    const [, dayStr, monthAbbr] = dateM;
    const [, homeScoreStr, awayScoreStr] = scoreM;
    const [, homeTeam, awayTeam] = titleM;

    const day = parseInt(dayStr, 10);
    const homeScore = parseInt(homeScoreStr, 10);
    const awayScore = parseInt(awayScoreStr, 10);

    const isHome = homeTeam.trim() === teamName;
    const isAway = awayTeam.trim() === teamName;
    if (!isHome && !isAway) continue; // shouldn't happen, but skip safely

    const goalsFor = isHome ? homeScore : awayScore;
    const goalsAgainst = isHome ? awayScore : homeScore;
    const opponent = isHome ? awayTeam.trim() : homeTeam.trim();

    let result: 'W' | 'L' | 'D';
    if (goalsFor > goalsAgainst) result = 'W';
    else if (goalsFor < goalsAgainst) result = 'L';
    else result = 'D';

    results.push({
      date: inferDate(day, monthAbbr),
      opponent,
      result,
      goalsFor,
      goalsAgainst,
      venue: isHome ? 'home' : 'away',
    });
  }

  if (results.length === 0) {
    logger.warn('[TeamResults] Parsed 0 results — possible markup change', { leagueCode, teamStatsSlug });
  } else {
    logger.info(`[TeamResults] Parsed ${results.length} results for ${teamName}`, { leagueCode });
  }

  return results;
}

/**
 * Convenience wrapper: looks up the team's slug, then fetches their
 * match results. Returns [] if the team can't be found in this league.
 */
export async function fetchTeamResultsByName(
  leagueCode: string,
  teamName: string,
): Promise<FormRecord[]> {
  const slug = await findTeamSlug(leagueCode, teamName);
  if (!slug) {
    logger.warn('[TeamResults] Could not find team slug', { leagueCode, teamName });
    return [];
  }
  return fetchTeamResults(leagueCode, slug, teamName);
}