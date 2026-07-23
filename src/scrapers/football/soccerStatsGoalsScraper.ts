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



export const SOCCERSTATS_LEAGUE_MAP: Record<string, string> = {
  'spain': 'spain',
  'spain2': 'spain2',
  'germany': 'germany',
  'germany2': 'germany2',
  'turkey': 'turkey',
  'netherlands': 'netherlands',
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
  return path.join(CACHE_DIR, `soccerstats-goals-${safeFileName(leagueCode)}.json`);
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

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
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

function parseGoalsPage(html: string, leagueCode: string): TeamGoalsSplit[] {
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
    writeGoalsCache(leagueCode, teams);
    return teams;
  } catch (err: any) {
    logger.error('[SoccerStatsGoals] Fetch failed', { leagueCode, error: err.message });
    return [];
  }
}