// src/data-bridge/realFetcher.ts
import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import { oddsClient } from './apiClients/oddsClient';
import { scrapeTennisH2H, TennisAbstractH2H } from '../scrapers/tennis/tennisAbstractScraper';
import { fetchLeagueData, fetchH2H, findTeam, FCSTATS_LEAGUE_MAP } from '../scrapers/football/fcStatsScraper';
import { v4 as uuidv4 } from 'uuid';

export interface RealFetchResult {
  sport: string;
  matchesFetched: number;
  matchesSaved: number;
  oddsSaved: number;
  statsSaved: number;
  skipped: number;
  errors: number;
  correlationId: string;
  durationMs: number;
}

export const SUPPORTED_SPORTS = ['football', 'basketball', 'tennis', 'hockey'] as const;
export type Sport = typeof SUPPORTED_SPORTS[number];

async function fetchHtmlPlain(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// ─── TENNIS STATS MAPPING ──────────────────────────────────────────────────

function tennisStatsToRawStats(h2h: TennisAbstractH2H, externalMatchId: string): any {
  const syntheticH2H = h2h.matches.slice(0, 6).map(m => ({
    date: m.date,
    homeTeam: m.winner === h2h.player1 ? h2h.player1 : h2h.player2,
    awayTeam: m.winner === h2h.player1 ? h2h.player2 : h2h.player1,
    homeScore: 1,
    awayScore: 0,
  }));

  const hasSurfaceData = !!(h2h.player1Stats.surfaceBest || h2h.player2Stats.surfaceBest);

  return {
    externalMatchId,
    sport: 'tennis',
    confidenceFactors: {
      dataCompleteness: hasSurfaceData ? 0.75 : 0.65,
    },
    h2h: syntheticH2H,
    homeForm: [],
    awayForm: [],
    referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
    situational: { weather: 'clear', temperature: 20, fatigueDays: 7 },
    additionalContext: {
      surfaceType: h2h.player1Stats.surfaceBest || h2h.player2Stats.surfaceBest || 'hard',
      homeSurfaceSpecialist: h2h.player1Stats.surfaceBest,
      awaySurfaceSpecialist: h2h.player2Stats.surfaceBest,
      homeCareerWinPct: h2h.player1Stats.careerWinPct,
      awayCareerWinPct: h2h.player2Stats.careerWinPct,
      homeYtdWinPct: h2h.player1Stats.ytdWinPct,
      awayYtdWinPct: h2h.player2Stats.ytdWinPct,
    },
  };
}

// ─── FOOTBALL STATS MAPPING ─────────────────────────────────────────────────

function footballStatsToRawStats(
  h2h: Awaited<ReturnType<typeof fetchH2H>>,
  homeRecent: { result: 'W' | 'L' | 'D'; goalsFor: number; goalsAgainst: number; opponent: string; date: string; venue: 'home' | 'away' }[],
  awayRecent: { result: 'W' | 'L' | 'D'; goalsFor: number; goalsAgainst: number; opponent: string; date: string; venue: 'home' | 'away' }[],
  externalMatchId: string,
): any {
  const homeGoalsAvg = homeRecent.length
    ? homeRecent.reduce((s, r) => s + r.goalsFor, 0) / homeRecent.length
    : 1.2;
  const awayGoalsAvg = awayRecent.length
    ? awayRecent.reduce((s, r) => s + r.goalsFor, 0) / awayRecent.length
    : 1.0;

  const hasForm = homeRecent.length > 0 && awayRecent.length > 0;
  const hasH2H = !!h2h && h2h.recentMatches.length > 0;

  return {
    externalMatchId,
    sport: 'football',
    confidenceFactors: {
      dataCompleteness: hasForm && hasH2H ? 0.85 : hasForm ? 0.65 : 0.4,
    },
    h2h: h2h ? h2h.recentMatches.map(m => ({
      date: m.date,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
    })) : [],
    homeForm: homeRecent.map(r => ({
      date: r.date,
      opponent: r.opponent,
      result: r.result,
      goalsFor: r.goalsFor,
      goalsAgainst: r.goalsAgainst,
      venue: r.venue,
    })),
    awayForm: awayRecent.map(r => ({
      date: r.date,
      opponent: r.opponent,
      result: r.result,
      goalsFor: r.goalsFor,
      goalsAgainst: r.goalsAgainst,
      venue: r.venue,
    })),
    referee: {},
    situational: {},
    additionalContext: {
      homeGoalsAvg,
      awayGoalsAvg,
    },
  };
}

// ─── TEAM MAPPING HELPERS ────────────────────────────────────────────────────

function normalize(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function saveTeamMapping(sport: string, teamName: string, oddspapiParticipantId?: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO team_mappings (id, sport, teamName, teamNameNormalized, oddspapiParticipantId)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(sport, teamNameNormalized) DO UPDATE SET
      oddspapiParticipantId = excluded.oddspapiParticipantId
  `).run(uuidv4(), sport, teamName, normalize(teamName), oddspapiParticipantId ?? null);
}

// ─── REAL FETCHER ─────────────────────────────────────────────────────────────

export class RealFetcher {
  private repo: Repository;
  private cleaner: Cleaner;
  private validator: Validator;

  constructor() {
    this.repo = new Repository(getDb());
    this.cleaner = new Cleaner();
    this.validator = new Validator();
  }

  async fetchSport(sport: Sport): Promise<RealFetchResult> {
    const correlationId = uuidv4();
    const start = Date.now();

    const result: RealFetchResult = {
      sport,
      matchesFetched: 0,
      matchesSaved: 0,
      oddsSaved: 0,
      statsSaved: 0,
      skipped: 0,
      errors: 0,
      correlationId,
      durationMs: 0,
    };

    logger.info(`[RealFetcher] Starting fetch`, { sport, correlationId });

    try {
      const { matches: rawMatches, oddsMap } = await oddsClient.fetchForSport(sport);
      result.matchesFetched = rawMatches.length;

      console.log(`[DEBUG] sport=${sport} rawMatches.length=${rawMatches.length} oddsMap.size=${oddsMap.size}`);

      if (!rawMatches.length) {
        logger.warn(`[RealFetcher] No matches returned`, { sport });
        result.durationMs = Date.now() - start;
        return result;
      }

      const cleanedMatches = this.cleaner.cleanMatches(rawMatches);
      const validMatches = this.validator.validateMatches(cleanedMatches);

      if (!validMatches.length) {
        result.skipped += result.matchesFetched;
        result.durationMs = Date.now() - start;
        return result;
      }

      // ── PRE-FETCH FOOTBALL LEAGUE TABLES ONCE PER SPORT RUN ──────────
      // Only store non-null results — null means FCStats failed for that league.
      const footballLeagueCache = new Map<string, NonNullable<Awaited<ReturnType<typeof fetchLeagueData>>>>();
      if (sport === 'football') {
        // Collect unique leagues present in this batch
        const leaguesInBatch = new Set(validMatches.map(m => m.league));
        console.log(`[DEBUG LEAGUES] leagues in batch:`, [...leaguesInBatch]);

        for (const leagueName of Object.keys(FCSTATS_LEAGUE_MAP)) {
          if (!leaguesInBatch.has(leagueName)) continue;
          const data = await fetchLeagueData(leagueName);
          if (data) {
            footballLeagueCache.set(leagueName, data);
            console.log(`[DEBUG LEAGUES] cached ${leagueName} — ${data.teams.size} teams`);
          } else {
            console.log(`[DEBUG LEAGUES] fetchLeagueData returned null for: ${leagueName}`);
          }
        }

        console.log(`[DEBUG LEAGUES] total cached: ${footballLeagueCache.size}/${leaguesInBatch.size} leagues`);
      }

      let tennisStatsFetched = 0;
      const MAX_TENNIS_STATS = 20;

      for (const match of validMatches) {
        try {
          const matchId = this.repo.upsertMatch(match);
          result.matchesSaved++;

          saveTeamMapping(sport, match.homeTeam, undefined);
          saveTeamMapping(sport, match.awayTeam, undefined);

          const rawOdds = oddsMap.get(match.externalId!) || [];
          if (rawOdds.length) {
            const cleanedOdds = this.cleaner.cleanOddsBatch(rawOdds, matchId);
            const validOdds = this.validator.validateOddsBatch(cleanedOdds);
            if (validOdds.length) {
              this.repo.saveOddsBatch(validOdds);
              result.oddsSaved += validOdds.length;
            }
          }

          // ── STATS ────────────────────────────────────────────────────
          if (sport === 'tennis' && tennisStatsFetched < MAX_TENNIS_STATS) {
            await this.fetchAndSaveTennisStats(match, matchId, result);
            tennisStatsFetched++;
            await new Promise(r => setTimeout(r, 5000));
          } else if (sport === 'football') {
            await this.fetchAndSaveFootballStats(match, matchId, footballLeagueCache, result);
          } else {
            logger.debug(`[RealFetcher] Stats not yet supported for ${sport}`, {
              home: match.homeTeam,
              away: match.awayTeam,
            });
          }

        } catch (err: any) {
          result.errors++;
          logger.error(`[RealFetcher] Match processing failed`, {
            match: `${match.homeTeam} vs ${match.awayTeam}`,
            error: err.message,
          });
        }
      }

    } catch (err: any) {
      result.errors++;
      logger.error(`[RealFetcher] Fatal fetch error`, { sport, error: err.message });
    }

    result.durationMs = Date.now() - start;

    logger.info(`[RealFetcher] Fetch complete`, {
      sport,
      matchesFetched: result.matchesFetched,
      matchesSaved: result.matchesSaved,
      oddsSaved: result.oddsSaved,
      statsSaved: result.statsSaved,
      errors: result.errors,
      durationMs: result.durationMs,
    });

    return result;
  }

  private async fetchAndSaveTennisStats(
    match: { homeTeam: string; awayTeam: string; externalId?: string },
    matchId: string,
    result: RealFetchResult,
  ): Promise<void> {
    try {
      const h2h = await scrapeTennisH2H(match.homeTeam, match.awayTeam, fetchHtmlPlain);

      if (!h2h) {
        logger.warn('[RealFetcher] No tennis H2H data found', {
          match: `${match.homeTeam} vs ${match.awayTeam}`,
        });
        return;
      }

      const rawStats = tennisStatsToRawStats(h2h, match.externalId!);
      const cleanedStats = this.cleaner.cleanStats(rawStats, matchId, 'tennis');
      if (!cleanedStats) return;

      const statsValidation = this.validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        logger.warn('[RealFetcher] Tennis stats failed validation', {
          match: `${match.homeTeam} vs ${match.awayTeam}`,
          errors: statsValidation.errors,
        });
        return;
      }

      if (statsValidation.confidenceAdjustment < 1) {
        cleanedStats.confidenceFactors.dataCompleteness = parseFloat(
          (cleanedStats.confidenceFactors.dataCompleteness * statsValidation.confidenceAdjustment).toFixed(4)
        );
      }

      this.repo.upsertStats(cleanedStats);
      result.statsSaved++;
      logger.info('[RealFetcher] Tennis stats saved', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        h2h: `${h2h.h2hWins.player1}-${h2h.h2hWins.player2}`,
      });

    } catch (scrapeErr: any) {
      logger.warn('[RealFetcher] Tennis scrape failed — continuing without stats', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        error: scrapeErr.message,
      });
    }
  }

  private async fetchAndSaveFootballStats(
    match: { homeTeam: string; awayTeam: string; league: string; externalId?: string },
    matchId: string,
    leagueCache: Map<string, NonNullable<Awaited<ReturnType<typeof fetchLeagueData>>>>,
    result: RealFetchResult,
  ): Promise<void> {
    try {
      const leagueData = leagueCache.get(match.league);
      if (!leagueData) {
        console.log(`[DEBUG STATS] no league data for "${match.league}" — skipping ${match.homeTeam} vs ${match.awayTeam}`);
        return;
      }

      const homeTeamStats = findTeam(leagueData, match.homeTeam);
      const awayTeamStats = findTeam(leagueData, match.awayTeam);

      console.log(`[DEBUG STATS] ${match.homeTeam} vs ${match.awayTeam} | homeFound=${!!homeTeamStats} awayFound=${!!awayTeamStats}`);

      if (!homeTeamStats || !awayTeamStats) {
        logger.debug('[RealFetcher] Could not match team names to FCStats data', {
          match: `${match.homeTeam} vs ${match.awayTeam}`,
          foundHome: !!homeTeamStats,
          foundAway: !!awayTeamStats,
        });
        return;
      }

      const h2h = await fetchH2H(match.homeTeam, match.awayTeam, leagueData);

      const rawStats = footballStatsToRawStats(
        h2h,
        homeTeamStats.recentResults,
        awayTeamStats.recentResults,
        match.externalId!,
      );

      const cleanedStats = this.cleaner.cleanStats(rawStats, matchId, 'football');
      if (!cleanedStats) {
        console.log(`[DEBUG STATS] cleanStats returned null for ${match.homeTeam} vs ${match.awayTeam}`);
        return;
      }

      const statsValidation = this.validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        console.log(`[DEBUG STATS] validation failed for ${match.homeTeam} vs ${match.awayTeam}:`, statsValidation.errors);
        logger.warn('[RealFetcher] Football stats failed validation', {
          match: `${match.homeTeam} vs ${match.awayTeam}`,
          errors: statsValidation.errors,
        });
        return;
      }

      if (statsValidation.confidenceAdjustment < 1) {
        cleanedStats.confidenceFactors.dataCompleteness = parseFloat(
          (cleanedStats.confidenceFactors.dataCompleteness * statsValidation.confidenceAdjustment).toFixed(4)
        );
      }

      this.repo.upsertStats(cleanedStats);
      result.statsSaved++;
      logger.info('[RealFetcher] Football stats saved', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        homeGP: homeTeamStats.gp,
        awayGP: awayTeamStats.gp,
      });

    } catch (scrapeErr: any) {
      logger.warn('[RealFetcher] Football scrape failed — continuing without stats', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        error: scrapeErr.message,
      });
    }
  }

  async fetchAll(): Promise<RealFetchResult[]> {
    const results: RealFetchResult[] = [];
    for (const sport of SUPPORTED_SPORTS) {
      const result = await this.fetchSport(sport);
      results.push(result);
      await new Promise(r => setTimeout(r, 500));
    }
    return results;
  }
}

export const realFetcher = new RealFetcher();