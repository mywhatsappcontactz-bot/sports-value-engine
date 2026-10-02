// src/scrapers/football/soccerStatsTeamSlugs.ts
//
// Builds a team-name -> teamstats.asp slug map for a soccerstats.com
// league, by scraping the league's own latest.asp page (the "Teams"
// dropdown lists every team as teamstats.asp?league=X&stats=SLUG).
// Needed because teamResultsScraper.ts requires the exact slug, not
// just a team name.

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
  return path.join(CACHE_DIR, `soccerstats-teamslugs-${safeFileName(leagueCode)}.json`);
}

interface CacheEntry {
  slugs: Record<string, string>; // normalized name -> slug
  fetchedAt: number;
}

function readCache(leagueCode: string): Record<string, string> | null {
  try {
    const filePath = cachePath(leagueCode);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.slugs;
  } catch (err: any) {
    logger.warn('[TeamSlugs] Cache read failed', { leagueCode, error: err.message });
    return null;
  }
}

function writeCache(leagueCode: string, slugs: Record<string, string>): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { slugs, fetchedAt: Date.now() };
    fs.writeFileSync(cachePath(leagueCode), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[TeamSlugs] Failed to write cache', { leagueCode, error: err.message });
  }
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchSlugMap(leagueCode: string): Promise<Record<string, string>> {
  const html = await fetchViaFlare(`https://www.soccerstats.com/latest.asp?league=${leagueCode}`);

  // Confirmed structure: teamstats.asp?league=X&stats=u4788-sirius">Sirius</a>
const linkRegex = /href='teamstats\.asp\?league=\w+&stats=([\w.-]+)'>([^<]+)<\/a>/g;
  const slugs: Record<string, string> = {};

  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) {
    const [, slug, name] = m;
    slugs[normalize(name)] = slug;
  }

  return slugs;
}

/**
 * Returns the teamstats.asp slug for a team name in a given league,
 * or null if not found (e.g. name mismatch, or league not covered).
 */
export async function findTeamSlug(leagueCode: string, teamName: string): Promise<string | null> {
  let slugs = readCache(leagueCode);
  if (!slugs) {
    slugs = await fetchSlugMap(leagueCode);
    writeCache(leagueCode, slugs);
  }

  const key = normalize(teamName);
  if (slugs[key]) return slugs[key];

  // fuzzy fallback, same approach as other scrapers tonight
  for (const [name, slug] of Object.entries(slugs)) {
    if (name.includes(key) || key.includes(name)) return slug;
  }

  return null;
}