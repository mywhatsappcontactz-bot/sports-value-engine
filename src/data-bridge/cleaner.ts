// src/data-bridge/cleaner.ts
import { RawMatch, RawOdds, RawStats } from './mockClient';
import { Match, Odds, Stats, H2HRecord, FormRecord } from '../core/database/schema';
import { logger } from '../core/utils/logger';

// ─── CLEANED OUTPUT TYPES ────────────────────────────────

export interface CleanedMatch extends Omit<Match, 'id' | 'createdAt' | 'updatedAt'> {}

export interface CleanedOdds extends Omit<Odds, 'id'> {}

export interface CleanedStats extends Omit<Stats, 'id' | 'lastUpdated'> {}

// ─── CLEANER CLASS ───────────────────────────────────────

export class Cleaner {

  // ─── MATCHES ─────────────────────────────────────────

  cleanMatch(raw: RawMatch): CleanedMatch | null {
    try {
      // Validate required fields
      if (!raw.externalId || !raw.sport || !raw.homeTeam || !raw.awayTeam) {
        logger.warn('[Cleaner] Match missing required fields', { raw });
        return null;
      }

      // Normalize sport name
      const sport = this.normalizeSport(raw.sport);
      if (!sport) {
        logger.warn('[Cleaner] Unknown sport', { sport: raw.sport });
        return null;
      }

      // Validate startTime is a real date
      const startTime = new Date(raw.startTime);
      if (isNaN(startTime.getTime())) {
        logger.warn('[Cleaner] Invalid startTime', { startTime: raw.startTime });
        return null;
      }

      // Reject matches in the past
      if (startTime.getTime() < Date.now()) {
        logger.warn('[Cleaner] Match already started or completed', { externalId: raw.externalId });
        return null;
      }

      return {
        sport,
        league: this.normalizeString(raw.league),
        homeTeam: this.normalizeString(raw.homeTeam),
        awayTeam: this.normalizeString(raw.awayTeam),
        startTime: startTime.toISOString(),
        status: 'upcoming',
        externalId: raw.externalId.trim(),
        source: raw.source || 'unknown',
      };
    } catch (error) {
      logger.error('[Cleaner] Failed to clean match', { error, raw });
      return null;
    }
  }

  cleanMatches(rawList: RawMatch[]): CleanedMatch[] {
    const cleaned = rawList
      .map(r => this.cleanMatch(r))
      .filter((m): m is CleanedMatch => m !== null);

    logger.info(`[Cleaner] Matches: ${rawList.length} raw → ${cleaned.length} clean`);
    return cleaned;
  }

  // ─── ODDS ────────────────────────────────────────────

  cleanOdds(raw: RawOdds, matchId: string): CleanedOdds | null {
    try {
      // Validate odds value
      if (!raw.odds || raw.odds <= 1.0) {
        logger.warn('[Cleaner] Invalid odds value', { odds: raw.odds });
        return null;
      }

      // Validate market
      const market = this.normalizeMarket(raw.market);
      if (!market) {
        logger.warn('[Cleaner] Unknown market', { market: raw.market });
        return null;
      }

      // Validate bookmaker
      if (!raw.bookmaker?.trim()) {
        logger.warn('[Cleaner] Missing bookmaker');
        return null;
      }

      // Calculate implied probability from odds
      const impliedProbability = parseFloat((1 / raw.odds).toFixed(6));

      // Sanity check — implied prob must be between 0 and 1
      if (impliedProbability <= 0 || impliedProbability >= 1) {
        logger.warn('[Cleaner] Implied probability out of range', { impliedProbability });
        return null;
      }

      return {
        matchId,
        bookmaker: this.normalizeString(raw.bookmaker),
        market,
        selection: this.normalizeString(raw.selection),
        odds: parseFloat(raw.odds.toFixed(4)),
        impliedProbability,
        timestamp: raw.timestamp || new Date().toISOString(),
        source: 'api',
      };
    } catch (error) {
      logger.error('[Cleaner] Failed to clean odds', { error, raw });
      return null;
    }
  }

  cleanOddsBatch(rawList: RawOdds[], matchId: string): CleanedOdds[] {
    const cleaned = rawList
      .map(r => this.cleanOdds(r, matchId))
      .filter((o): o is CleanedOdds => o !== null);

    logger.info(`[Cleaner] Odds: ${rawList.length} raw → ${cleaned.length} clean`);
    return cleaned;
  }

  // ─── STATS ───────────────────────────────────────────

