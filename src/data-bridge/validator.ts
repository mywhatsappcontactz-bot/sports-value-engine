// src/data-bridge/validator.ts
import { CleanedMatch, CleanedOdds, CleanedStats } from './cleaner';
import { logger } from '../core/utils/logger';

// ─── VALIDATION RESULT ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  confidenceAdjustment: number;
}

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────

export const THRESHOLDS = {
  // ── ODDS ──
  MIN_ODDS: 1.30,
  MAX_ODDS: 15.0,
  MIN_IMPLIED_PROB: 0.07,
  MAX_IMPLIED_PROB: 0.77,

  // ── EDGE & CONFIDENCE ──
  MIN_EDGE: 0.015,
  GOOD_EDGE: 0.03,
  MIN_CONFIDENCE: 0.55,
  GOOD_CONFIDENCE: 0.70,
  IDEAL_CONFIDENCE: 0.80,

  // ── H2H ──
  MIN_H2H_RECORDS: 3,
  IDEAL_H2H_RECORDS: 6,
  MAX_H2H_AGE_DAYS: 1095,

  // ── FORM ──
  MIN_FORM_RECORDS: 5,
  IDEAL_FORM_RECORDS: 8,
  MAX_FORM_AGE_DAYS: 90,

  // ── MATCH TIMING ──
  MIN_HOURS_UNTIL_MATCH: 1,
  IDEAL_HOURS_UNTIL_MATCH: 24,
  MAX_HOURS_UNTIL_MATCH: 120,

  // ── DATA COMPLETENESS ──
  MIN_DATA_COMPLETENESS: 0.30,
  GOOD_DATA_COMPLETENESS: 0.70,

  // ── SPORT SPECIFIC ──
  FOOTBALL_MAX_GOALS_AVG: 2.0,
  HOCKEY_MAX_GOALS_AVG: 3.5,
  BASKETBALL_MIN_PACE: 85,
} as const;

export type ThresholdKeys = keyof typeof THRESHOLDS;

// ─── VALIDATOR CLASS ──────────────────────────────────────────────────────────

export class Validator {

  // ─── MATCH VALIDATION ─────────────────────────────────────────────────────

  validateMatch(match: CleanedMatch): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let confidenceAdjustment = 1.0;

    if (!match.sport) errors.push('Missing sport');
    if (!match.league) errors.push('Missing league');
    if (!match.homeTeam) errors.push('Missing homeTeam');
    if (!match.awayTeam) errors.push('Missing awayTeam');
    if (!match.startTime) errors.push('Missing startTime');
    if (!match.externalId) errors.push('Missing externalId');

    if (match.homeTeam && match.awayTeam &&
      match.homeTeam.toLowerCase() === match.awayTeam.toLowerCase()) {
      errors.push('homeTeam and awayTeam cannot be the same');
    }

    if (match.startTime) {
      const hoursUntilMatch = (new Date(match.startTime).getTime() - Date.now()) / 3600000;

      if (hoursUntilMatch < THRESHOLDS.MIN_HOURS_UNTIL_MATCH) {
        errors.push(`Match starts too soon: ${hoursUntilMatch.toFixed(1)}h (min ${THRESHOLDS.MIN_HOURS_UNTIL_MATCH}h)`);
      }
      if (hoursUntilMatch > THRESHOLDS.MAX_HOURS_UNTIL_MATCH) {
        errors.push(`Match too far away: ${hoursUntilMatch.toFixed(1)}h (max ${THRESHOLDS.MAX_HOURS_UNTIL_MATCH}h)`);
      }
      if (hoursUntilMatch > THRESHOLDS.IDEAL_HOURS_UNTIL_MATCH * 3) {
        warnings.push(`Outside ideal betting window — odds may shift`);
        confidenceAdjustment *= 0.90;
      }
    }

    const validSports = ['football', 'tennis', 'basketball', 'hockey'];
    if (match.sport && !validSports.includes(match.sport)) {
      errors.push(`Invalid sport: ${match.sport}`);
    }

