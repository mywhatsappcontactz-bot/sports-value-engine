// src/core/engine/cornersRecencyWeighting.ts
//
// Computes a recency-weighted corners figure (0.85^i decay, same pattern
// as weightedGoalsAvg in probabilityModel.ts) for one team, by fetching
// each of their recent matches' REAL corner result via
// soccerStatsMatchCornersScraper.ts — not their season average.
//
// ONLY WORKS for the 8 leagues confirmed to expose per-match corners on
// soccerstats.com (see LEAGUES_WITH_MATCH_CORNERS in cornersAggregator.ts
// for the gating list and full per-league check). For other leagues,
// this returns null and callers should fall back to the existing
// season-average + shrinkage path (cornersAggregator.ts) — this is an
// ADDITIVE signal for supported leagues, not a replacement.
//
// COST WARNING: this makes one HTTP request PER RECENT MATCH per team
// evaluated (typically 5 per team = up to 10 per fixture, home + away) —
// much more expensive than the single-request season-average fetch. No
// caching yet — deliberately deferred pending real usage patterns (see
// conversation).

import { RecentResult } from '../../scrapers/football/soccerStatsFormScraper';
import { fetchMatchCorners } from '../../scrapers/football/soccerStatsMatchCornersScraper';
import { logger } from '../utils/logger';

const BASE = 'https://www.soccerstats.com';
const RECENCY_DECAY = 0.85; // same constant as weightedGoalsAvg in probabilityModel.ts

export interface RecencyWeightedResult {
  value: number;
  matchesUsed: number;
  matchesAttempted: number;
}

/**
 * Given one team's recent match results (from fetchRecentForm) and which
 * side they were on (home/away) for each, fetches each match's real
 * corner count for THIS team and returns a recency-weighted average,
 * along with how many of the attempted matches actually succeeded — used
 * by cornersAggregator.ts to scale how much this signal should be
 * trusted relative to the season-average path (matchesUsed/matchesAttempted
 * as a confidence ratio, not treated as automatically fully trustworthy
 * just because it returned a number).
 *
 * Returns null if none of the recent results have a pmatchPath (league
 * not covered) or if every fetch failed.
 */
export async function computeRecencyWeightedCorners(recentResults: RecentResult[]): Promise<RecencyWeightedResult | null> {
  const withPmatch = recentResults.filter(r => r.pmatchPath);
  if (!withPmatch.length) {
    return null; // league not covered, or no match links found
  }

  let weightSum = 0;
  let valueSum = 0;
  let matchesUsed = 0;

  for (let i = 0; i < withPmatch.length; i++) {
    const result = withPmatch[i];
    const url = `${BASE}/${result.pmatchPath}`;

    const cornersResult = await fetchMatchCorners(url);
    if (!cornersResult) continue; // this specific match had no corners block — skip, don't fail the whole average

    const teamCorners = result.venue === 'home' ? cornersResult.homeCorners : cornersResult.awayCorners;
    const weight = Math.pow(RECENCY_DECAY, i); // i=0 is most recent (fetchRecentForm returns newest-first)

    valueSum += teamCorners * weight;
    weightSum += weight;
    matchesUsed++;
  }

  if (matchesUsed === 0) {
    logger.warn('[CornersRecencyWeighting] Had pmatch links but no corners data extracted from any of them');
    return null;
  }

  return {
    value: valueSum / weightSum,
    matchesUsed,
    matchesAttempted: withPmatch.length,
  };
}