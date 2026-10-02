// src/scrapers/tennis/tennisRankingsScraper.ts
//
// Reads current ATP/WTA singles rankings from tennisexplorer.com. Same
// site as tennisFixturesScraper.ts, same no-Cloudflare, no-cookie
// situation — plain fetch() confirmed working against live HTML.
//
// KEY FINDING: this page uses FULL player names ("Sinner Jannik") and
// the exact same /player/{slug}/ identifier as the fixtures page (e.g.
// "sinner-8b8e8"). That means fixtures and rankings can be joined
// directly by slug — no fuzzy name-matching needed between these two
// sources, which is far more reliable than string-matching abbreviated
// names ("Sinner J.") against full ones.
//
// Row structure confirmed against live HTML 2026-08-29:
//
//   <tr class="two" onmouseover="m_over(this);" onmouseout="m_out(this);">
//     <td class="rank first">1.</td>
//     <td class="prevrank"><div>-</div></td>
//     <td class="t-name"><a href="/player/sinner-8b8e8/">Sinner Jannik</a></td>
//     <td class="tl"><a href="/ranking/atp-men/?country=italy">
//       <span class="fl fl-it">&nbsp;</span>Italy</a></td>
//     <td class="long-point">12800</td>
//   </tr>
//
// PAGINATION: the site's own navigator only lists pages 1-4 (confirmed
// against live HTML — "51-100", "101-150", "151-200" links, nothing
// beyond page 4). That's the site's own limit, not something we're
// truncating — covers ranks 1-200, sufficient for matching against real
// ATP/WTA fixtures (anyone outside top 200 is a genuinely low-tier
// player where "unranked" is an accurate label anyway).

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

const BASE = 'https://www.tennisexplorer.com';

export const RANKING_TOUR_PATHS = {
  atp: 'atp-men',
  wta: 'wta-women',
} as const;

export type RankingTour = keyof typeof RANKING_TOUR_PATHS;

export interface PlayerRanking {
  rank: number;
  slug: string;
  name: string;
  points: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = path.join(__dirname, '../../../.cache/stats');

function cachePath(tour: RankingTour): string {
  return path.join(CACHE_DIR, `tennisexplorer-rankings-${tour}.json`);
}

interface CacheEntry {
  rankings: PlayerRanking[];
  fetchedAt: number;
}

function readCache(tour: RankingTour): PlayerRanking[] | null {
  try {
    const filePath = cachePath(tour);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const entry: CacheEntry = JSON.parse(raw);
    if (Date.now() - entry.fetchedAt >= CACHE_TTL_MS) return null;
    return entry.rankings;
  } catch (err: any) {
    logger.warn('[TennisRankings] Cache read failed', { tour, error: err.message });
    return null;
  }
}

function writeCache(tour: RankingTour, rankings: PlayerRanking[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const entry: CacheEntry = { rankings, fetchedAt: Date.now() };
    fs.writeFileSync(cachePath(tour), JSON.stringify(entry), 'utf-8');
  } catch (err: any) {
    logger.warn('[TennisRankings] Failed to write cache', { tour, error: err.message });
  }
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

const ROW_REGEX =
  /<tr class="(?:one|two)"[^>]*>\s*<td class="rank first">(\d+)\.<\/td>\s*<td class="prevrank">[\s\S]*?<\/td>\s*<td class="t-name"><a href="\/player\/([^\/]+)\/">([^<]+)<\/a><\/td>\s*<td class="tl">[\s\S]*?<\/td>\s*<td class="long-point">(\d+)<\/td>/g;

function parseRankingsPage(html: string): PlayerRanking[] {
  const rankings: PlayerRanking[] = [];
  let m: RegExpExecArray | null;

  ROW_REGEX.lastIndex = 0;
  while ((m = ROW_REGEX.exec(html)) !== null) {
    const [, rankStr, slug, name, pointsStr] = m;
    rankings.push({
      rank: parseInt(rankStr, 10),
      slug,
      name: name.trim(),
      points: parseInt(pointsStr, 10),
    });
  }

  return rankings;
}

export async function fetchRankings(tour: RankingTour): Promise<PlayerRanking[]> {
  const cached = readCache(tour);
  if (cached) {
    logger.info('[TennisRankings] Cache hit', { tour });
    return cached;
  }

  const tourPath = RANKING_TOUR_PATHS[tour];
  const MAX_PAGES = 4;
  let allRankings: PlayerRanking[] = [];

   for (let page = 1; page <= MAX_PAGES; page++) {
    const url = page === 1
      ? `${BASE}/ranking/${tourPath}/`
      : `${BASE}/ranking/${tourPath}/?page=${page}`;

    let pageRankings: PlayerRanking[] = [];
    let succeeded = false;

    // One retry per page — the "fetch failed" errors seen against this
    // site look like transient network blips, not a real block (no
    // Cloudflare here, confirmed earlier), so a short pause + retry
    // clears most of them rather than losing the whole page.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const html = await fetchHtml(url);
        pageRankings = parseRankingsPage(html);
        succeeded = true;
        break;
      } catch (err: any) {
        if (attempt === 2) {
          logger.warn('[TennisRankings] Page fetch failed after retry', { tour, page, error: err.message });
        } else {
          logger.debug('[TennisRankings] Page fetch failed, retrying', { tour, page, attempt });
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    if (!succeeded) break; // give up on further pages, keep what we have

    if (pageRankings.length === 0) {
      logger.warn('[TennisRankings] Parsed 0 rankings on page — possible markup change', { tour, page });
      break;
    }

    allRankings = allRankings.concat(pageRankings);

    await new Promise(r => setTimeout(r, 1200)); // slightly longer courtesy delay
  }

  if (allRankings.length === 0) {
    logger.warn('[TennisRankings] No rankings collected across any page', { tour });
  } else {
    logger.info(`[TennisRankings] Parsed ${allRankings.length} rankings for ${tour} across ${MAX_PAGES} pages`);
    writeCache(tour, allRankings);
  }

  return allRankings;
}

/**
 * Convenience: builds a slug -> ranking lookup Map for fast joining
 * against fixtures (which also carry player1Slug/player2Slug).
 */
export async function fetchRankingsBySlug(tour: RankingTour): Promise<Map<string, PlayerRanking>> {
  const rankings = await fetchRankings(tour);
  return new Map(rankings.map(r => [r.slug, r]));
}