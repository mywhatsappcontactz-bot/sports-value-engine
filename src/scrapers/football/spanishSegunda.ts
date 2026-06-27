// src/scrapers/football/spanishSegunda.ts
import { BaseScraper, LeagueConfig, TeamConfig } from '../baseScraper';
import { logger } from '../../core/utils/logger';

// Spanish Segunda Division teams on footystats.org
// You'll need to find the actual URLs for each team
const TEAMS: TeamConfig[] = [
  { name: 'Racing Santander', url: 'https://footystats.org/clubs/real-racing-club-de-santander-319', slug: 'racing-santander' },
  { name: 'Almeria', url: 'https://footystats.org/clubs/ud-almeria-...', slug: 'almeria' },
  // Add all 22 teams
];

const LEAGUE: LeagueConfig = {
  name: 'Spanish Segunda Division',
  teams: TEAMS,
};

export async function scrapeSpanishSegunda(): Promise<void> {
  const scraper = new BaseScraper();

  try {
    await scraper.init();

    for (const team of LEAGUE.teams) {
      logger.info(`[Scraper] Processing ${team.name}`);
      const matches = await scraper.scrapeTeamFixtures(team);
      scraper.saveMatchesToDb(matches, LEAGUE.name);
      
      // Rate limit - be nice to the server
      await new Promise(r => setTimeout(r, 2000));
    }

    logger.info('[Scraper] Spanish Segunda scrape complete');

  } finally {
    await scraper.close();
  }
}

// Run if called directly
if (require.main === module) {
  scrapeSpanishSegunda().catch(err => {
    logger.error('[Scraper] Fatal error', { error: err.message });
    process.exit(1);
  });
}