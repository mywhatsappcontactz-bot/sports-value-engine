// src/scrapers/baseScraper.ts
import { chromium, Browser, Page } from 'playwright';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';

export interface ScrapedMatch {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
}

export interface TeamConfig {
  name: string;
  url: string;
  slug: string;
}

export interface LeagueConfig {
  name: string;
  teams: TeamConfig[];
}

export class BaseScraper {
  private browser: Browser | null = null;

  async init(): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    logger.info('[Scraper] Browser launched');
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      logger.info('[Scraper] Browser closed');
    }
  }

  async scrapeTeamFixtures(team: TeamConfig): Promise<ScrapedMatch[]> {
    if (!this.browser) {
      throw new Error('Browser not initialized. Call init() first.');
    }

    const page = await this.browser.newPage();
    const matches: ScrapedMatch[] = [];

    try {
      logger.info(`[Scraper] Navigating to ${team.url}`);
      await page.goto(team.url, { waitUntil: 'networkidle', timeout: 30000 });

      // Wait for fixtures table to load
      await page.waitForSelector('table tbody tr, .fixtures-table tr, [data-testid="fixture-row"]', { timeout: 10000 });

      // Extract match rows
      const rows = await page.$$('table tbody tr, .fixtures-table tr, [data-testid="fixture-row"]');

      for (const row of rows) {
        try {
          const cells = await row.$$('td');
          if (cells.length < 4) continue;

          const date = await cells[0].innerText().catch(() => '');
          const homeTeam = await cells[1].innerText().catch(() => '');
          const scoreText = await cells[2].innerText().catch(() => '');
          const awayTeam = await cells[3].innerText().catch(() => '');

          // Parse score (e.g., "4 - 1" or "4-1")
          const scoreMatch = scoreText.match(/(\d+)\s*-\s*(\d+)/);
          if (!scoreMatch) continue;

          const homeScore = parseInt(scoreMatch[1]);
          const awayScore = parseInt(scoreMatch[2]);

          matches.push({
            date: date.trim(),
            homeTeam: homeTeam.trim(),
            awayTeam: awayTeam.trim(),
            homeScore,
            awayScore,
          });
        } catch (err) {
          logger.debug('[Scraper] Failed to parse row', { error: err });
        }
      }

      logger.info(`[Scraper] ${team.name}: ${matches.length} matches extracted`);

    } catch (err: any) {
      logger.error(`[Scraper] Failed to scrape ${team.name}`, { error: err.message });
    } finally {
      await page.close();
    }

    return matches;
  }

  saveMatchesToDb(matches: ScrapedMatch[], leagueName: string): void {
    const db = getDb();

    for (const match of matches) {
      // Upsert match into database
      // This depends on your schema - adjust as needed
      db.prepare(`
        INSERT INTO matches (externalId, sport, league, homeTeam, awayTeam, startTime, status, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(externalId) DO UPDATE SET
          homeTeam = excluded.homeTeam,
          awayTeam = excluded.awayTeam,
          startTime = excluded.startTime
      `).run(
        `${match.homeTeam}-${match.awayTeam}-${match.date}`,
        'football',
        leagueName,
        match.homeTeam,
        match.awayTeam,
        this.parseDate(match.date),
        'finished',
        'footystats'
      );
    }

    logger.info(`[Scraper] Saved ${matches.length} matches to database`);
  }

  private parseDate(dateStr: string): string {
    // Parse "May 31" or "14.06.26" to ISO format
    // This is a simple parser - adjust for your date format
    const currentYear = new Date().getFullYear();
    
    // Try "May 31" format
    const monthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthMatch = dateStr.toLowerCase().match(/([a-z]{3,})\s+(\d{1,2})/);
    
    if (monthMatch) {
      const monthIndex = monthNames.findIndex(m => monthMatch[1].startsWith(m));
      if (monthIndex !== -1) {
        const day = parseInt(monthMatch[2]);
        return new Date(currentYear, monthIndex, day).toISOString();
      }
    }

    // Try "14.06.26" format
    const euroMatch = dateStr.match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (euroMatch) {
      const day = parseInt(euroMatch[1]);
      const month = parseInt(euroMatch[2]) - 1;
      const year = 2000 + parseInt(euroMatch[3]);
      return new Date(year, month, day).toISOString();
    }

    // Fallback
    return new Date().toISOString();
  }
}