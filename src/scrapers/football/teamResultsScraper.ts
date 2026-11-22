// src/scrapers/football/teamResultsScraper.ts
//
// Reads individual match-by-match results from a team's page on soccerstats.com
// (date, opponent, score, venue). Feeds homeForm/awayForm directly, matching
// FCStats' FormRecord shape.
//
// UPDATED 2026-11-10: SoccerStats replaced
//   teamstats.asp?league=X&stats=SLUG   (single-quoted markup, <tr height='38'>)
// with
//   /en-gb/leagues/<country>/<league>/<code>/teams/<name>/<id>
// Each result is now a <tr class="... tbl-match-row"> with:
//   td.td-date-compact  -> [data-kickoff="2026-10-24 14:00:00"]
//   td.td-team-right    -> HOME team name (span.desktop-only)
//   td.td-score-center  -> span.score-badge "2:1"
//   td.td-team-left     -> AWAY team name (span.desktop-only)
// Ground truth for home/away is the cell position, as before.

import * as cheerio from 'cheerio';
import { logger } from '../../core/utils/logger';
import { FormRecord } from '../../core/database/schema';
import { findTeamSlug } from './soccerStatsTeamSlugs';
import { fetchViaFlare } from '../shared/flareFetch';

async function fetchHtml(url: string): Promise<string> {
  return fetchViaFlare(url);
}

function normIdent(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// "england/league-two/england4/teams/fleetwood-town/608" -> "fleetwood-town"
function slugNamePart(teamPath: string): string {
  const parts = teamPath.split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : teamPath;
}

// True when the page <title> belongs to the team we asked for.
function pageIsForTeam(pageTitle: string, teamName: string, slugName: string): boolean {
  if (pageTitle.includes(teamName)) return true;
  const head = pageTitle.split(/\s+(?:statistics|stats)/i)[0];
  const nHead = normIdent(head);
  const nSlug = normIdent(slugName);
  if (!nHead || !nSlug) return false;
  return nHead === nSlug || nHead.startsWith(nSlug) || nSlug.startsWith(nHead);
}

function normTeam(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// True when a name from a result row refers to the team whose page this is:
// the name we asked for, or the page's own name from its address.
function sameTeam(pageName: string, teamName: string, slugName: string): boolean {
  const p = normTeam(pageName);
  const t = normTeam(teamName);
  const s = normTeam(slugName);
  if (!p) return false;
  return p === t || p === s;
}

/**
 * Fetches a team's page and returns their recent match results as
 * FormRecord[] (most recent first, page order) - same shape fcStatsScraper.ts produces.
 */
export async function fetchTeamResults(
  leagueCode: string,
  teamPath: string, // e.g. 'england/league-two/england4/teams/fleetwood-town/608'
  teamName: string, // the team this page belongs to, for venue detection
): Promise<FormRecord[]> {
  const url = `https://www.soccerstats.com/en-gb/leagues/${teamPath}`;
  const html = await fetchHtml(url);
  const slugName = slugNamePart(teamPath);

  // Safety guard: verify the page's own <title> names the team we asked for.
  const titleTagMatch = /<title>([^<]*)<\/title>/.exec(html);
  const pageTitle = titleTagMatch ? titleTagMatch[1] : '';
  if (pageTitle && !pageIsForTeam(pageTitle, teamName, slugName)) {
    logger.warn('[TeamResults] Page identity mismatch - soccerstats served the wrong team page', {
      leagueCode,
      teamPath,
      expectedTeam: teamName,
      pageTitle,
    });
    return [];
  }

  const $ = cheerio.load(html);
  const results: FormRecord[] = [];
  const seen = new Set<string>();

  $('tr.tbl-match-row').each((_i, tr) => {
    const $tr = $(tr);
    const kickoff = $tr.find('td.td-date-compact [data-kickoff]').first().attr('data-kickoff') || '';
    if (!/^\d{4}-\d{2}-\d{2}/.test(kickoff)) return;
    const date = kickoff.slice(0, 10);

    // Skip fixtures that haven't been played yet (their badge can show a kickoff time).
    const kt = new Date(kickoff.replace(' ', 'T') + 'Z').getTime();
    if (!isNaN(kt) && kt > Date.now()) return;

    const homeTeam = $tr.find('td.td-team-right span.desktop-only').first().text().trim();
    const awayTeam = $tr.find('td.td-team-left span.desktop-only').first().text().trim();
    const scoreText = $tr.find('td.td-score-center .score-badge').first().text().trim();
    const sm = /^(\d+):(\d+)$/.exec(scoreText);
    if (!homeTeam || !awayTeam || !sm) return;

    const homeScore = parseInt(sm[1], 10);
    const awayScore = parseInt(sm[2], 10);

    const isHome = sameTeam(homeTeam, teamName, slugName);
    const isAway = sameTeam(awayTeam, teamName, slugName);
    if (!isHome && !isAway) return; // some other team's row

    const key = `${date}|${homeTeam}|${awayTeam}|${homeScore}:${awayScore}`;
    if (seen.has(key)) return;
    seen.add(key);

    const goalsFor = isHome ? homeScore : awayScore;
    const goalsAgainst = isHome ? awayScore : homeScore;
    const opponent = isHome ? awayTeam : homeTeam;

    let result: 'W' | 'L' | 'D';
    if (goalsFor > goalsAgainst) result = 'W';
    else if (goalsFor < goalsAgainst) result = 'L';
    else result = 'D';

    results.push({
      date,
      opponent,
      result,
      goalsFor,
      goalsAgainst,
      venue: isHome ? 'home' : 'away',
    });
  });

  if (results.length === 0) {
    logger.warn('[TeamResults] Parsed 0 results - possible markup change', { leagueCode, teamPath });
  } else {
    logger.info(`[TeamResults] Parsed ${results.length} results for ${teamName}`, { leagueCode });
  }

  return results;
}

/**
 * Convenience wrapper: looks up the team's page path, then fetches their
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