    this.log('Match', match.externalId || 'unknown', errors, warnings);
    return { valid: errors.length === 0, errors, warnings, confidenceAdjustment };
  }

  validateMatches(matches: CleanedMatch[]): CleanedMatch[] {
    const valid = matches.filter(m => this.validateMatch(m).valid);
    logger.info(`[Validator] Matches: ${matches.length} → ${valid.length} valid`);
    return valid;
  }

  // ─── ODDS VALIDATION ──────────────────────────────────────────────────────

  validateOdds(odds: CleanedOdds): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let confidenceAdjustment = 1.0;

    if (!odds.matchId) errors.push('Missing matchId');
    if (!odds.bookmaker) errors.push('Missing bookmaker');
    if (!odds.market) errors.push('Missing market');
    if (!odds.selection) errors.push('Missing selection');

    if (!odds.odds || odds.odds < THRESHOLDS.MIN_ODDS) {
      errors.push(`Odds too low: ${odds.odds} (min ${THRESHOLDS.MIN_ODDS}) — favorite too strong`);
    }
    if (odds.odds > THRESHOLDS.MAX_ODDS) {
      errors.push(`Odds too high: ${odds.odds} (max ${THRESHOLDS.MAX_ODDS}) — too uncertain`);
    }

    if (odds.impliedProbability <= THRESHOLDS.MIN_IMPLIED_PROB) {
      errors.push(`Implied probability too low: ${odds.impliedProbability}`);
    }
    if (odds.impliedProbability >= THRESHOLDS.MAX_IMPLIED_PROB) {
      errors.push(`Implied probability too high: ${odds.impliedProbability}`);
    }

    const expectedImplied = parseFloat((1 / odds.odds).toFixed(6));
    const diff = Math.abs(expectedImplied - odds.impliedProbability);
    if (diff > 0.001) {
      errors.push(`Implied probability mismatch: expected ${expectedImplied}, got ${odds.impliedProbability}`);
    }

    if (odds.odds > 8.0) {
      warnings.push(`High odds ${odds.odds} — low probability event, reduce stake`);
      confidenceAdjustment *= 0.80;
    }

    this.log('Odds', `${odds.bookmaker}:${odds.market}`, errors, warnings);
    return { valid: errors.length === 0, errors, warnings, confidenceAdjustment };
  }

  validateOddsBatch(oddsList: CleanedOdds[]): CleanedOdds[] {
    const valid = oddsList.filter(o => this.validateOdds(o).valid);
    logger.info(`[Validator] Odds: ${oddsList.length} → ${valid.length} valid`);
    return valid;
  }

  // ─── STATS VALIDATION ─────────────────────────────────────────────────────

  validateStats(stats: CleanedStats): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let confidenceAdjustment = 1.0;

    if (!stats.matchId) errors.push('Missing matchId');

    const isTennis = stats.sport === 'tennis';

    // ── DATA COMPLETENESS ──
    const completeness = stats.confidenceFactors?.dataCompleteness || 0;
    const minCompleteness = isTennis ? 0.15 : THRESHOLDS.MIN_DATA_COMPLETENESS;
    if (completeness < minCompleteness) {
      errors.push(`Data completeness too low: ${(completeness * 100).toFixed(0)}% (min ${minCompleteness * 100}%)`);
    } else if (completeness < THRESHOLDS.GOOD_DATA_COMPLETENESS) {
      warnings.push(`Moderate data completeness: ${(completeness * 100).toFixed(0)}%`);
      confidenceAdjustment *= 0.85;
    }

    // ── H2H VALIDATION ──
    const h2hCount = stats.h2h?.length || 0;
    const minH2H = isTennis ? 0 : THRESHOLDS.MIN_H2H_RECORDS;
    if (h2hCount < minH2H) {
      errors.push(`H2H sample too small: ${h2hCount} records (min ${minH2H})`);
    } else if (h2hCount < THRESHOLDS.IDEAL_H2H_RECORDS) {
      warnings.push(`Below ideal H2H sample: ${h2hCount} (ideal ${THRESHOLDS.IDEAL_H2H_RECORDS})`);
      confidenceAdjustment *= 0.90;
    }

    if (stats.h2h?.length > 0) {
      const sortedH2H = [...stats.h2h].sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
      const oldestH2H = new Date(sortedH2H[sortedH2H.length - 1].date);
      const h2hAgeDays = (Date.now() - oldestH2H.getTime()) / 86400000;
      if (h2hAgeDays > THRESHOLDS.MAX_H2H_AGE_DAYS) {
        warnings.push(`H2H data old: ${Math.floor(h2hAgeDays)} days (max ${THRESHOLDS.MAX_H2H_AGE_DAYS})`);
        confidenceAdjustment *= 0.85;
      }
    }

    // ── FORM VALIDATION ──
    const homeFormCount = stats.homeForm?.length || 0;
    const awayFormCount = stats.awayForm?.length || 0;
    const minForm = isTennis ? 0 : THRESHOLDS.MIN_FORM_RECORDS;

    if (homeFormCount < minForm) {
      errors.push(`Home form too small: ${homeFormCount} games (min ${minForm})`);
    } else if (homeFormCount < THRESHOLDS.IDEAL_FORM_RECORDS) {
      warnings.push(`Below ideal home form: ${homeFormCount} games (ideal ${THRESHOLDS.IDEAL_FORM_RECORDS})`);
      confidenceAdjustment *= 0.90;
    }

    if (awayFormCount < minForm) {
      errors.push(`Away form too small: ${awayFormCount} games (min ${minForm})`);
    } else if (awayFormCount < THRESHOLDS.IDEAL_FORM_RECORDS) {
      warnings.push(`Below ideal away form: ${awayFormCount} games (ideal ${THRESHOLDS.IDEAL_FORM_RECORDS})`);
      confidenceAdjustment *= 0.90;
    }

    if (!isTennis && stats.homeForm?.length > 0) {
      const latestHomeForm = new Date(stats.homeForm[0].date);
      const homeFormAgeDays = (Date.now() - latestHomeForm.getTime()) / 86400000;
      if (homeFormAgeDays > THRESHOLDS.MAX_FORM_AGE_DAYS) {
        errors.push(`Home form data too old: ${Math.floor(homeFormAgeDays)} days (max ${THRESHOLDS.MAX_FORM_AGE_DAYS})`);
      }
    }

    if (!isTennis && stats.awayForm?.length > 0) {
      const latestAwayForm = new Date(stats.awayForm[0].date);
      const awayFormAgeDays = (Date.now() - latestAwayForm.getTime()) / 86400000;
      if (awayFormAgeDays > THRESHOLDS.MAX_FORM_AGE_DAYS) {
        errors.push(`Away form data too old: ${Math.floor(awayFormAgeDays)} days (max ${THRESHOLDS.MAX_FORM_AGE_DAYS})`);
      }
    }

    // ── SPORT-SPECIFIC RULES ──
    const sport = stats.sport;

    if (sport === 'football') {
      const hasGoalsData = stats.homeForm?.some(f => f.goalsFor !== undefined);
      if (!hasGoalsData) {
        errors.push('Football: no goals data in form — cannot price totals or BTTS');
      }

      const homeVenueGames = stats.homeForm?.filter(f => f.venue === 'home').length || 0;
      const awayVenueGames = stats.awayForm?.filter(f => f.venue === 'away').length || 0;
      if (homeVenueGames < 2) {
        errors.push(`Football: insufficient home venue games: ${homeVenueGames} (min 2)`);
      }
      if (awayVenueGames < 2) {
        errors.push(`Football: insufficient away venue games: ${awayVenueGames} (min 2)`);
      }

      if (!stats.referee?.name) {
        warnings.push('Football: no referee data — asian handicap and cards markets weakened');
        confidenceAdjustment *= 0.92;
      } else {
        if (stats.referee.avgFouls !== undefined && stats.referee.avgFouls > 32) {
          warnings.push(`Football: high-foul referee (${stats.referee.avgFouls} avg)`);
          confidenceAdjustment *= 0.88;
        }
        if ((stats.referee as any).penaltyRate !== undefined && (stats.referee as any).penaltyRate > 0.4) {
          warnings.push(`Football: high penalty rate referee`);
          confidenceAdjustment *= 0.90;
        }
      }

      if (!stats.situational?.weather) {
        warnings.push('Football: no weather data');
        confidenceAdjustment *= 0.95;
      } else {
        const weather = stats.situational.weather.toLowerCase();
        if (weather.includes('heavy rain') || weather.includes('storm')) {
          warnings.push('Football: severe weather — scoring suppressed');
          confidenceAdjustment *= 0.90;
        }
        if (weather.includes('wind') && stats.situational.temperature !== undefined && stats.situational.temperature < 5) {
          warnings.push('Football: cold + wind — physical game expected');
          confidenceAdjustment *= 0.92;
        }
      }

      const surface = stats.additionalContext?.surfaceType as string | undefined;
      if (!surface) {
        warnings.push('Football: no surface type');
        confidenceAdjustment *= 0.96;
      } else if (surface === 'artificial') {
        warnings.push('Football: artificial pitch — typically more goals');
        confidenceAdjustment *= 0.93;
      }

      const fatigue = stats.situational?.fatigueDays;
      if (fatigue !== undefined && fatigue < 4) {
        warnings.push(`Football: severe fatigue (${fatigue} days rest)`);
        confidenceAdjustment *= 0.88;
      }

    } else if (sport === 'tennis') {
      const surface = stats.additionalContext?.surfaceType as string | undefined;
      if (!surface) {
        errors.push('Tennis: missing surface type — cannot price match without it');
      } else {
        const validSurfaces = ['clay', 'grass', 'hard', 'carpet'];
        if (!validSurfaces.includes(surface.toLowerCase())) {
          errors.push(`Tennis: unknown surface: ${surface}`);
        }
        if (surface === 'grass') {
          warnings.push('Tennis: grass surface — small sample, high variance');
          confidenceAdjustment *= 0.88;
        }
        if (surface === 'carpet') {
          warnings.push('Tennis: carpet surface — rare, limited historical data');
          confidenceAdjustment *= 0.85;
        }
      }

      const fatigue = stats.situational?.fatigueDays;
      if (fatigue !== undefined && fatigue < 2) {
        warnings.push(`Tennis: back-to-back match (${fatigue} days rest)`);
        confidenceAdjustment *= 0.85;
      }

      if (!stats.situational?.weather) {
        warnings.push('Tennis: no weather data');
        confidenceAdjustment *= 0.95;
      } else {
        const weather = stats.situational.weather.toLowerCase();
        if (weather.includes('wind')) {
          warnings.push('Tennis: windy conditions — big servers disadvantaged');
          confidenceAdjustment *= 0.90;
        }
      }

    } else if (sport === 'basketball') {
      const pace = (stats.additionalContext?.pace as number | undefined);
      if (pace === undefined) {
        errors.push(`Basketball: missing pace data — totals cannot be priced`);
      } else if (pace < THRESHOLDS.BASKETBALL_MIN_PACE) {
        warnings.push(`Basketball: low pace (${pace})`);
        confidenceAdjustment *= 0.90;
      }

      const hasPointsData = stats.homeForm?.some(f => f.goalsFor !== undefined);
      if (!hasPointsData) {
        errors.push('Basketball: no points data in form — totals unpriceable');
      }

      const homeVenueGames = stats.homeForm?.filter(f => f.venue === 'home').length || 0;
      const awayVenueGames = stats.awayForm?.filter(f => f.venue === 'away').length || 0;
      if (homeVenueGames < 2) {
        warnings.push(`Basketball: low home venue sample: ${homeVenueGames}`);
        confidenceAdjustment *= 0.90;
      }
      if (awayVenueGames < 2) {
        warnings.push(`Basketball: low away venue sample: ${awayVenueGames}`);
        confidenceAdjustment *= 0.90;
      }

      if (!stats.referee?.name) {
        warnings.push('Basketball: no referee data — foul rate unknown');
        confidenceAdjustment *= 0.93;
      } else if (stats.referee.avgFouls !== undefined) {
        if (stats.referee.avgFouls > 50) {
          warnings.push(`Basketball: high-foul referee (${stats.referee.avgFouls} avg)`);
          confidenceAdjustment *= 0.92;
        }
        if (stats.referee.avgFouls < 35) {
          warnings.push(`Basketball: low-foul referee (${stats.referee.avgFouls} avg)`);
          confidenceAdjustment *= 0.92;
        }
      }

      const fatigue = stats.situational?.fatigueDays;
      if (fatigue !== undefined && fatigue < 2) {
        warnings.push(`Basketball: back-to-back (${fatigue} days rest)`);
        confidenceAdjustment *= 0.85;
      }

    } else if (sport === 'hockey') {
      const hasGoalsData = stats.homeForm?.some(f => f.goalsFor !== undefined);
      if (!hasGoalsData) {
        errors.push('Hockey: no goals data in form — totals and puck line unpriceable');
      }

      const homeVenueGames = stats.homeForm?.filter(f => f.venue === 'home').length || 0;
      const awayVenueGames = stats.awayForm?.filter(f => f.venue === 'away').length || 0;
      if (homeVenueGames < 2) {
        warnings.push(`Hockey: low home ice sample: ${homeVenueGames}`);
        confidenceAdjustment *= 0.90;
      }
      if (awayVenueGames < 2) {
        warnings.push(`Hockey: low away sample: ${awayVenueGames}`);
        confidenceAdjustment *= 0.90;
      }

      const fatigue = stats.situational?.fatigueDays;
      if (fatigue !== undefined && fatigue < 2) {
        warnings.push(`Hockey: severe fatigue (${fatigue} days rest)`);
        confidenceAdjustment *= 0.87;
      }

      if (!stats.referee?.name) {
        warnings.push('Hockey: no referee data — power play frequency unknown');
        confidenceAdjustment *= 0.93;
      } else if (stats.referee.avgYellowCards !== undefined) {
        if (stats.referee.avgYellowCards > 15) {
          warnings.push(`Hockey: high-penalty referee`);
          confidenceAdjustment *= 0.90;
        }
      }

      if (stats.situational?.weather) {
        const weather = stats.situational.weather.toLowerCase();
        if (weather.includes('wind') || weather.includes('snow')) {
          warnings.push('Hockey: outdoor game conditions — extreme variance');
          confidenceAdjustment *= 0.75;
        }
      }
    }

    this.log('Stats', stats.matchId, errors, warnings);
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      confidenceAdjustment: parseFloat(confidenceAdjustment.toFixed(4)),
    };
  }

  validateStatsBatch(statsList: CleanedStats[]): CleanedStats[] {
    const valid = statsList.filter(s => this.validateStats(s).valid);
    logger.info(`[Validator] Stats: ${statsList.length} → ${valid.length} valid`);
    return valid;
  }

  // ─── EDGE VALIDATION ──────────────────────────────────────────────────────

  validateEdge(
    trueProbability: number,
    impliedProbability: number,
    confidence: number,
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let confidenceAdjustment = 1.0;

    if (trueProbability <= 0 || trueProbability > 1) {
      errors.push(`Invalid trueProbability: ${trueProbability}`);
    }
    if (impliedProbability <= 0 || impliedProbability >= 1) {
      errors.push(`Invalid impliedProbability: ${impliedProbability}`);
    }

    const edge = trueProbability - impliedProbability;
    if (edge <= 0) {
      errors.push(`No edge: ${(edge * 100).toFixed(2)}% — bookmaker has the advantage`);
    }
    if (edge > 0 && edge < THRESHOLDS.MIN_EDGE) {
      errors.push(`Edge too small: ${(edge * 100).toFixed(2)}% (min ${THRESHOLDS.MIN_EDGE * 100}%)`);
    }
    if (edge >= THRESHOLDS.MIN_EDGE && edge < THRESHOLDS.GOOD_EDGE) {
      warnings.push(`Marginal edge: ${(edge * 100).toFixed(2)}% — reduce stake`);
      confidenceAdjustment *= 0.85;
    }

    if (confidence < THRESHOLDS.MIN_CONFIDENCE) {
      errors.push(`Confidence too low: ${(confidence * 100).toFixed(1)}% (min ${THRESHOLDS.MIN_CONFIDENCE * 100}%)`);
    }
    if (confidence >= THRESHOLDS.MIN_CONFIDENCE && confidence < THRESHOLDS.GOOD_CONFIDENCE) {
      warnings.push(`Moderate confidence: ${(confidence * 100).toFixed(1)}% — consider half stake`);
      confidenceAdjustment *= 0.75;
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      confidenceAdjustment: parseFloat(confidenceAdjustment.toFixed(4)),
    };
  }

  // ─── PRIVATE HELPERS ──────────────────────────────────────────────────────

  private log(
    type: string,
    id: string,
    errors: string[],
    warnings: string[]
  ): void {
    if (errors.length > 0) {
      logger.warn(`[Validator] ${type} ${id} REJECTED`, { errors });
    } else if (warnings.length > 0) {
      logger.info(`[Validator] ${type} ${id} ACCEPTED with warnings`, { warnings });
    }
  }
}