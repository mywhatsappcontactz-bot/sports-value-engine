// src/data-bridge/tennisH2HBridge.ts
//
// Bridges the gap between tennisFixturesScraper.ts (abbreviated names,
// e.g. "Djokovic N.") and tennisAbstractScraper.ts (needs a full name
// to build its URL, e.g. "Novak Djokovic" -> "NovakDjokovic").
//
// Path: fixture.player{1,2}Slug -> tennisRankingsScraper's slug-keyed
// rankings map -> ranking.name -> reordered into TennisAbstract's
// expected First-Last order -> scrapeTennisH2H().
//
// WORD ORDER GOTCHA (confirmed live 2026-09-01): tennisexplorer.com's
// rankings page gives names as "Surname Givenname" (e.g. "Sinner
// Jannik"), NOT "Givenname Surname". tennisAbstractScraper.ts's
// toAbstractName() just concatenates whatever order it's given, and
// TennisAbstract's own URL convention is Givenname+Surname (e.g.
// "JannikSinner"). Passing the rankings name through unmodified would
// silently build the wrong URL for every player — not an error, just
// wrong or empty data back. reorderToGivenSurname() below fixes this.
//
// COVERAGE LIMIT: tennisRankingsScraper only covers ranks 1-200 (the
// site's own pagination limit). Players outside that range have a
// slug from fixtures but no rankings-page entry, so there's no
// reliable way to recover their full name from an abbreviated
// initial alone — resolveFullName() returns null for these, and
// callers should skip the H2H fetch rather than guess.

import { logger } from '../core/utils/logger';
import { TennisFixture, TennisTour } from '../scrapers/tennis/tennisFixturesScraper';
import { fetchRankingsBySlug, PlayerRanking } from '../scrapers/tennis/tennisRankingsScraper';
import { scrapeTennisH2H, TennisAbstractH2H } from '../scrapers/tennis/tennisAbstractScraper';

/**
 * tennisexplorer.com rankings give "Surname Givenname" (e.g.
 * "Sinner Jannik"). TennisAbstract's URL scheme expects
 * Givenname+Surname concatenated (e.g. "JannikSinner"). This assumes
 * exactly two words — confirmed against several live rankings rows,
 * but multi-part surnames (e.g. "Van De Zandschulp") would break this
 * naive split. Not yet tested against a multi-part-surname player;
 * if H2H silently comes back empty for someone with an obviously
 * compound name, check here first before assuming the site changed.
 */
function reorderToGivenSurname(rankingsName: string): string {
  const parts = rankingsName.trim().split(/\s+/);
  if (parts.length !== 2) {
    logger.warn('[TennisH2HBridge] Unexpected name format, using as-is', { rankingsName, parts });
    return rankingsName;
  }
  const [surname, given] = parts;
  return `${given} ${surname}`;
}

/**
 * Resolves a fixture-supplied slug to a full name via the rankings
 * map, already reordered to the Given-Surname order tennisAbstractScraper
 * expects. Returns null if the player isn't in the top-200 rankings —
 * there's no reliable fallback from an abbreviated initial alone.
 */
function resolveFullName(slug: string, rankingsBySlug: Map<string, PlayerRanking>): string | null {
  const ranking = rankingsBySlug.get(slug);
  if (!ranking) return null;
  return reorderToGivenSurname(ranking.name);
}

export interface H2HBridgeResult {
  h2h: TennisAbstractH2H | null;
  player1FullName: string | null;
  player2FullName: string | null;
  skippedReason?: 'player1_unranked' | 'player2_unranked' | 'both_unranked';
}

/**
 * Attempts to fetch H2H data for a single fixture by resolving both
 * players' slugs to full names via the rankings map, then delegating
 * to scrapeTennisH2H(). Returns a skippedReason (no H2H fetch attempted)
 * if either player falls outside the top-200 rankings coverage.
 */
export async function fetchH2HForFixture(
  fixture: TennisFixture,
  rankingsBySlug: Map<string, PlayerRanking>,
): Promise<H2HBridgeResult> {
  const player1FullName = resolveFullName(fixture.player1Slug, rankingsBySlug);
  const player2FullName = resolveFullName(fixture.player2Slug, rankingsBySlug);

  if (!player1FullName && !player2FullName) {
    logger.info('[TennisH2HBridge] Both players unranked, skipping H2H', {
      player1: fixture.player1Name,
      player2: fixture.player2Name,
    });
    return { h2h: null, player1FullName, player2FullName, skippedReason: 'both_unranked' };
  }
  if (!player1FullName) {
    logger.info('[TennisH2HBridge] Player 1 unranked, skipping H2H', { player1: fixture.player1Name });
    return { h2h: null, player1FullName, player2FullName, skippedReason: 'player1_unranked' };
  }
  if (!player2FullName) {
    logger.info('[TennisH2HBridge] Player 2 unranked, skipping H2H', { player2: fixture.player2Name });
    return { h2h: null, player1FullName, player2FullName, skippedReason: 'player2_unranked' };
  }

  const h2h = await scrapeTennisH2H(player1FullName, player2FullName);
  return { h2h, player1FullName, player2FullName };
}

/**
 * Convenience: fetches the rankings-by-slug map once for a tour, then
 * resolves H2H for every fixture in that tour's fixture list. Use this
 * over calling fetchH2HForFixture() per-fixture with a fresh
 * fetchRankingsBySlug() call each time — rankings are cached 24h by
 * tennisRankingsScraper itself, but there's no reason to even hit that
 * cache lookup once per fixture when one Map covers the whole batch.
 */
export async function fetchH2HForFixtures(
  fixtures: TennisFixture[],
  tour: TennisTour,
): Promise<Map<string, H2HBridgeResult>> {
  const rankingsBySlug = await fetchRankingsBySlug(tour);
  const results = new Map<string, H2HBridgeResult>();

  for (const fixture of fixtures) {
    const result = await fetchH2HForFixture(fixture, rankingsBySlug);
    results.set(fixture.sourceMatchId, result);
  }

  return results;
}