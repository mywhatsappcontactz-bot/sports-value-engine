// src/data-bridge/fetcher.ts
import { Repository } from '../core/database/repository';
import { getDb } from '../core/database/db';
import { logger, logWithCorrelation } from '../core/utils/logger';
import { MockClient } from './mockClient';
import { Cleaner } from './cleaner';
import { Validator } from './validator';
import { failsafe } from './failsafe';
import { THRESHOLDS } from './validator';
import { v4 as uuidv4 } from 'uuid';

// ─── FETCH RESULT ────────────────────────────────────────

export interface FetchResult {
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

// ─── SUPPORTED SPORTS ────────────────────────────────────

export const SUPPORTED_SPORTS = [
  'football',
  'tennis',
  'basketball',
  'hockey',
] as const;

export type Sport = typeof SUPPORTED_SPORTS[number];

// ─── FETCHER CLASS ───────────────────────────────────────

export class Fetcher {
  private repo: Repository;
  private client: MockClient;
  private cleaner: Cleaner;
  private validator: Validator;

  constructor() {
    this.repo = new Repository(getDb());
    this.client = new MockClient();
    this.cleaner = new Cleaner();
    this.validator = new Validator();
  }

  // ─── FETCH SINGLE SPORT ──────────────────────────────

  async fetchSport(sport: Sport): Promise<FetchResult> {
    const correlationId = uuidv4();
    const startTime = Date.now();

    const result: FetchResult = {
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

    logWithCorrelation(correlationId, 'info', `[Fetcher] Starting fetch`, { sport });

    try {
      // ── STEP 1: FETCH MATCHES ───────────────────────
      const rawMatchResponse = await failsafe.execute(
        `${sport}-matches`,
        () => this.client.fetchMatches(sport),
        correlationId
      );

      if (!rawMatchResponse?.data?.length) {
        logWithCorrelation(correlationId, 'warn',
          `[Fetcher] No matches returned`, { sport }
        );
        result.durationMs = Date.now() - startTime;
        return result;
      }

      result.matchesFetched = rawMatchResponse.data.length;

      // ── STEP 2: CLEAN + VALIDATE MATCHES ───────────
      const cleanedMatches = this.cleaner.cleanMatches(rawMatchResponse.data);
      const validMatches = this.validator.validateMatches(cleanedMatches);

      if (!validMatches.length) {
        logWithCorrelation(correlationId, 'warn',
          `[Fetcher] No valid matches after cleaning`, { sport }
        );
        result.skipped += result.matchesFetched;
        result.durationMs = Date.now() - startTime;
        return result;
      }

      // ── STEP 3: SAVE MATCHES + FETCH ODDS & STATS ──
      for (const match of validMatches) {
        try {
          // Save match to DB
          const matchId = this.repo.upsertMatch(match);
          result.matchesSaved++;

          logWithCorrelation(correlationId, 'info',
            `[Fetcher] Match saved`, {
              matchId,
              homeTeam: match.homeTeam,
              awayTeam: match.awayTeam,
            }
          );

          // ── STEP 4: FETCH + SAVE ODDS ─────────────
          const oddsResult = await this.fetchAndSaveOdds(
            match.externalId!,
            matchId,
            correlationId
          );
          result.oddsSaved += oddsResult;

          // ── STEP 5: FETCH + SAVE STATS ────────────
          const statsResult = await this.fetchAndSaveStats(
            match.externalId!,
            matchId,
            match.sport,
            correlationId
          );
          if (statsResult) result.statsSaved++;

        } catch (error: any) {
          result.errors++;
          logWithCorrelation(correlationId, 'error',
            `[Fetcher] Failed processing match`, {
              externalId: match.externalId,
              error: error.message,
            }
          );
          // Continue to next match — never stop entire fetch
        }
      }

    } catch (error: any) {
      result.errors++;
      logWithCorrelation(correlationId, 'error',
        `[Fetcher] Fatal fetch error`, { sport, error: error.message }
      );
    }

    result.durationMs = Date.now() - startTime;

    logWithCorrelation(correlationId, 'info', `[Fetcher] Fetch complete`, {
      sport,
      matchesFetched: result.matchesFetched,
      matchesSaved: result.matchesSaved,
      oddsSaved: result.oddsSaved,
      statsSaved: result.statsSaved,
      skipped: result.skipped,
      errors: result.errors,
      durationMs: result.durationMs,
    });

    return result;
  }

  // ─── FETCH ALL SPORTS ────────────────────────────────

  async fetchAll(): Promise<FetchResult[]> {
    const correlationId = uuidv4();
    logWithCorrelation(correlationId, 'info',
      `[Fetcher] Starting full fetch — all sports`
    );

    const results: FetchResult[] = [];

    for (const sport of SUPPORTED_SPORTS) {
      // Check circuit breaker before each sport
      const circuit = failsafe.getCircuit(`${sport}-matches`);
      if (circuit.isOpen()) {
        logWithCorrelation(correlationId, 'warn',
          `[Fetcher] Skipping ${sport} — circuit open`
        );
        continue;
      }

      const result = await this.fetchSport(sport);
      results.push(result);

      // Brief pause between sports — avoid rate limiting
      await this.sleep(500);
    }

    // Summary log
    const totalMatches = results.reduce((s, r) => s + r.matchesSaved, 0);
    const totalOdds = results.reduce((s, r) => s + r.oddsSaved, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors, 0);

    logWithCorrelation(correlationId, 'info', `[Fetcher] All sports complete`, {
      totalMatches,
      totalOdds,
      totalErrors,
      circuitStatus: failsafe.getAllStatus(),
    });

    return results;
  }

  // ─── PRIVATE: FETCH + SAVE ODDS ──────────────────────

  private async fetchAndSaveOdds(
    externalMatchId: string,
    matchId: string,
    correlationId: string
  ): Promise<number> {
    const rawOddsResponse = await failsafe.execute(
      'odds-api',
      () => this.client.fetchOdds(externalMatchId),
      correlationId
    );

    if (!rawOddsResponse?.data?.length) {
      logWithCorrelation(correlationId, 'warn',
        `[Fetcher] No odds returned`, { externalMatchId }
      );
      return 0;
    }

    // Clean + validate odds
    const cleanedOdds = this.cleaner.cleanOddsBatch(
      rawOddsResponse.data,
      matchId
    );
    const validOdds = this.validator.validateOddsBatch(cleanedOdds);

    if (!validOdds.length) {
      logWithCorrelation(correlationId, 'warn',
        `[Fetcher] No valid odds after cleaning`, { externalMatchId }
      );
      return 0;
    }

    // Save to DB
    this.repo.saveOddsBatch(validOdds);

    logWithCorrelation(correlationId, 'info',
      `[Fetcher] Odds saved`, { matchId, count: validOdds.length }
    );

    return validOdds.length;
  }

  // ─── PRIVATE: FETCH + SAVE STATS ─────────────────────

  private async fetchAndSaveStats(
    externalMatchId: string,
    matchId: string,
    sport: string,
    correlationId: string
  ): Promise<boolean> {
    const rawStatsResponse = await failsafe.execute(
      'stats-api',
      () => this.client.fetchStats(externalMatchId),
      correlationId
    );

    if (!rawStatsResponse?.data) {
      logWithCorrelation(correlationId, 'warn',
        `[Fetcher] No stats returned`, { externalMatchId }
      );
      return false;
    }

    // Clean stats
    const cleanedStats = this.cleaner.cleanStats(
      rawStatsResponse.data,
      matchId,
      sport
    );

    if (!cleanedStats) {
      logWithCorrelation(correlationId, 'warn',
        `[Fetcher] Stats failed cleaning`, { externalMatchId }
      );
      return false;
    }

    // Validate stats
    const statsValidation = this.validator.validateStats(cleanedStats);

    if (!statsValidation.valid) {
      logWithCorrelation(correlationId, 'warn',
        `[Fetcher] Stats failed validation`, {
          externalMatchId,
          errors: statsValidation.errors,
        }
      );
      return false;
    }

    // Log warnings but continue
    if (statsValidation.warnings.length > 0) {
      logWithCorrelation(correlationId, 'info',
        `[Fetcher] Stats warnings`, {
          warnings: statsValidation.warnings,
          confidenceAdjustment: statsValidation.confidenceAdjustment,
        }
      );

      // Apply confidence adjustment to stats before saving
      cleanedStats.confidenceFactors.dataCompleteness = parseFloat(
        (cleanedStats.confidenceFactors.dataCompleteness *
          statsValidation.confidenceAdjustment).toFixed(4)
      );
    }

    // Save to DB
    this.repo.upsertStats(cleanedStats);

    logWithCorrelation(correlationId, 'info',
      `[Fetcher] Stats saved`, {
        matchId,
        dataCompleteness: cleanedStats.confidenceFactors.dataCompleteness,
      }
    );

    return true;
  }

  // ─── HELPER ──────────────────────────────────────────

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}