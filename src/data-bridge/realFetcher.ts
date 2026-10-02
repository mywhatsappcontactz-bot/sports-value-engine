// src/data-bridge/realFetcher.ts
import { Repository } from '../core/database/repository';
import { FormRecord } from '../core/database/schema';
import { getDb } from '../core/database/db';
import { logger } from '../core/utils/logger';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import { oddsClient } from './apiClients/oddsClient';
import { scrapeTennisH2H, TennisAbstractH2H } from '../scrapers/tennis/tennisAbstractScraper';
import { fetchLeagueData, fetchH2H, findTeam, FCSTATS_LEAGUE_MAP } from '../scrapers/football/fcStatsScraper';
import { v4 as uuidv4 } from 'uuid';
import { fetchFDCOH2H } from '../scrapers/football/footballDataScraper';
import { fetchWNBAH2H } from '../scrapers/basketball/wnbaScraper';
import { fetchNBAH2H } from '../scrapers/basketball/nbaScraper';
import { aggregateCornersForMatch } from '../core/engine/cornersAggregator';
import { fetchTeamResultsByName } from '../scrapers/football/teamResultsScraper';
import { SOCCERSTATS_LEAGUE_MAP } from '../scrapers/football/soccerStatsLeagueMap';

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

// ─── TENNIS STATS MAPPING ───────────────────────────────────────────────────

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
    homeForm: h2h.player1Stats.recentForm.map(f => ({
      date:         f.date,
      opponent:     f.opponent,
      result:       f.result,
      goalsFor:     f.goalsFor,
      goalsAgainst: f.goalsAgainst,
      venue:        f.venue,
    })),
    awayForm: h2h.player2Stats.recentForm.map(f => ({
      date:         f.date,
      opponent:     f.opponent,
      result:       f.result,
      goalsFor:     f.goalsFor,
      goalsAgainst: f.goalsAgainst,
      venue:        f.venue,
    })),
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

// ─── BASKETBALL STATS MAPPING ───────────────────────────────────────────────

// League detection from a raw league string. UNVERIFIED against real
// oddsClient.ts output — the exact league string format returned by the
// paid odds API for basketball was never confirmed in testing. This is a
// best-effort heuristic (checks for 'nba'/'wnba' substrings) and should
// be replaced with an exact match once real oddsClient league strings
// are confirmed, to avoid silently misrouting a match to the wrong
// league's stats source.
export type BasketballLeague = 'nba' | 'wnba';

export function detectBasketballLeague(leagueRaw: string | undefined): BasketballLeague {
  const l = (leagueRaw || '').toLowerCase();
  if (l.includes('wnba')) return 'wnba';
  if (l.includes('nba')) return 'nba';
  // Default to wnba to preserve existing behavior for any caller that
  // doesn't pass a league string at all (matches the pre-NBA-support
  // behavior, where fetchWNBAH2H was the only path).
  return 'wnba';
}

// Dispatches to the correct league's H2H/form fetcher. Both fetchNBAH2H
// and fetchWNBAH2H return the same shape (homeTeam, awayTeam, h2h stats,
// recentMatches, homeForm, awayForm — see wnbaScraper.ts / nbaScraper.ts),
// so basketballStatsToRawStats below works identically regardless of
// which one supplied the data.
export async function fetchBasketballH2HForLeague(
  league: BasketballLeague,
  homeTeam: string,
  awayTeam: string,
) {
  return league === 'nba'
    ? fetchNBAH2H(homeTeam, awayTeam)
    : fetchWNBAH2H(homeTeam, awayTeam);
}

// Rolling PPG-for and PPG-against from a team's recent-form array. This is
// what modelBasketball's totals branch actually needs in
// additionalContext.{home,away}Ppg{For,Against} — without it, every game
// falls back to a hardcoded constant (115/115 for NBA, 80/80 for WNBA)
// regardless of the real matchup.
// CHANGED (see conversation): flat average replaced with exponential
// decay (0.85^i, i = games back from most recent) — same pattern
// football's weightedGoalsAvg already uses. Needed now that
// buildForm/buildTeamForm supply the FULL season instead of a
// pre-truncated last-10 slice; a flat average over a whole season would
// dilute recency, which decay corrects for without a hard cutoff.
function rollingPpg(form: { goalsFor: number; goalsAgainst: number }[], key: 'goalsFor' | 'goalsAgainst'): number | undefined {
  if (!form.length) return undefined;
  // form is sorted most-recent-first (see buildForm/buildTeamForm) — i=0 is the most recent game.
  let weightSum = 0, valueSum = 0;
  form.forEach((f, i) => {
    const w = Math.pow(0.85, i);
    valueSum += f[key] * w;
    weightSum += w;
  });
  return parseFloat((valueSum / weightSum).toFixed(2));
}

