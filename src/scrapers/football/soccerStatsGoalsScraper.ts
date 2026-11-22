// src/scrapers/football/soccerStatsGoalsScraper.ts
//
// Reads the "Offence (home)" / "Defence (home)" / "Offence (away)" /
// "Defence (away)" sidebar sections on each league's latest.asp?league=X
// page, giving home/away goals-for/against splits per team.
//
// PURPOSE: feeds computeFootballLambdas-equivalent logic for leagues
// not already covered by fcStatsScraper.ts — scoped to Spain, Spain2,
// Germany, Germany2, Turkey, Netherlands.
//
// Row markup confirmed via real HTML fetch (not markdown-rendered):
//   <td style='text-align:left;font-size:13px;'>FC Barcelona</td>
//   <td align='center'><font color='green'>19</font></td>
//   <td align='center'><b>57
// Team name → plain <td>, GP → green <font>, GF/GA value → <b>.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { fetchViaFlare } from '../shared/flareFetch';
import * as cheerio from 'cheerio';



export const SOCCERSTATS_LEAGUE_MAP: Record<string, string> = {
  'spain': 'spain',
  'spain2': 'spain2',
  'germany': 'germany',
  'germany2': 'germany2',
  'turkey': 'turkey',
  'netherlands': 'netherlands',
  'MLS': 'usa',
};
// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface TeamGoalsSplit {
  teamName: string;
  homeGoalsFor: number;
  homeGoalsAgainst: number;
  awayGoalsFor: number;
  awayGoalsAgainst: number;
}

export const SECTION_HEADERS = {
  offenceHome: 'Offence (home)',
  defenceHome: 'Defence (home)',
  offenceAway: 'Offence (away)',
  defenceAway: 'Defence (away)',
} as const;

type SectionKey = keyof typeof SECTION_HEADERS;

// ─── PERSISTENT FILE CACHE ────────────────────────────────────────────────────
// Season-aggregate stats, not fixtures — safe to cache longer (24h),
// same TTL as soccerStatsCornersScraper.ts.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function goalsCachePath(leagueCode: string): string {
  return path.join(CACHE_DIR, `soccerstats-goals-v2-${safeFileName(leagueCode)}.json`);
}

interface CacheEntry {
  teams: TeamGoalsSplit[];
  fetchedAt: number;
}

function readGoalsCache(leagueCode: string): TeamGoalsSplit[] | null {
  try {
    const filePath = goalsCachePath(leagueCode);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.teams;
  } catch (err: any) {
    logger.warn('[SoccerStatsGoals] Cache read failed', { leagueCode, error: err.message });
    return null;
  }
}

