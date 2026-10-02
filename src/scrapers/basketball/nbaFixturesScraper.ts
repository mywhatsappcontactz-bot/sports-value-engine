// src/scrapers/basketball/nbaFixturesScraper.ts
//
// Free NBA match-schedule source for the tipscanner path, using
// Basketball-Reference's monthly schedule pages — completely separate
// from the paid odds API (oddsClient.ts), which stays reserved for
// value-bet pricing. Verified against a real fetch of
// basketball-reference.com/leagues/NBA_2026_games-october.html (31 Jul
// 2026): fields are date_game (via csk="YYYYMMDD0XXX" prefix — more
// reliable than parsing the "Tue, Oct 21, 2025" display text),
// visitor_team_name, visitor_pts, home_team_name, home_pts. Points
// columns are empty for games that haven't been played yet, which is
// exactly how we distinguish "upcoming" from "completed" here.
//
// Team names returned match NBA_TEAM_CODES in nbaReferenceScraper.ts
// exactly (same source, same naming) — no fuzzy matching needed.
import { logger } from '../../core/utils/logger';

export interface NBAFixture {
  date: string;        // ISO date, YYYY-MM-DD
  homeTeam: string;
  awayTeam: string;
  played: boolean;      // true if home_pts/visitor_pts are populated
}

const MONTHS = ['october', 'november', 'december', 'january', 'february', 'march', 'april', 'may', 'june'] as const;
type MonthName = typeof MONTHS[number];

// NBA "season year" runs Oct(year-1) -> Jun(year), e.g. games in Oct 2025
// through Jun 2026 are all season "2026" on Basketball-Reference.
function seasonYearFor(date: Date): number {
  const month = date.getMonth(); // 0-indexed, so Oct = 9
  return month >= 9 ? date.getFullYear() + 1 : date.getFullYear();
}

// Oct/Nov/Dec belong to the calendar year BEFORE the season year;
// Jan-Jun belong to the season year itself. Needed to reconstruct a real
// ISO date from the page, since the visible date text ("Tue, Oct 21,
// 2025") isn't parsed directly — we use the more reliable csk prefix.
function calendarYearForMonth(month: MonthName, seasonYear: number): number {
  return ['october', 'november', 'december'].includes(month) ? seasonYear - 1 : seasonYear;
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

// Parses one monthly schedule page into fixtures. csk format observed:
// csk="202510210OKC" on the <th data-stat="date_game"> row — first 8
// chars are YYYYMMDD, safe to slice directly rather than parsing the
// display text (which is locale/format-fragile).
function parseMonthPage(html: string): NBAFixture[] {
  const fixtures: NBAFixture[] = [];

  // Each game is one <tr>...</tr> inside the schedule table body.
  const rowRegex = /<tr ><th scope="row" class="left " data-stat="date_game" csk="(\d{8})[^"]*"[\s\S]*?<\/tr>/g;
  let match: RegExpExecArray | null;

  while ((match = rowRegex.exec(html)) !== null) {
    const row = match[0];
    const dateDigits = match[1]; // YYYYMMDD

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
 * Fetches upcoming (unplayed) NBA fixtures within `daysAhead` of `from`
 * (defaults to now). Only touches the current month's page, plus the
 * next month's page if the window crosses a month boundary — avoids
 * fetching all 9 monthly pages when only a handful of days are needed.
 */
export async function fetchNBAFixtures(
  daysAhead: number = 7,
  from: Date = new Date(),
  fetchHtml: (url: string) => Promise<string> = defaultFetchHtml,
): Promise<NBAFixture[]> {
  const seasonYear = seasonYearFor(from);
  const monthIndex = from.getMonth(); // 0-indexed calendar month of `from`

  // Map calendar month -> Basketball-Reference month name, restricted to
  // the season's active months (Oct-Jun). Off-season calls (Jul/Aug/Sep)
  // return an empty list rather than erroring — there's no schedule page
  // for a month the season doesn't cover.
  const CAL_MONTH_TO_NAME: Record<number, MonthName> = {
    9: 'october', 10: 'november', 11: 'december',
    0: 'january', 1: 'february', 2: 'march', 3: 'april', 4: 'may', 5: 'june',
  };

  const monthsToFetch = new Set<MonthName>();
  const endDate = new Date(from.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  for (const m of [from.getMonth(), endDate.getMonth()]) {
    const name = CAL_MONTH_TO_NAME[m];
    if (name) monthsToFetch.add(name);
  }

  if (!monthsToFetch.size) {
    logger.info('[NbaFixtures] Outside NBA season months — no schedule page to fetch', {
      from: from.toISOString(),
    });
    return [];
  }

  const allFixtures: NBAFixture[] = [];

  for (const month of monthsToFetch) {
    const url = `https://www.basketball-reference.com/leagues/NBA_${seasonYear}_games-${month}.html`;
    try {
      logger.info('[NbaFixtures] Fetching month', { month, url });
      const html = await fetchHtml(url);
      allFixtures.push(...parseMonthPage(html));
    } catch (err: any) {
      logger.warn('[NbaFixtures] Month fetch failed', { month, error: err.message });
    }
  }

  const fromIso = from.toISOString().slice(0, 10);
  const toIso = endDate.toISOString().slice(0, 10);

  const upcoming = allFixtures.filter(f => !f.played && f.date >= fromIso && f.date <= toIso);

  logger.info('[NbaFixtures] Upcoming fixtures found', {
    count: upcoming.length,
    window: `${fromIso} to ${toIso}`,
  });

  return upcoming;
}