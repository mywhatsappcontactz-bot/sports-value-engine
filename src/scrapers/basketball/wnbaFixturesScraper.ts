// src/scrapers/basketball/wnbaFixturesScraper.ts
//
// Free WNBA match-schedule source for the tipscanner path, mirroring
// nbaFixturesScraper.ts. Verified against a real fetch of
// basketball-reference.com/wnba/years/2026_games.html (1 Aug 2026):
// identical field structure to the NBA schedule pages (date_game via
// csk="YYYYMMDD..." prefix, visitor_team_name, visitor_pts,
// home_team_name, home_pts) — but unlike NBA, the WNBA's shorter season
// (~4.5 months) fits on ONE page, no monthly split needed.
//
// Team names returned match WNBA_TEAM_CODES in basketballReferenceScraper.ts
// exactly (same source, same naming).
import { logger } from '../../core/utils/logger';

export interface WNBAFixtureEntry {
  date: string;        // ISO date, YYYY-MM-DD
  homeTeam: string;
  awayTeam: string;
  played: boolean;
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

async function defaultFetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Same parsing approach as nbaFixturesScraper.ts's parseMonthPage — the
// csk="YYYYMMDD..." prefix on the date_game row is the reliable source
// of the actual date, not the display text.
function parseSchedulePage(html: string): WNBAFixtureEntry[] {
  const fixtures: WNBAFixtureEntry[] = [];

  const rowRegex = /<tr ><th scope="row" class="left " data-stat="date_game" csk="(\d{8})[^"]*"[^>]*>[\s\S]*?<\/tr>/g;
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[0];
    const dateDigits = match[1];

    const visitorMatch = row.match(/data-stat="visitor_team_name"[^>]*><a[^>]*>([^<]+)<\/a>/);
    const homeMatch = row.match(/data-stat="home_team_name"[^>]*><a[^>]*>([^<]+)<\/a>/);
    if (!visitorMatch || !homeMatch) continue;

    const visitorPtsMatch = row.match(/data-stat="visitor_pts"\s*>(\d*)</);
    const homePtsMatch = row.match(/data-stat="home_pts"\s*>(\d*)</);
    const played = !!(visitorPtsMatch && visitorPtsMatch[1] && homePtsMatch && homePtsMatch[1]);

    const isoDate = `${dateDigits.slice(0, 4)}-${dateDigits.slice(4, 6)}-${dateDigits.slice(6, 8)}`;

    fixtures.push({
      date: isoDate,
      awayTeam: visitorMatch[1],
      homeTeam: homeMatch[1],
      played,
    });
  }

  return fixtures;
}

/**
 * Fetches upcoming (unplayed) WNBA fixtures within `daysAhead` of `from`.
 * WNBA season pages are single-page (no monthly split), so this is one
 * fetch regardless of window size. Outside the WNBA season (roughly
 * Oct-Apr), this will simply return an empty list — no separate
 * off-season guard needed since there's nothing to filter to.
 */
export async function fetchWNBAFixtures(
  daysAhead: number = 7,
  from: Date = new Date(),
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
): Promise<WNBAFixtureEntry[]> {
  // WNBA season year = calendar year (no Oct-Jun offset like NBA).
  const seasonYear = from.getFullYear();
  const url = `https://www.basketball-reference.com/wnba/years/${seasonYear}_games.html`;

  let allFixtures: WNBAFixtureEntry[] = [];
  try {
    logger.info('[WnbaFixtures] Fetching season schedule', { seasonYear, url });
    const html = await fetchHtml(url);
    allFixtures = parseSchedulePage(html);
  } catch (err: any) {
    logger.warn('[WnbaFixtures] Schedule fetch failed', { seasonYear, error: err.message });
    return [];
  }

  const endDate = new Date(from.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  const fromIso = from.toISOString().slice(0, 10);
  const toIso = endDate.toISOString().slice(0, 10);

  const upcoming = allFixtures.filter(f => !f.played && f.date >= fromIso && f.date <= toIso);

  logger.info('[WnbaFixtures] Upcoming fixtures found', {
    count: upcoming.length,
    window: `${fromIso} to ${toIso}`,
  });

  return upcoming;
}