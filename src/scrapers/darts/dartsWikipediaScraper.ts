// src/scrapers/darts/dartsWikipediaScraper.ts
//
// Supplementary source for the "Most 180s" tip market — ONLY viable
// for PDC major tournaments, where Wikipedia publishes detailed
// per-match box scores (100+/140+/180s/checkout%). Regular Pro Tour/
// Euro Tour events do NOT get this treatment on Wikipedia (confirmed:
// the 2026 PDC Players Championship series page only lists date,
// venue, winner, final score — no per-match stat breakdown).
//
// Wikipedia itself is never Cloudflare-blocked or rate-limited in
// practice — safe, reliable fetch target, no auth needed.

import { logger } from '../../core/utils/logger';

const WIKI_BASE = 'https://en.wikipedia.org/wiki';

// ─── MAJOR TOURNAMENT CALENDAR (2026, confirmed via PDC's official
// released schedule) ──────────────────────────────────────────────────
// Only tournaments in this list are eligible for the most_180s tip
// market. Dates are inclusive. Update this list at the start of each
// season once PDC releases the new calendar.

export interface MajorTournament {
  name: string;
  slug: string;       // Wikipedia article slug
  startDate: string;  // YYYY-MM-DD
  endDate: string;    // YYYY-MM-DD
}

export const MAJOR_TOURNAMENTS: MajorTournament[] = [
  {
    name: 'PDC World Darts Championship',
    slug: '2026_PDC_World_Darts_Championship',
    startDate: '2025-12-11',
    endDate: '2026-01-03',
  },
  {
    name: 'PDC World Masters',
    slug: '2026_PDC_World_Masters',
    startDate: '2026-01-29',
    endDate: '2026-02-01',
  },
  {
    name: 'UK Open',
    slug: '2026_UK_Open',
    startDate: '2026-03-06', // TBC exact dates — verify against PDC.tv closer to the event
    endDate: '2026-03-08',
  },
  {
    name: 'Premier League Darts',
    // Premier League runs as a season (Feb–May, weekly nights) then
    // playoffs — treat the whole season window as "in session" since
    // Wikipedia's Premier League page tracks stats across the season,
    // not per-night.
    slug: '2026_Premier_League_Darts',
    startDate: '2026-02-05',
    endDate: '2026-05-28',
  },
  {
    name: 'PDC World Cup of Darts',
    slug: '2026_PDC_World_Cup_of_Darts',
    startDate: '2026-06-11',
    endDate: '2026-06-14',
  },
  {
    name: 'World Matchplay',
    slug: '2026_World_Matchplay',
    startDate: '2026-07-18',
    endDate: '2026-07-26',
  },
  {
    name: 'World Series of Darts Finals',
    slug: '2026_World_Series_of_Darts_Finals',
    startDate: '2026-09-17',
    endDate: '2026-09-20',
  },
  {
    name: 'World Grand Prix',
    slug: '2026_World_Grand_Prix_(darts)',
    startDate: '2026-09-28',
    endDate: '2026-10-04',
  },
  {
    name: 'European Championship',
    slug: '2026_European_Championship_(darts)',
    startDate: '2026-10-22',
    endDate: '2026-10-25',
  },
  {
    name: 'Grand Slam of Darts',
    slug: '2026_Grand_Slam_of_Darts',
    startDate: '2026-11-07', // TBC exact dates — verify closer to event
    endDate: '2026-11-15',
  },
  {
    name: 'Players Championship Finals',
    slug: '2026_Players_Championship_Finals',
    startDate: '2026-11-20', // TBC exact dates — verify closer to event
    endDate: '2026-11-22',
  },
];

/**
 * Returns the major tournament active on the given date, or null if
 * none is in session. Handles the World Championship's year-boundary
 * span (Dec–Jan) correctly since comparison is by full ISO date
 * string, not month/day alone.
 */
