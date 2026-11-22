// src/scrapers/football/soccerStatsTeamSlugs.ts
//
// Builds a team-name -> team-page path map for a soccerstats.com league
// by reading the league's own latest.asp page.
//
// UPDATED 2026-11-10: SoccerStats changed its team links from
//   <a href='teamstats.asp?league=X&stats=u4788-sirius'>Sirius</a>
// to
//   <a href="/en-gb/leagues/england/league-two/england4/teams/fleetwood-town/608">Fleetwood Town</a>
// The old pattern matched nothing, so every team lookup failed. The "slug"
// returned here is now the path after /en-gb/leagues/, for example
//   england/league-two/england4/teams/fleetwood-town/608
// Empty results are no longer cached, and the cache file name carries a
// version so lists saved in the old format are ignored.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { fetchViaFlare } from '../shared/flareFetch';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function safeFileName(key: string): string {
  return key.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function cachePath(leagueCode: string): string {
  return path.join(CACHE_DIR, `soccerstats-teamslugs-v2-${safeFileName(leagueCode)}.json`);
}

interface CacheEntry {
  slugs: Record<string, string>; // normalized name -> team path
  fetchedAt: number;
}

function readCache(leagueCode: string): Record<string, string> | null {
  try {
    const filePath = cachePath(leagueCode);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    if (!entry.slugs || Object.keys(entry.slugs).length === 0) return null;
    return entry.slugs;
  } catch (err: any) {
    logger.warn('[TeamSlugs] Cache read failed', { leagueCode, error: err.message });
    return null;
  }
}

function writeCache(leagueCode: string, slugs: Record<string, string>): void {
  if (Object.keys(slugs).length === 0) return; // never cache an empty list
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { slugs, fetchedAt: Date.now() };
    fs.writeFileSync(cachePath(leagueCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[TeamSlugs] Failed to write cache', { leagueCode, error: err.message });
  }
}

function foldAccents(s: string): string {
  return s
    .replace(/\u00df/g, 'ss')
    .replace(/[\u0142\u0141]/g, 'l')
    .replace(/[\u00f8\u00d8]/g, 'o')
    .replace(/[\u0111\u0110]/g, 'd')
    .replace(/[\u00e6\u00c6]/g, 'ae')
    .replace(/[\u0153\u0152]/g, 'oe')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalize(name: string): string {
  return foldAccents(name).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchSlugMap(leagueCode: string): Promise<Record<string, string>> {
  const html = await fetchViaFlare(`https://www.soccerstats.com/latest.asp?league=${leagueCode}`);

  // Current structure: <a href="/en-gb/leagues/<country>/<league>/<code>/teams/<name>/<id>">Team Name</a>
  const linkRegex = /href="\/en-gb\/leagues\/([^"]+?\/teams\/[^"]+?\/\d+)">([^<]+)<\/a>/g;
  const own: Record<string, string> = {};
  const any: Record<string, string> = {};

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const teamPath = m[1];
    const key = normalize(m[2].replace(/&amp;/g, '&'));
    if (!key) continue;
    any[key] = teamPath;
    const parts = teamPath.split('/');
    const teamsIdx = parts.indexOf('teams');
    if (teamsIdx > 0 && parts[teamsIdx - 1] === leagueCode) own[key] = teamPath;
  }

  if (Object.keys(own).length > 0) return own;
  if (Object.keys(any).length > 0) {
    logger.warn('[TeamSlugs] No links under this league code - using every team link on the page', { leagueCode });
    return any;
  }
  logger.warn('[TeamSlugs] No team links found on league page - markup may have changed again', { leagueCode });
  return {};
}

// DB (football-data style) name -> soccerstats name, both normalized.
// Needed where soccerstats abbreviates and neither string contains the other.
const TEAM_NAME_ALIASES: Record<string, string> = {
  'atletico mineiro': 'atletico mg',
  'atletico paranaense': 'athletico pr',
  'america mineiro': 'america mg',
  'botafogosp': 'botafogo sp',
  'clube de regatas brasil': 'crb',
  'newcastle united': 'newcastle utd',
  'queens park rangers': 'qp rangers',
  'sheffield united': 'sheffield utd',
  'west ham united': 'west ham utd',
  'manchester united': 'man utd',
  'manchester utd': 'man utd',
  'manchester city': 'man city',
  'leeds united': 'leeds utd',
  'nottingham forest': 'nottm forest',
  'cambridge united': 'cambridge utd',
  'oxford united': 'oxford utd',
  'colchester united': 'colchester utd',
  'sheffield wednesday': 'sheffield wed',
    'nordic united fc': 'united nordic',
  'celta vigo b': 'celta fortuna',
  'lok plovdiv': 'lokomotiv plovdiv',
  'sankt pauli': 'st pauli',
  'polessya': 'polissya zhytomyr',
  'episentr': 'epitsentr dunayivtsi',
  'kasimpasa': 'kasmpasa',
  'erzurum bb': 'erzurumspor',
  'amed sk': 'amedspor',
  'athletic bilbao': 'athletic club',
  'rodina moscow': 'rodina moskva',
  'dinamo moscow': 'dinamo moskva',
  'legia warsaw': 'legia warszawa',
  'az alkmaar': 'az',
  'e frankfurt': 'eintracht frankfurt',
  'hertha berlin': 'hertha bsc',
  'wolverhampton': 'wolves',
  'fc kobenhavn': 'fc copenhagen',
  'slaven belupo': 'slaven koprivnica',
  'lok zagreb': 'lokomotiva zagreb',
  'tianjin jt': 'tianjin jinmen tiger',
  's shenhua': 'shanghai shenhua',
  'henan sl': 'henan songshan longm',
  'atletico mg': 'atletico mineiro',
  'america mg': 'america mineiro',
  'bodoglimt': 'bodo glimt',
  'bucheon fc': 'bucheon 1995',
  'al ittifaq': 'al ettifaq',
  'al taawon': 'al taawoun',
  'al feiha': 'alfayha',
  'al quadisiya': 'alqadsiah',
};

// Fixture sources abbreviate ("Cambridge Utd", "Sheffield Wed"); the site now
// spells names out. Expand both sides before comparing.
const ABBREV: Record<string, string> = { utd: 'united', wed: 'wednesday', nottm: 'nottingham', qp: 'queens park' };
function expandAbbrev(n: string): string {
  return n.split(' ').map(t => ABBREV[t] ?? t).join(' ');
}

/**
 * Returns the team-page path for a team name in a given league
 * (e.g. england/league-two/england4/teams/fleetwood-town/608),
 * or null if not found (name mismatch, or league not covered).
 */
export async function findTeamSlug(leagueCode: string, teamName: string): Promise<string | null> {
  let slugs = readCache(leagueCode);
  if (!slugs) {
    slugs = await fetchSlugMap(leagueCode);
    writeCache(leagueCode, slugs);
  }

  const key = normalize(teamName);
  const aliased = TEAM_NAME_ALIASES[key];
  if (aliased && slugs[aliased]) return slugs[aliased];
  if (slugs[key]) return slugs[key];

  const ek = expandAbbrev(key);
  for (const [name, slug] of Object.entries(slugs)) {
    if (expandAbbrev(name) === ek) return slug;
  }
  for (const [name, slug] of Object.entries(slugs)) {
    const en = expandAbbrev(name);
    if (en.includes(ek) || (en.length >= 3 && ek.includes(en))) return slug;
  }

  logger.warn('[TeamSlugs] No slug match', { leagueCode, teamName, normalized: key });
  return null;
}
