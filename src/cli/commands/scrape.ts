import 'dotenv/config';
import { getDb } from '../../core/database/db';
import { logger } from '../../core/utils/logger';
import { fetchLeagueData, findTeam, FCSTATS_LEAGUE_MAP } from '../../scrapers/football/fcStatsScraper';
import { Cleaner } from '../../data-bridge/cleaner';
import { v4 as uuidv4 } from 'uuid';

const cleaner = new Cleaner();
const db = getDb();

const FOOTBALL_LEAGUES = Object.keys(FCSTATS_LEAGUE_MAP);

async function scrapeFootball(): Promise<void> {
  let totalStatsSaved = 0;
  let totalFailed = 0;

  for (const leagueName of FOOTBALL_LEAGUES) {
    logger.info(`[Scrape] Fetching league stats`, { leagueName });

    const leagueData = await fetchLeagueData(leagueName);
    if (!leagueData) {
      logger.warn(`[Scrape] Failed to fetch league`, { leagueName });
      totalFailed++;
      continue;
    }

    const matches = db.prepare(`
      SELECT id, homeTeam, awayTeam, externalId
      FROM matches
      WHERE sport = 'football'
      AND league = ?
      AND status = 'upcoming'
    `).all(leagueName) as { id: string; homeTeam: string; awayTeam: string; externalId: string }[];

    logger.info(`[Scrape] Processing ${matches.length} matches for ${leagueName}`);

    for (const match of matches) {
      try {
        const homeTeamData = findTeam(leagueData, match.homeTeam);
        const awayTeamData = findTeam(leagueData, match.awayTeam);

        if (!homeTeamData || !awayTeamData) {
          logger.warn(`[Scrape] Team not found in FCStats`, {
            home:      match.homeTeam,
            away:      match.awayTeam,
            homeFound: !!homeTeamData,
            awayFound: !!awayTeamData,
          });
          continue;
        }

        const homeForm = homeTeamData.recentResults.map(r => ({
          date:         r.date,
          opponent:     r.opponent,
          result:       r.result,
          goalsFor:     r.goalsFor,
          goalsAgainst: r.goalsAgainst,
          venue:        r.venue,
        }));

        const awayForm = awayTeamData.recentResults.map(r => ({
          date:         r.date,
          opponent:     r.opponent,
          result:       r.result,
          goalsFor:     r.goalsFor,
          goalsAgainst: r.goalsAgainst,
          venue:        r.venue,
        }));

        const homeGoalsAvg = homeForm.length > 0
          ? parseFloat((homeForm.reduce((s, r) => s + r.goalsFor, 0) / homeForm.length).toFixed(2))
          : 0;
        const awayGoalsAvg = awayForm.length > 0
          ? parseFloat((awayForm.reduce((s, r) => s + r.goalsFor, 0) / awayForm.length).toFixed(2))
          : 0;

        const hasForm  = homeForm.length >= 3 && awayForm.length >= 3;
        const hasGoals = homeGoalsAvg > 0 && awayGoalsAvg > 0;
        const completeness = [hasForm, hasGoals].filter(Boolean).length / 2;

        const rawStats = {
          externalMatchId: match.externalId,
          sport:           'football',
          homeGoalsAvg,
          awayGoalsAvg,
          h2h:             [],
          homeForm,
          awayForm,
          referee: {
            name:           '',
            avgYellowCards: 0,
            avgRedCards:    0,
            avgFouls:       0,
          },
          situational: {
            weather:     'unknown',
            temperature: 15,
            fatigueDays: 5,
            surfaceType: 'grass',
          },
          confidenceFactors: {
            dataCompleteness: parseFloat(completeness.toFixed(2)),
          },
          additionalContext: {
            source:       'fcstats',
            homeGoalsAvg,
            awayGoalsAvg,
          },
        };

        const cleanedStats = cleaner.cleanStats(rawStats, match.id, 'football');
        if (!cleanedStats) {
          logger.warn(`[Scrape] Stats cleaning failed`, { match: `${match.homeTeam} vs ${match.awayTeam}` });
          continue;
        }

        db.prepare(`
          INSERT INTO stats (
            id, matchId, sport, h2h, homeForm, awayForm,
            referee, situational, additionalContext, confidenceFactors, lastUpdated
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(matchId) DO UPDATE SET
            homeForm          = excluded.homeForm,
            awayForm          = excluded.awayForm,
            additionalContext = excluded.additionalContext,
            confidenceFactors = excluded.confidenceFactors,
            lastUpdated       = datetime('now')
        `).run(
          uuidv4(),
          match.id,
          'football',
          JSON.stringify(cleanedStats.h2h),
          JSON.stringify(cleanedStats.homeForm),
          JSON.stringify(cleanedStats.awayForm),
          JSON.stringify(cleanedStats.referee),
          JSON.stringify(cleanedStats.situational),
          JSON.stringify({ ...cleanedStats.additionalContext, homeGoalsAvg, awayGoalsAvg }),
          JSON.stringify(cleanedStats.confidenceFactors),
        );

        totalStatsSaved++;
        logger.info(`[Scrape] Stats saved`, {
          match:       `${match.homeTeam} vs ${match.awayTeam}`,
          homeGoalsAvg,
          awayGoalsAvg,
          formCount:   homeForm.length,
          completeness,
        });

      } catch (err: any) {
        totalFailed++;
        logger.error(`[Scrape] Match failed`, {
          match: `${match.homeTeam} vs ${match.awayTeam}`,
          error: err.message,
        });
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  logger.info(`[Scrape] Complete`, { totalStatsSaved, totalFailed });
  console.log(`\nScrape complete — stats saved: ${totalStatsSaved}, failed: ${totalFailed}`);
}

const sport = process.argv[2] || 'football';
if (sport === 'football') {
  scrapeFootball().catch(console.error);
} else {
  console.log(`Sport ${sport} not yet supported for scraping`);
}