export function getActiveMajor(date: Date = new Date()): MajorTournament | null {
  const iso = date.toISOString().split('T')[0]; // YYYY-MM-DD

  for (const t of MAJOR_TOURNAMENTS) {
    if (iso >= t.startDate && iso <= t.endDate) {
      return t;
    }
  }
  return null;
}

export function isMajorInSession(date: Date = new Date()): boolean {
  return getActiveMajor(date) !== null;
}

// ─── BOX SCORE TYPES ──────────────────────────────────────────────────────────

export interface DartsBoxScore {
  player: string;
  average: number | null;
  hundredPlus: number | null;
  hundredFortyPlus: number | null;
  oneEighties: number | null;
  highestCheckout: number | null;
  checkoutAttempts: number | null;
  checkoutHits: number | null;
  checkoutPct: number | null;
}

export interface DartsMajorMatch {
  round: string;
  player1: string;
  player2: string;
  player1Avg: number | null;
  player2Avg: number | null;
  winner: string;
  boxScore: { player1: DartsBoxScore; player2: DartsBoxScore } | null;
}

// ─── FETCH ────────────────────────────────────────────────────────────────────
// CONFIRMED structure (from a real fetch of 2026_PDC_World_Darts_Championship):
//   - Round-by-round match list: "Match no.: Round; Player 1; Score; Player 2;
//     Set 1; Set 2; ..." with each player's 3-dart average inline, e.g.
//     "Luke Littler 101.54; 3–0; Darius Labanauskas 95.25"
//   - A detailed final-match box score table (100+ scores, 140+ scores,
//     180 scores, Highest checkout, 100+ Checkouts, Checkout summary)
//     — but ONLY for the final match, not every match in the bracket.
//   - A separate "high averages" summary table listing every 100+ average
//     achieved, with player/round/opponent/result — this is the most
//     reliable source of PER-MATCH averages across the whole tournament,
//     but does NOT include 180s/checkout% per match (only for the final).
//
// PRACTICAL IMPLICATION: reliable per-match 180s/checkout% data from
// Wikipedia is really only available for the FINAL of a major, not
// every round. For a "most 180s across the tournament" tip, the
// tournament-level summary stat (e.g. "Littler won Most 180s with 73")
// mentioned in the prose is the most consistently available data point
// — not a per-match breakdown. Treat per-match 180s as best-effort/
// often-null; the aggregate tournament leader stat is more reliable.