function writeGoalsCache(leagueCode: string, teams: TeamGoalsSplit[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { teams, fetchedAt: Date.now() };
    fs.writeFileSync(goalsCachePath(leagueCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[SoccerStatsGoals] Failed to write cache', { leagueCode, error: err.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

const BASE = 'https://www.soccerstats.com';

async function fetchHtml(url: string): Promise<string> {
  return fetchViaFlare(url);
}

/**
 * Extracts the raw HTML block for a given section, from its header
 * up to the next <h3> section header (or end of string).
 */
export function extractSectionBlock(html: string, headerText: string): string | null {
  const headerPattern = new RegExp(
    `<h3><font[^>]*>${headerText.replace(/[()]/g, '\\$&')}</font></h3>`,
    'i'
  );
  const match = headerPattern.exec(html);
  if (!match) return null;

  const startIdx = match.index + match[0].length;
  const rest = html.slice(startIdx);
  const nextHeaderIdx = rest.search(/<h3>/i);
  return nextHeaderIdx === -1 ? rest : rest.slice(0, nextHeaderIdx);
}

/**
 * Parses team rows out of a single section block.
 * Row shape confirmed from raw markup:
 *   <td style='text-align:left;font-size:13px;'>TEAM NAME</td>
 *   <td align='center'><font color='green'>GP</font></td>
 *   <td align='center'><b>VALUE
 */
export function parseSectionRows(block: string): Map<string, number> {
  const rowPattern =
    /<td style='text-align:left;font-size:13px;'>([\s\S]*?)<\/td>\s*<td align='center'><font color='green'>(\d+)<\/font><\/td>\s*<td align='center'><b>\s*(\d+)/g;

  const result = new Map<string, number>();
  let m: RegExpExecArray | null;

  while ((m = rowPattern.exec(block)) !== null) {
    const rawName = m[1];
    const value = parseInt(m[3], 10);
    const teamName = rawName.replace(/\s+/g, ' ').trim();

    if (teamName && !Number.isNaN(value)) {
      result.set(teamName, value);
    }
  }

  return result;
}

// ─── CURRENT TEMPLATE (2026-11 redesign) ─────────────────────────────────────
// The old "Offence/Defence (home/away)" sidebars are gone. latest.asp now has
// "Home table" and "Away table" sections; each row is
//   rank | team (td.ha-team-cell) | GP | W | D | L | GF | GA | GD | Pts | PPG
// Values are converted to PER-MATCH averages (GF/GP) so that the aggregator's
// attack-strength x defence-weakness x league-average maths yields an expected
// goals-per-match figure. Teams with 0 games at home or away are skipped.
function parseGoalsPageCurrent(html: string, leagueCode: string): TeamGoalsSplit[] {
  const $: any = cheerio.load(html);

  const readTable = (title: string): Map<string, { gp: number; gf: number; ga: number }> => {
    const out = new Map<string, { gp: number; gf: number; ga: number }>();
    const hd = $('h1,h2,h3,h4,h5')
      .filter((_i: number, e: any) => $(e).text().replace(/\s+/g, ' ').trim().toLowerCase() === title.toLowerCase())
      .first();
    if (!hd.length) return out;
    let tbl = hd.next('table');
    if (!tbl.length) tbl = hd.nextAll().find('table').first();
    if (!tbl.length) tbl = hd.parent().find('table').first();
    tbl.find('tr').each((_i: number, tr: any) => {
      const name = $(tr).find('td.ha-team-cell').first().text().replace(/\s+/g, ' ').trim();
      const cells = $(tr).children('td').map((_j: number, c: any) => $(c).text().replace(/\s+/g, ' ').trim()).get() as string[];
      if (!name || cells.length < 8) return;
      const gp = parseInt(cells[2], 10);
      const gf = parseInt(cells[6], 10);
      const ga = parseInt(cells[7], 10);
      if (isNaN(gp) || isNaN(gf) || isNaN(ga)) return;
      out.set(name, { gp, gf, ga });
    });
    return out;
  };

  const home = readTable('Home table');
  const away = readTable('Away table');
  const teams: TeamGoalsSplit[] = [];
  for (const [name, h] of home) {
    const a = away.get(name);
    if (!a || h.gp <= 0 || a.gp <= 0) continue;
    teams.push({
      teamName: name,
      homeGoalsFor: h.gf / h.gp,
      homeGoalsAgainst: h.ga / h.gp,
      awayGoalsFor: a.gf / a.gp,
      awayGoalsAgainst: a.ga / a.gp,
    });
  }
  logger.info('[SoccerStatsGoals] Parsed ' + teams.length + ' teams (current template) for ' + leagueCode);
  return teams;
}

function parseGoalsPage(html: string, leagueCode: string): TeamGoalsSplit[] {
  const current = parseGoalsPageCurrent(html, leagueCode);
  if (current.length > 0) return current;
  const sectionData: Record<SectionKey, Map<string, number>> = {
    offenceHome: new Map(),
    defenceHome: new Map(),
    offenceAway: new Map(),
    defenceAway: new Map(),
  };

  for (const key of Object.keys(SECTION_HEADERS) as SectionKey[]) {
    const block = extractSectionBlock(html, SECTION_HEADERS[key]);
    if (!block) {
      logger.warn(`[SoccerStatsGoals] Section "${SECTION_HEADERS[key]}" not found`, { leagueCode });
      continue;
    }
    sectionData[key] = parseSectionRows(block);
  }

  const allTeams = new Set<string>([
    ...sectionData.offenceHome.keys(),
    ...sectionData.defenceHome.keys(),
    ...sectionData.offenceAway.keys(),
    ...sectionData.defenceAway.keys(),
  ]);

  const teams: TeamGoalsSplit[] = [];

  for (const teamName of allTeams) {
    const homeGoalsFor = sectionData.offenceHome.get(teamName);
    const homeGoalsAgainst = sectionData.defenceHome.get(teamName);
    const awayGoalsFor = sectionData.offenceAway.get(teamName);
    const awayGoalsAgainst = sectionData.defenceAway.get(teamName);

    if (
      homeGoalsFor === undefined ||
      homeGoalsAgainst === undefined ||
      awayGoalsFor === undefined ||
      awayGoalsAgainst === undefined
    ) {
      logger.warn(`[SoccerStatsGoals] Incomplete data for "${teamName}", skipping`, { leagueCode });
      continue;
    }

    teams.push({ teamName, homeGoalsFor, homeGoalsAgainst, awayGoalsFor, awayGoalsAgainst });
  }

  logger.info(`[SoccerStatsGoals] Parsed ${teams.length} teams for ${leagueCode}`);
  return teams;
}

// ─── PUBLIC API ─────────────────────────────────────────────────────────────

export async function scrapeSoccerStatsGoals(leagueCode: string): Promise<TeamGoalsSplit[]> {
  const cached = readGoalsCache(leagueCode);
  if (cached) {
    logger.info('[SoccerStatsGoals] Cache hit', { leagueCode });
    return cached;
  }

  try {
    const html = await fetchHtml(`${BASE}/latest.asp?league=${leagueCode}`);
    const teams = parseGoalsPage(html, leagueCode);
    if (teams.length > 0) writeGoalsCache(leagueCode, teams);
    return teams;
  } catch (err: any) {
    logger.error('[SoccerStatsGoals] Fetch failed', { leagueCode, error: err.message });
    return [];
  }
}