// Exported so basketballFixturesSync.ts (the free tipscanner-only path)
// can build the exact same stats shape as this paid-odds path — single
// source of truth, no drift between the two.
export function basketballStatsToRawStats(
  h2h: Awaited<ReturnType<typeof fetchWNBAH2H>> | Awaited<ReturnType<typeof fetchNBAH2H>>,
  externalMatchId: string,
  league: BasketballLeague = 'wnba',
): any {
  const hasH2H   = !!h2h && h2h.recentMatches.length > 0;
  const hasForm  = !!h2h && (h2h.homeForm.length > 0 || h2h.awayForm.length > 0);

  const homeForm = h2h ? h2h.homeForm : [];
  const awayForm = h2h ? h2h.awayForm : [];

  // Real days-since-last-game, computed from each team's most recent form
  // entry (homeForm/awayForm are sorted most-recent-first by buildForm in
  // wnbaScraper.ts/nbaScraper.ts). Previously hardcoded to 1, which
  // unconditionally triggered Validator's "back-to-back fatigue" warning
  // (x0.85 confidenceAdjustment) on every single basketball match
  // regardless of actual rest — a real contributor to basketball
  // confidence scores being artificially deflated.
  function daysSinceLastGame(form: { date: string }[]): number | undefined {
    if (!form.length) return undefined;
    const lastGameDate = new Date(form[0].date);
    if (isNaN(lastGameDate.getTime())) return undefined;
    return Math.max(0, Math.floor((Date.now() - lastGameDate.getTime()) / (1000 * 60 * 60 * 24)));
  }

  const homeFatigueDays = daysSinceLastGame(homeForm);
  const awayFatigueDays = daysSinceLastGame(awayForm);
  // Use whichever side is more rested-relevant to the match being scanned
  // (matches the backtest's convention: min of the two, i.e. the tighter
  // turnaround governs how "fatigued" this matchup context is).
  const fatigueDays = homeFatigueDays !== undefined && awayFatigueDays !== undefined
    ? Math.min(homeFatigueDays, awayFatigueDays)
    : (homeFatigueDays ?? awayFatigueDays);

  return {
    externalMatchId,
    sport: 'basketball',
    confidenceFactors: {
      dataCompleteness: hasH2H && hasForm ? 0.75 : hasH2H ? 0.55 : 0.4,
    },
    h2h: h2h ? h2h.recentMatches.map(m => ({
      date:      m.date,
      homeTeam:  m.homeTeam,
      awayTeam:  m.awayTeam,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
    })) : [],
    homeForm: homeForm.map(f => ({
      date:         f.date,
      opponent:     f.opponent,
      result:       f.result,
      goalsFor:     f.goalsFor,
      goalsAgainst: f.goalsAgainst,
      venue:        f.venue,
    })),
    awayForm: awayForm.map(f => ({
      date:         f.date,
      opponent:     f.opponent,
      result:       f.result,
      goalsFor:     f.goalsFor,
      goalsAgainst: f.goalsAgainst,
      venue:        f.venue,
    })),
    referee:   { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
    situational: { weather: 'clear', temperature: 20, fatigueDays },
    additionalContext: {
      // Real rolling PPG for/against — this is what modelBasketball's
      // totals branch reads (homePpgFor/awayPpgFor/homePpgAgainst/
      // awayPpgAgainst). Previously absent entirely, causing every game
      // to silently fall back to the hardcoded 115/115 (NBA) or 80/80
      // (WNBA) default regardless of the real matchup.
      homePpgFor:     rollingPpg(homeForm, 'goalsFor'),
      homePpgAgainst: rollingPpg(homeForm, 'goalsAgainst'),
      awayPpgFor:     rollingPpg(awayForm, 'goalsFor'),
      awayPpgAgainst: rollingPpg(awayForm, 'goalsAgainst'),

      league,

      // pace intentionally NOT populated here. For WNBA, h2h.pace from
      // fetchWNBAH2H is actually the average COMBINED FINAL SCORE across
      // recent head-to-head games (~150-200+), not a real possessions-
      // based pace figure (~90-105) — despite its field name. Writing it
      // into additionalContext.pace would make modelBasketball divide it
      // by 100 as a multiplier (paceMultiplier = pace/100), massively
      // inflating expectedTotal (e.g. pace=166.7 -> 1.667x multiplier).
      // fetchNBAH2H deliberately never returns a field named "pace" at
      // all, for the same reason. modelBasketball simply falls back to
      // its own neutral default (100 => paceMultiplier 1.0) here.
      h2hAvgCombinedScore: (h2h as any)?.pace ?? null,

      homeWinPct: h2h ? h2h.homeWin / 100 : null,
      awayWinPct: h2h ? h2h.awayWin / 100 : null,
      overPct:    h2h ? h2h.overUnder35 / 100 : null,
    },
  };
}

// ─── FOOTBALL STATS MAPPING ─────────────────────────────────────────────────



function footballStatsToRawStats(
  h2h: Awaited<ReturnType<typeof fetchH2H>>,
  homeRecent: FormRecord[],
  awayRecent: FormRecord[],
  externalMatchId: string,
): any {
  const homeGoalsAvg = homeRecent.length
    ? homeRecent.reduce((s, r) => s + (r.goalsFor ?? 0), 0) / homeRecent.length
    : 1.2;
  const awayGoalsAvg = awayRecent.length
    ? awayRecent.reduce((s, r) => s + (r.goalsFor ?? 0), 0) / awayRecent.length
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

// ─── REAL FETCHER ────────────────────────────────────────────────────────────

export class RealFetcher {
  private repo: Repository;
  private cleaner: Cleaner;
  private validator: Validator;

  constructor() {
    this.repo = new Repository(getDb());
    this.cleaner = new Cleaner();
    this.validator = new Validator();
  }
async fetchSport(sport: Sport, fetchStats: boolean = true): Promise<RealFetchResult> {
  
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
      const footballLeagueCache = new Map<string, NonNullable<Awaited<ReturnType<typeof fetchLeagueData>>>>();
      if (fetchStats && sport === 'football') {
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

         // ── STATS ─────────────────────────────────────────────────────
          if (fetchStats) {
            if (sport === 'tennis' && tennisStatsFetched < MAX_TENNIS_STATS) {
              await this.fetchAndSaveTennisStats(match, matchId, result);
              tennisStatsFetched++;
              await new Promise(r => setTimeout(r, 5000));
            } else if (sport === 'football') {
              await this.fetchAndSaveFootballStats(match, matchId, footballLeagueCache, result);
            } else if (sport === 'basketball') {
              await this.fetchAndSaveBasketballStats(match, matchId, result);
            } else {
              logger.debug(`[RealFetcher] Stats not yet supported for ${sport}`, {
                home: match.homeTeam,
                away: match.awayTeam,
              });
            }
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

  // ── FOOTBALL STATS: FCStats primary, soccerstats.com fallback ─────────
  //
  // FCStats is currently down entirely (Cloudflare bot challenge / DNS
  // failures confirmed 26 Jul 2026 — see error log). When leagueCache
  // has no data for a league (FCStats fetch failed), this falls back
  // to teamResultsScraper.ts (soccerstats.com) for any league with a
  // confirmed code in SOCCERSTATS_LEAGUE_MAP.
  private async fetchAndSaveFootballStats(
    match: { homeTeam: string; awayTeam: string; league: string; externalId?: string },
    matchId: string,
    leagueCache: Map<string, NonNullable<Awaited<ReturnType<typeof fetchLeagueData>>>>,
    result: RealFetchResult,
  ): Promise<void> {
    try {
      const leagueData = leagueCache.get(match.league);

      if (leagueData) {
        // ── PRIMARY PATH: FCStats ────────────────────────────────
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

        // Try football-data.co.uk CSV first, fall back to FCStats
        let h2h = await fetchFDCOH2H(match.homeTeam, match.awayTeam, match.league);
        if (!h2h) {
          h2h = await fetchH2H(match.homeTeam, match.awayTeam, leagueData);
        }

        const rawStats = footballStatsToRawStats(
          h2h,
          homeTeamStats.recentResults,
          awayTeamStats.recentResults,
          match.externalId!,
        );

        await this.saveFootballStats(rawStats, matchId, match, result, 'fcstats');
      } else {
        // ── FALLBACK PATH: soccerstats.com ───────────────────────
        const soccerStatsCode = SOCCERSTATS_LEAGUE_MAP[match.league];
        if (!soccerStatsCode) {
          console.log(`[DEBUG STATS] no FCStats data AND no soccerstats.com mapping for "${match.league}" — skipping ${match.homeTeam} vs ${match.awayTeam}`);
          return;
        }

        const [homeResults, awayResults] = await Promise.all([
          fetchTeamResultsByName(soccerStatsCode, match.homeTeam),
          fetchTeamResultsByName(soccerStatsCode, match.awayTeam),
        ]);

        console.log(`[DEBUG STATS] [fallback:soccerstats] ${match.homeTeam} vs ${match.awayTeam} | homeResults=${homeResults.length} awayResults=${awayResults.length}`);

        if (!homeResults.length || !awayResults.length) {
          logger.debug('[RealFetcher] soccerstats.com fallback found no results for one or both teams', {
            match: `${match.homeTeam} vs ${match.awayTeam}`,
            league: match.league,
            homeResults: homeResults.length,
            awayResults: awayResults.length,
          });
          return;
        }

        // H2H still attempted via FDCO first (separate source, may still work)
        let h2h = await fetchFDCOH2H(match.homeTeam, match.awayTeam, match.league);

        const rawStats = footballStatsToRawStats(
          h2h,
          homeResults,
          awayResults,
          match.externalId!,
        );

        await this.saveFootballStats(rawStats, matchId, match, result, 'soccerstats-fallback');

        // Be polite to soccerstats.com — avoid rapid-fire requests across
        // many matches in one scan, same pattern used for tennis above.
        await new Promise(r => setTimeout(r, 1500));
      }

    } catch (scrapeErr: any) {
      logger.warn('[RealFetcher] Football scrape failed — continuing without stats', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        error: scrapeErr.message,
      });
    }
  }

  // Shared save logic — validation, confidence adjustment, upsert, corners
  // aggregation — used by both the FCStats primary path and the
  // soccerstats.com fallback path, so behavior stays identical regardless
  // of which source the form data came from.
  private async saveFootballStats(
    rawStats: any,
    matchId: string,
    match: { homeTeam: string; awayTeam: string; league: string },
    result: RealFetchResult,
    source: 'fcstats' | 'soccerstats-fallback',
  ): Promise<void> {
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
      source,
    });

    // Corners aggregation — only meaningful for soccerstats.com-covered
    // leagues either way, so this runs regardless of which source
    // supplied the form data above. Errors caught and logged, not
    // thrown — a corners failure should never take down the goals
    // stats pipeline that already succeeded above.
    try {
      await aggregateCornersForMatch(
        this.repo,
        matchId,
        match.league,
        match.homeTeam,
        match.awayTeam,
      );
    } catch (cornersErr: any) {
      logger.warn('[RealFetcher] Corners aggregation failed — continuing without corners data', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        error: cornersErr.message,
      });
    }
  }

  private async fetchAndSaveBasketballStats(
    match: { homeTeam: string; awayTeam: string; league?: string; externalId?: string },
    matchId: string,
    result: RealFetchResult,
  ): Promise<void> {
    try {
      const league = detectBasketballLeague(match.league);
      console.log(`[DEBUG BASKETBALL] ${match.homeTeam} vs ${match.awayTeam} | rawLeague="${match.league}" detectedLeague=${league}`);

      const h2h = await fetchBasketballH2HForLeague(league, match.homeTeam, match.awayTeam);

      if (!h2h) {
        console.log(`[DEBUG BASKETBALL] no H2H data found for ${match.homeTeam} vs ${match.awayTeam} (league=${league})`);
        return;
      }

      console.log(`[DEBUG BASKETBALL] ${match.homeTeam} vs ${match.awayTeam} | h2hRecords=${h2h.recentMatches.length} homeForm=${h2h.homeForm.length} awayForm=${h2h.awayForm.length}`);

      const rawStats = basketballStatsToRawStats(h2h, match.externalId!, league);
      const cleanedStats = this.cleaner.cleanStats(rawStats, matchId, 'basketball');
      if (!cleanedStats) {
        console.log(`[DEBUG BASKETBALL] cleanStats returned null for ${match.homeTeam} vs ${match.awayTeam}`);
        return;
      }

      const statsValidation = this.validator.validateStats(cleanedStats);
      if (!statsValidation.valid) {
        console.log(`[DEBUG BASKETBALL] validation failed for ${match.homeTeam} vs ${match.awayTeam}:`, statsValidation.errors);
        logger.warn('[RealFetcher] Basketball stats failed validation', {
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
      console.log(`[DEBUG BASKETBALL] stats saved for ${match.homeTeam} vs ${match.awayTeam} (league=${league})`);
      logger.info('[RealFetcher] Basketball stats saved', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        league,
        h2hRecords: h2h.recentMatches.length,
      });

    } catch (err: any) {
      console.log(`[DEBUG BASKETBALL] EXCEPTION for ${match.homeTeam} vs ${match.awayTeam}: ${err.message}`);
      logger.warn('[RealFetcher] Basketball stats fetch failed — continuing without stats', {
        match: `${match.homeTeam} vs ${match.awayTeam}`,
        error: err.message,
      });
    }
  }

  async fetchAll(fetchStats: boolean = true): Promise<RealFetchResult[]> {
    const results: RealFetchResult[] = [];
    for (const sport of SUPPORTED_SPORTS) {
      const result = await this.fetchSport(sport, fetchStats);
      results.push(result);
      await new Promise(r => setTimeout(r, 500));
    }
    return results;
  }
}

export const realFetcher = new RealFetcher();