  cleanStats(raw: RawStats, matchId: string, sport: string): CleanedStats | null {
    try {
      if (!raw.externalMatchId) {
        logger.warn('[Cleaner] Stats missing externalMatchId');
        return null;
      }

      // Clean H2H records
      const h2h: H2HRecord[] = (raw.h2h || [])
        .filter(r => r.date && r.homeTeam && r.awayTeam)
        .map(r => ({
          date: r.date,
          homeTeam: this.normalizeString(r.homeTeam),
          awayTeam: this.normalizeString(r.awayTeam),
          homeScore: Math.max(0, Math.floor(r.homeScore)),
          awayScore: Math.max(0, Math.floor(r.awayScore)),
          winner: r.homeScore > r.awayScore
            ? 'home'
            : r.awayScore > r.homeScore
              ? 'away'
              : 'draw',
        }));

      // Clean form records
      const homeForm: FormRecord[] = this.cleanFormRecords(raw.homeForm || []);
      const awayForm: FormRecord[] = this.cleanFormRecords(raw.awayForm || []);

      // Pull out sport-specific properties out of additionalContext or situational blocks safely
      const surfaceType = raw.situational?.surfaceType || (raw.additionalContext?.surfaceType as string) || undefined;
      const pitchSize = raw.situational?.pitchSize || (raw.additionalContext?.pitchSize as string) || undefined;
      const pace = (raw.additionalContext?.pace as number) || undefined;

      return {
        matchId,
        sport,
        h2h,
        homeForm,
        awayForm,
        referee: {
          name: raw.referee?.name || undefined,
          avgYellowCards: this.safeNumber(raw.referee?.avgYellowCards),
          avgRedCards: this.safeNumber(raw.referee?.avgRedCards),
          avgFouls: this.safeNumber(raw.referee?.avgFouls),
        },
        situational: {
          weather: raw.situational?.weather || undefined,
          temperature: this.safeNumber(raw.situational?.temperature),
          fatigueDays: this.safeNumber(raw.situational?.fatigueDays),
          travelDistance: undefined,
          isNeutralVenue: false,
        },
        additionalContext: {
          ...(pitchSize && { pitchSize }),
          ...(surfaceType && { surfaceType }),
          ...(pace && { pace }),
          ...raw.additionalContext,
        },
        confidenceFactors: {
          dataCompleteness: this.calculateDataCompleteness(raw),
          h2hSampleSize: h2h.length,
          formSampleSize: Math.min(homeForm.length, awayForm.length),
        },
      };
    } catch (error) {
      logger.error('[Cleaner] Failed to clean stats', { error, matchId });
      return null;
    }
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────

  private cleanFormRecords(raw: RawStats['homeForm']): FormRecord[] {
    return (raw || [])
      .filter(r => r.date && r.opponent && r.result)
      .map(r => ({
        date: r.date,
        opponent: this.normalizeString(r.opponent),
        result: r.result as 'W' | 'L' | 'D',
        goalsFor: Math.max(0, Math.floor(r.goalsFor || 0)),
        goalsAgainst: Math.max(0, Math.floor(r.goalsAgainst || 0)),
        venue: r.venue as 'home' | 'away',
      }));
  }

  private calculateDataCompleteness(raw: RawStats): number {
    let score = 0;
    
    // Mitigated 'Possibly Undefined' compiler warnings via strict nullish checks
    const checks = [
      (raw.homeGoalsAvg ?? 0) > 0,
      (raw.awayGoalsAvg ?? 0) > 0,
      (raw.h2h?.length ?? 0) >= 3,
      (raw.homeForm?.length ?? 0) >= 3,
      (raw.awayForm?.length ?? 0) >= 3,
      !!raw.referee?.name,
      !!raw.situational?.weather,
      !!(raw.situational?.surfaceType || raw.additionalContext?.surfaceType),
    ];
    
    checks.forEach(c => { if (c) score++ });
    return parseFloat((score / checks.length).toFixed(2));
  }

  private normalizeSport(sport: string): string | null {
    const map: Record<string, string> = {
      football: 'football', soccer: 'football',
      tennis: 'tennis',
      basketball: 'basketball', nba: 'basketball',
      hockey: 'hockey', 'ice hockey': 'hockey', nhl: 'hockey',
    };
    return map[sport.toLowerCase().trim()] || null;
  }

  private normalizeMarket(market: string): string | null {
    const valid = [
      'under_3.5', 'under_5.5', 'btts', 'double_chance',
      '1x2', 'asian_handicap',
      'match_winner', 'total_games',
      'totals', 'spread', 'moneyline','team_totals',
    ];
    const normalized = market.toLowerCase().trim();
    return valid.includes(normalized) ? normalized : null;
  }

  private normalizeString(val: string): string {
    return val?.trim().replace(/\s+/g, ' ') || '';
  }

  private safeNumber(val: unknown): number | undefined {
    if (val === undefined || val === null) return undefined;
    const n = Number(val);
    return isNaN(n) ? undefined : n;
  }
}