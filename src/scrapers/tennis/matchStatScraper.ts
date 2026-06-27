// src/scrapers/tennis/matchStatScraper.ts
//
// Scrapes matchstat.com's H2H comparison pages for tennis stats.
// URL pattern: https://matchstat.com/tennis/h2h-odds-bets/{Player1}/{Player2}/
//
// This is a thin wrapper that uses web_fetch-style content — since this
// project's scraper layer fetches raw HTML, this module expects the raw
// HTML string as input and extracts the fields below using regex.
// (Swap in `fetch()` + cheerio if running outside the agent environment.)

import { logger } from '../../core/utils/logger';

export interface TennisH2HStats {
  player1: string;
  player2: string;
  h2hWins: { player1: number; player2: number };
  h2hTotal: number;
  /**
   * KNOWN LIMITATION: matchstat.com renders the "Last Matches Played"
   * W/L table via client-side React (data-dgst="BAILOUT_TO_CLIENT_SIDE_RENDERING"),
   * meaning it is NOT present in the raw server-rendered HTML and cannot
   * be scraped with a plain fetch(). Always returns empty arrays.
   * Would require a headless browser (Playwright) to resolve — not yet built.
   */
  recentForm: { player1: ('W' | 'L')[]; player2: ('W' | 'L')[] };
  careerWinPct: { player1: number; player2: number };
  ytdWinPct: { player1: number; player2: number };
  surfaceBest: { player1: string | null; player2: string | null };
  lastMatch: {
    date: string | null;
    surface: string | null;
    winner: string | null;
    score: string | null;
  } | null;
}

function buildUrl(player1: string, player2: string): string {
  const enc = (name: string) => encodeURIComponent(name.trim());
  return `https://matchstat.com/tennis/h2h-odds-bets/${enc(player1)}/${enc(player2)}/`;
}

/**
 * Parses the raw HTML/markdown text of a matchstat.com H2H page
 * into structured stats. Designed to be resilient — if a field
 * can't be found, it's left null/0 rather than throwing, so partial
 * data still flows through to buildDefaultStats-style fallback.
 */