export async function fetchMajorSummary(slug: string): Promise<string | null> {
  try {
    const url = `${WIKI_BASE}/${slug}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; sports-value-engine/1.0)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err: any) {
    logger.error('[DartsWiki] Fetch failed', { slug, error: err.message });
    return null;
  }
}

/**
 * Extracts the tournament-level "most 180s" leader from prose, e.g.
 * "He also won the 'Ballon d'Art' award for the most 180s at the
 * tournament, with 73." This is the MOST RELIABLE 180s data point
 * available — per-match 180s counts are not consistently present
 * except for the final. Returns null if the pattern isn't found
 * (older tournaments/different phrasing may not match).
 */
export function parseMost180sLeader(html: string): { player: string; count: number } | null {
  const patterns = [
    /most 180s at the tournament,?\s*with\s*(\d+)/i,
    /(\w[\w' .-]*?)\s+(?:hit|recorded|threw)\s+the most 180s[^\d]*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const m = pattern.exec(html);
    if (m) {
      // First pattern only captures the count; the player is usually
      // named in the preceding sentence ("Littler ... also won the
      // 'Ballon d'Art' award"). This needs manual verification per
      // tournament write-up since phrasing varies — flagging as
      // best-effort rather than fully reliable extraction.
      const count = parseInt(m[m.length - 1], 10);
      return { player: '', count }; // player name extraction needs refinement per-page
    }
  }
  return null;
}

/**
 * Parses per-match rows from the round-by-round results section.
 * CONFIRMED pattern (World Championship page):
 *   "01: 1; Kim Huybrechts 86.24; 1–3; Arno Merk 89.73; ..."
 * Format: "MatchNo: Round; Player1 Avg; Score; Player2 Avg; ..."
 */
export function parseMajorMatches(html: string): DartsMajorMatch[] {
  const matches: DartsMajorMatch[] = [];

  // Matches lines like: "Player Name ##.##; N–M; Player Name ##.##"
  const rowRegex = /([A-Za-zÀ-ÿ' .-]+?)\s+(\d{2,3}\.\d{2})\s*;\s*(\d+)[–-](\d+)\s*;\s*([A-Za-zÀ-ÿ' .-]+?)\s+(\d{2,3}\.\d{2})/g;

  let m;
  while ((m = rowRegex.exec(html)) !== null) {
    const [, p1, avg1, s1, s2, p2, avg2] = m;
    const score1 = parseInt(s1, 10);
    const score2 = parseInt(s2, 10);

    matches.push({
      round: '', // round context requires tracking preceding day/session headers — refine when wiring in
      player1: p1.trim(),
      player2: p2.trim(),
      player1Avg: parseFloat(avg1),
      player2Avg: parseFloat(avg2),
      winner: score1 > score2 ? p1.trim() : p2.trim(),
      boxScore: null, // only available for the final match — see fetchFinalBoxScore
    });
  }

  return matches;
}

/**
 * Parses the detailed final-match box score (100+/140+/180s/checkout%),
 * which Wikipedia only provides for the tournament's final match.
 * CONFIRMED structure (World Championship 2026 final, Littler vs Van Veen):
 *   | 106.02 | Average (3 darts) | 99.94 |
 *   | 42 | 100+ scores | 39 |
 *   | 19 | 140+ scores | 18 |
 *   | 16 | 180 scores | 9 |
 *   | 170 | Highest checkout | 145 |
 *   | 4 | 100+ Checkouts | 4 |
 *   | 23/50 (46%) | Checkout summary | 8/21 (38%) |
 */
export function parseFinalBoxScore(html: string, player1: string, player2: string): { player1: DartsBoxScore; player2: DartsBoxScore } | null {
  const extractPair = (label: string): [string, string] | null => {
    const regex = new RegExp(`\\|\\s*([^|]+?)\\s*\\|\\s*${label}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'i');
    const m = regex.exec(html);
    return m ? [m[1].trim(), m[2].trim()] : null;
  };

  const avg = extractPair('Average \\(3 darts\\)');
  const hundredPlus = extractPair('100\\+ scores');
  const hundredForty = extractPair('140\\+ scores');
  const oneEighty = extractPair('180 scores');
  const highCheckout = extractPair('Highest checkout');
  const checkoutSummary = extractPair('Checkout summary');

  if (!avg && !oneEighty) {
    logger.warn('[DartsWiki] No final box score found on page — may not be the right slug or page lacks this section');
    return null;
  }

  const parseCheckoutPct = (raw: string | undefined): number | null => {
    if (!raw) return null;
    const m = /\(([\d.]+)%\)/.exec(raw);
    return m ? parseFloat(m[1]) : null;
  };

  const build = (idx: 0 | 1, name: string): DartsBoxScore => ({
    player: name,
    average: avg ? parseFloat(avg[idx]) : null,
    hundredPlus: hundredPlus ? parseInt(hundredPlus[idx], 10) : null,
    hundredFortyPlus: hundredForty ? parseInt(hundredForty[idx], 10) : null,
    oneEighties: oneEighty ? parseInt(oneEighty[idx], 10) : null,
    highestCheckout: highCheckout ? parseInt(highCheckout[idx], 10) : null,
    checkoutAttempts: null,
    checkoutHits: null,
    checkoutPct: parseCheckoutPct(checkoutSummary?.[idx]),
  });

  return {
    player1: build(0, player1),
    player2: build(1, player2),
  };
}