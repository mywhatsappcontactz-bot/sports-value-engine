// src/scrapers/football/soccerStatsMatchCornersScraper.ts
//
// Extracts a single match's REAL corner result (not season average) from
// its pmatch.asp report page — e.g. "8 — 2" for Arsenal 3-0 Coventry City,
// 21 Aug 2026. Confirmed present on 8/18 soccerstats.com leagues (EPL,
// Championship, League 1, League 2, La Liga, La Liga 2, Bundesliga,
// Serie A, Netherlands — see conversation for the full per-league check);
// absent on the other 10 (2. Bundesliga, Turkey, Scotland, Belgium,
// Russia, Poland, Switzerland, Ukraine, MLS).
//
// This is the foundation for recency-weighted corners — season-long
// averages (soccerStatsCornersScraper.ts) can't show a team's last-N-match
// form the way weightedGoalsAvg does for goals; this scraper is what
// makes that possible for corners, for the leagues that support it.
//
// PURPOSE: called once per recent match per team (via
// soccerStatsFormScraper.ts's per-team match list) — NOT a bulk league
// fetch like the other soccerstats scrapers. Expect N requests per team
// evaluated, not 1.

import { fetchViaFlare } from '../shared/flareFetch';
import { logger } from '../../core/utils/logger';

export interface MatchCorners {
  homeCorners: number;
  awayCorners: number;
}

const CORNERS_H3_MARKER = "<h3 style='text-align: center; margin-top:10px;'>Corners</h3>";

// Confirmed markup (Arsenal 3-0 Coventry City, 21 Aug 2026):
// <table ...><tr bgcolor='#ffffff'><td colspan='3'><h3 ...>Corners</h3></td></tr>
// <tr bgcolor='#ffffff' height='24'>
//   <td align='right' ...><font ...><b>8</b></font></td>
//   <td align='center'><table>...</table></td>
//   <td align='left' ...><font ...><b>2</b></font></td>
// </tr></table>
// First <b>N</b> after the marker = home corners, second = away corners.
function parseCornersFromHtml(html: string): MatchCorners | null {
  const markerIdx = html.indexOf(CORNERS_H3_MARKER);
  if (markerIdx === -1) {
    return null; // this match/league doesn't have the Corners block at all
  }

  // Search only within a bounded window after the marker — avoids
  // accidentally matching a <b>N</b> from an unrelated section further
  // down the page if the exact table structure ever shifts slightly.
  const window = html.slice(markerIdx, markerIdx + 1500);

  const boldNumberRegex = /<b>(\d+)<\/b>/g;
  const matches: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = boldNumberRegex.exec(window)) !== null && matches.length < 2) {
    matches.push(parseInt(m[1], 10));
  }

  if (matches.length < 2) {
    logger.warn('[SoccerStatsMatchCorners] Found Corners marker but could not extract two numbers', {
      windowSnippet: window.slice(0, 300),
    });
    return null;
  }

  return { homeCorners: matches[0], awayCorners: matches[1] };
}

/**
 * Fetches and parses one match's real corner result from its pmatch.asp
 * report page. Returns null if the page has no Corners block (league not
 * covered — see file header) or the block couldn't be parsed.
 */
export async function fetchMatchCorners(pmatchUrl: string): Promise<MatchCorners | null> {
  try {
    const html = await fetchViaFlare(pmatchUrl);
    const result = parseCornersFromHtml(html);

    if (!result) {
      logger.info('[SoccerStatsMatchCorners] No corners data for this match', { pmatchUrl });
    }

    return result;
  } catch (err: any) {
    logger.error('[SoccerStatsMatchCorners] Fetch failed', { pmatchUrl, error: err.message });
    return null;
  }
}