function parseH2HPage(html: string, player1: string, player2: string): TennisH2HStats {
  const stats: TennisH2HStats = {
    player1,
    player2,
    h2hWins: { player1: 0, player2: 0 },
    h2hTotal: 0,
    recentForm: { player1: [], player2: [] },
    careerWinPct: { player1: 0, player2: 0 },
    ytdWinPct: { player1: 0, player2: 0 },
    surfaceBest: { player1: null, player2: null },
    lastMatch: null,
  };

  try {
    // ── H2H RECORD ──────────────────────────────────────
    // Pattern: "Fritz leads the head-to-head 7-1 across 8 meetings."
    // or:      "Head-to-head: Tiafoe 1 - 7 Fritz"
    const h2hMatch = html.match(/Head-to-head:\s*\S+\s+(\d+)\s*-\s*(\d+)\s*\S+/i);
    if (h2hMatch) {
      stats.h2hWins.player1 = parseInt(h2hMatch[1], 10);
      stats.h2hWins.player2 = parseInt(h2hMatch[2], 10);
      stats.h2hTotal = stats.h2hWins.player1 + stats.h2hWins.player2;
    }

    // ── CAREER WIN % ────────────────────────────────────
    // Pattern from "Head-to-head Player Data" table:
    // "58.99% (433-301)" appearing under "Career Total W/L"
    const careerMatches = [...html.matchAll(/(\d+\.\d+)%\s*\((\d+)-(\d+)\)/g)];
    if (careerMatches.length >= 2) {
      stats.careerWinPct.player1 = parseFloat(careerMatches[0][1]) / 100;
      stats.careerWinPct.player2 = parseFloat(careerMatches[1][1]) / 100;
    }

    // ── YTD WIN % ───────────────────────────────────────
    const ytdMatches = [...html.matchAll(/(\d+\.\d+)%\s*\((\d+)-(\d+)\)/g)];
    // YTD typically appears later in the "H2H Profile" table — best effort,
    // fall back to career numbers if not distinctly found
    if (ytdMatches.length >= 4) {
      stats.ytdWinPct.player1 = parseFloat(ytdMatches[2][1]) / 100;
      stats.ytdWinPct.player2 = parseFloat(ytdMatches[3][1]) / 100;
    } else {
      stats.ytdWinPct = { ...stats.careerWinPct };
    }

    // ── RECENT FORM ──────────────────────────────────────
    // Not extractable via plain fetch() — see KNOWN LIMITATION on the
    // recentForm field above. Left as empty arrays (the type default).

    // ── SURFACE LEAN ────────────────────────────────────
    // Real sentence structure varies per player and doesn't follow a fixed
    // player1/player2 order, e.g.:
    // "Fritz's best career results come on grass (67%), while Tiafoe's
    //  top surface has been clay (67%)."
    // Search within the "Surface lean" paragraph specifically, not the
    // whole page, to avoid matching the wrong mention of the player's name.
    const surfacePatterns = [
      /best career results come on (\w+)/i,
      /top surface has been (\w+)/i,
    ];

    const surfaceLeanSection = html.match(/Surface lean<\/strong>([\s\S]{0,500}?)<\/p>/i);
    if (surfaceLeanSection) {
      const sectionText = surfaceLeanSection[1];
      const p1Last = player1.split(' ').pop() || player1;
      const p2Last = player2.split(' ').pop() || player2;

      const p1Idx = sectionText.search(new RegExp(escapeRegex(p1Last), 'i'));
      const p2Idx = sectionText.search(new RegExp(escapeRegex(p2Last), 'i'));

      if (p1Idx !== -1) {
        const after = sectionText.slice(p1Idx, p1Idx + 100);
        for (const pattern of surfacePatterns) {
          const m = after.match(pattern);
          if (m) { stats.surfaceBest.player1 = m[1].toLowerCase(); break; }
        }
      }
      if (p2Idx !== -1) {
        const after = sectionText.slice(p2Idx, p2Idx + 100);
        for (const pattern of surfacePatterns) {
          const m = after.match(pattern);
          if (m) { stats.surfaceBest.player2 = m[1].toLowerCase(); break; }
        }
      }
    }

    // ── LAST MATCH ──────────────────────────────────────
    // Pattern: "The last match between X and Y was at the U.S. Open - New York,
    //           2024-09-06, Round: Semifinals, Surface: Hard, with Y getting the victory 4-6 7-5 4-6 6-4 6-1."
    const lastMatchRe = /The last match between [\s\S]*?was at the ([^,]+),\s*(\d{4}-\d{2}-\d{2}),\s*Round:\s*[^,]+,\s*Surface:\s*(\w+),\s*with\s+([\s\S]*?)\s+getting the victory\s+([\d\s\-()]+)\./i;
    const lastMatch = html.match(lastMatchRe);
    if (lastMatch) {
      stats.lastMatch = {
        date: lastMatch[2],
        surface: lastMatch[3].toLowerCase(),
        winner: lastMatch[4].trim(),
        score: lastMatch[5].trim(),
      };
    }
  } catch (err: any) {
    logger.warn('[MatchStatScraper] Parse error', { error: err.message, player1, player2 });
  }

  return stats;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Fetches and parses H2H stats for a tennis matchup.
 * `fetchHtml` is injected so this works both with the agent's web_fetch
 * tool and with a plain `fetch()` call in the real project.
 */
export async function scrapeTennisH2H(
  player1: string,
  player2: string,
  fetchHtml: (url: string) => Promise<string>,
): Promise<TennisH2HStats | null> {
  const url = buildUrl(player1, player2);

  try {
    const html = await fetchHtml(url);
    const stats = parseH2HPage(html, player1, player2);

    logger.info('[MatchStatScraper] Fetched H2H stats', {
      matchup: `${player1} vs ${player2}`,
      h2h: `${stats.h2hWins.player1}-${stats.h2hWins.player2}`,
      careerWinPct: stats.careerWinPct,
    });

    return stats;
  } catch (err: any) {
    logger.warn('[MatchStatScraper] Failed to fetch H2H page', {
      url,
      error: err.message,
    });
    return null;
  }
}