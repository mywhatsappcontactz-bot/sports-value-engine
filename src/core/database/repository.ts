import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Match, Odds, Stats, ValueBet, CLVRecord, CornersGradingQueueEntry, GoalsGradingQueueEntry } from './schema';
import { withTransaction } from './db';
import { logger } from '../utils/logger';

export class Repository {
  constructor(private db: Database.Database) {}

  // ─── MATCHES ────────────────────────────────────────────────────────────────

  upsertMatch(match: Omit<Match, 'id' | 'createdAt' | 'updatedAt'>): string {
    const existing = this.db.prepare(
      `SELECT id, status FROM matches WHERE externalId = ? AND source = ?`
    ).get(match.externalId, match.source) as { id: string, status: string } | undefined;

    if (existing) {
      const isFinished = existing.status === 'completed' || existing.status === 'closed';
      const newStatus = isFinished ? existing.status : (match.status || 'upcoming');

      this.db.prepare(`
        UPDATE matches SET
          sport = ?, league = ?, homeTeam = ?, awayTeam = ?,
          startTime = ?, status = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        match.sport, match.league, match.homeTeam, match.awayTeam,
        match.startTime, newStatus, existing.id
      );
      return existing.id;
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO matches (id, sport, league, homeTeam, awayTeam, startTime, status, externalId, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, match.sport, match.league, match.homeTeam, match.awayTeam,
      match.startTime, match.status || 'upcoming', match.externalId, match.source
    );
    return id;
  }

  markOldMatchesAsCompleted(): void {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE matches 
      SET status = 'completed', updatedAt = CURRENT_TIMESTAMP
      WHERE status = 'upcoming' AND startTime < ?
    `).run(now);
    
    if (result.changes > 0) {
      logger.info(`[db] Cleanup: Marked ${result.changes} stale matches as completed.`);
    }
  }

  getMatch(id: string): Match | undefined {
    return this.db.prepare(
      `SELECT * FROM matches WHERE id = ?`
    ).get(id) as Match | undefined;
  }

  getUpcomingMatches(sport?: string): Match[] {
    if (sport) {
      return this.db.prepare(
        `SELECT * FROM matches WHERE status = 'upcoming' AND sport = ? ORDER BY startTime ASC`
      ).all(sport) as Match[];
    }
    return this.db.prepare(
      `SELECT * FROM matches WHERE status = 'upcoming' ORDER BY startTime ASC`
    ).all() as Match[];
  }

  // ─── ODDS ────────────────────────────────────────────────────────────────────

  saveOddsBatch(oddsList: Omit<Odds, 'id'>[]): void {
    withTransaction(this.db, () => {
      const stmt = this.db.prepare(`
        INSERT INTO odds (id, matchId, bookmaker, market, selection, odds, impliedProbability, timestamp, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(matchId, bookmaker, market, selection)
        DO UPDATE SET
          odds = excluded.odds,
          impliedProbability = excluded.impliedProbability,
          timestamp = excluded.timestamp
      `);
      for (const o of oddsList) {
        const impliedProbability = parseFloat((1 / o.odds).toFixed(6));
        stmt.run(
          uuidv4(), o.matchId, o.bookmaker, o.market,
          o.selection, o.odds, impliedProbability,
          o.timestamp || new Date().toISOString(), o.source
        );
      }
    });
  }

  getLatestOdds(matchId: string, bookmaker?: string): Odds[] {
    if (bookmaker) {
      return this.db.prepare(`
        SELECT * FROM odds WHERE matchId = ? AND bookmaker = ?
        ORDER BY timestamp DESC
      `).all(matchId, bookmaker) as Odds[];
    }
    return this.db.prepare(`
      SELECT * FROM odds WHERE matchId = ?
      ORDER BY timestamp DESC
    `).all(matchId) as Odds[];
  }

  getClosingOdds(matchId: string, bookmaker: string, market: string, selection: string) {
    return this.db.prepare(`
      SELECT odds FROM odds 
      WHERE matchId = ? AND bookmaker = ? AND market = ? AND selection = ?
      ORDER BY timestamp DESC 
      LIMIT 1
    `).get(matchId, bookmaker, market, selection) as { odds: number } | undefined;
  }

  // ─── STATS ───────────────────────────────────────────────────────────────────
  // FIXED: upsertStats now writes homeGoalsAvg/awayGoalsAvg/homeCornersAvg/
  // awayCornersAvg — the original version had these columns in schema.ts but
  // never included them in the UPDATE/INSERT statements, so any caller passing
  // them had the values silently dropped. Confirmed inert for goals (nothing
  // outside data-bridge/ reads homeGoalsAvg/awayGoalsAvg back out of storage —
  // computeFootballLambdas derives from homeForm/awayForm instead), so this
  // fix does not change value-bet behavior. It's required for corners, since
  // homeCornersAvg/awayCornersAvg are the only place expected corners get stored.

  upsertStats(stats: Omit<Stats, 'id' | 'lastUpdated'>): void {
    const existing = this.db.prepare(
      `SELECT id FROM stats WHERE matchId = ?`
    ).get(stats.matchId) as { id: string } | undefined;

    const jsonValues = [
      JSON.stringify(stats.h2h || []),
      JSON.stringify(stats.homeForm || []),
      JSON.stringify(stats.awayForm || []),
      JSON.stringify(stats.referee || {}),
      JSON.stringify(stats.situational || {}),
      JSON.stringify(stats.additionalContext || {}),
      JSON.stringify(stats.confidenceFactors || {}),
    ];

    const numericValues = [
      stats.homeGoalsAvg ?? null,
      stats.awayGoalsAvg ?? null,
      stats.homeCornersAvg ?? null,
      stats.awayCornersAvg ?? null,
    ];

    if (existing) {
      this.db.prepare(`
        UPDATE stats SET
          sport = ?, h2h = ?, homeForm = ?, awayForm = ?, referee = ?,
          situational = ?, additionalContext = ?, confidenceFactors = ?,
          homeGoalsAvg = ?, awayGoalsAvg = ?, homeCornersAvg = ?, awayCornersAvg = ?,
          lastUpdated = CURRENT_TIMESTAMP
        WHERE matchId = ?
      `).run(stats.sport, ...jsonValues, ...numericValues, stats.matchId);
    } else {
      this.db.prepare(`
        INSERT INTO stats (id, matchId, sport, h2h, homeForm, awayForm, referee, situational,
          additionalContext, confidenceFactors, homeGoalsAvg, awayGoalsAvg, homeCornersAvg, awayCornersAvg)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), stats.matchId, stats.sport, ...jsonValues, ...numericValues);
    }
  }

  getStats(matchId: string): Stats | undefined {
    const row = this.db.prepare(
      `SELECT * FROM stats WHERE matchId = ?`
    ).get(matchId) as any;

    if (!row) return undefined;

    return {
      ...row,
      h2h: JSON.parse(row.h2h || '[]'),
      homeForm: JSON.parse(row.homeForm || '[]'),
      awayForm: JSON.parse(row.awayForm || '[]'),
      referee: JSON.parse(row.referee || '{}'),
      situational: JSON.parse(row.situational || '{}'),
      additionalContext: JSON.parse(row.additionalContext || '{}'),
      confidenceFactors: JSON.parse(row.confidenceFactors || '{}'),
    };
  }

  // Partial update for corners only — avoids requiring the full Stats object
  // (h2h, form, referee, etc.) when all we have is corner averages. Used by
  // cornersAggregator.ts. Tip-scanner input only — never touches value_bets
  // or anything valueEngine.ts / computeFootballLambdas reads.
  updateCornersAvg(matchId: string, homeCornersAvg: number, awayCornersAvg: number): void {
    const existing = this.db.prepare(
      `SELECT id FROM stats WHERE matchId = ?`
    ).get(matchId) as { id: string } | undefined;

    if (!existing) {
      logger.warn('[Repository] updateCornersAvg: no stats row exists for matchId — skipping', { matchId });
      return;
    }

    this.db.prepare(`
      UPDATE stats SET
        homeCornersAvg = ?, awayCornersAvg = ?, lastUpdated = CURRENT_TIMESTAMP
      WHERE matchId = ?
    `).run(homeCornersAvg, awayCornersAvg, matchId);
  }

  // Partial update for goals only — writes into stats.additionalContext
  // (JSON blob), NOT the separate homeGoalsAvg/awayGoalsAvg columns —
  // computeFootballLambdas (probabilityModel.ts) reads
  // stats.additionalContext.homeGoalsAvg/awayGoalsAvg, not the top-level
  // columns, so writing there instead of the columns would have been
  // silently inert, same class of bug the upsertStats fix above addressed.
  // Used by goalsAggregator.ts. Feeds BOTH tipScanner.ts and valueEngine.ts,
  // since both call computeFootballLambdas for football totals.
  updateGoalsAvg(matchId: string, homeGoalsAvg: number, awayGoalsAvg: number): void {
    const existing = this.db.prepare(
      `SELECT id, additionalContext FROM stats WHERE matchId = ?`
    ).get(matchId) as { id: string; additionalContext: string } | undefined;

    if (!existing) {
      logger.warn('[Repository] updateGoalsAvg: no stats row exists for matchId — skipping', { matchId });
      return;
    }

    const context = JSON.parse(existing.additionalContext || '{}');
    context.homeGoalsAvg = homeGoalsAvg;
    context.awayGoalsAvg = awayGoalsAvg;

    this.db.prepare(`
      UPDATE stats SET
        additionalContext = ?, lastUpdated = CURRENT_TIMESTAMP
      WHERE matchId = ?
    `).run(JSON.stringify(context), matchId);
  }

  // Partial update for confidenceFactors.dataCompleteness — safely adjusts
  // dataCompleteness without overwriting other fields (like corners, goals, or context).
  // Used by sync routines to lower completeness when goal scraping fails.
  updateDataCompleteness(matchId: string, dataCompleteness: number): void {
    const existing = this.db.prepare(
      `SELECT id, confidenceFactors FROM stats WHERE matchId = ?`
    ).get(matchId) as { id: string; confidenceFactors: string } | undefined;

    if (!existing) {
      logger.warn('[Repository] updateDataCompleteness: no stats row exists for matchId — skipping', { matchId });
      return;
    }

    const factors = JSON.parse(existing.confidenceFactors || '{}');
    factors.dataCompleteness = dataCompleteness;

    this.db.prepare(`
      UPDATE stats SET
        confidenceFactors = ?, lastUpdated = CURRENT_TIMESTAMP
      WHERE matchId = ?
    `).run(JSON.stringify(factors), matchId);
  }

  // ─── VALUE BETS ──────────────────────────────────────────────────────────────

  saveValueBet(bet: Omit<ValueBet, 'id' | 'createdAt'>): string {
    const existing = this.db.prepare(`
      SELECT id FROM value_bets
      WHERE matchId = ? AND market = ? AND selection = ? AND bookmaker = ?
    `).get(bet.matchId, bet.market, bet.selection, bet.bookmaker) as { id: string } | undefined;

    if (existing) {
      this.db.prepare(`
        UPDATE value_bets SET
          bookmakerOdds = ?, trueProbability = ?, impliedProbability = ?,
          edge = ?, kellyStake = ?, confidence = ?, status = ?
        WHERE id = ?
      `).run(
        bet.bookmakerOdds, bet.trueProbability, bet.impliedProbability,
        bet.edge, bet.kellyStake, bet.confidence, bet.status || 'pending',
        existing.id
      );
      return existing.id;
    }

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO value_bets (id, matchId, market, selection, bookmaker, bookmakerOdds,
        trueProbability, impliedProbability, edge, kellyStake, confidence, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, bet.matchId, bet.market, bet.selection, bet.bookmaker,
      bet.bookmakerOdds, bet.trueProbability, bet.impliedProbability,
      bet.edge, bet.kellyStake, bet.confidence, bet.status || 'pending'
    );
    logger.info('Value bet saved', { id, edge: bet.edge, confidence: bet.confidence });
    return id;
  }

  getValueBets(status?: string): ValueBet[] {
    if (status) {
      return this.db.prepare(
        `SELECT * FROM value_bets WHERE status = ? ORDER BY edge DESC`
      ).all(status) as ValueBet[];
    }
    return this.db.prepare(
      `SELECT * FROM value_bets ORDER BY edge DESC`
    ).all() as ValueBet[];
  }

  updateValueBetStatus(id: string, status: string, closingOdds?: number): void {
    if (closingOdds !== undefined) {
      this.db.prepare(`
        UPDATE value_bets SET status = ?, closingOdds = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, closingOdds, id);
    } else {
      this.db.prepare(`
        UPDATE value_bets SET status = ?, updatedAt = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(status, id);
    }
  }

  getPendingBetsNearKickoff(hoursThreshold: number): (ValueBet & { startTime: string; matchId: string })[] {
    const thresholdDate = new Date(Date.now() + hoursThreshold * 60 * 60 * 1000).toISOString();
    
    return this.db.prepare(`
      SELECT vb.*, m.startTime 
      FROM value_bets vb
      JOIN matches m ON vb.matchId = m.id
      WHERE vb.status = 'pending' 
      AND m.startTime <= ? 
      AND m.startTime > CURRENT_TIMESTAMP
    `).all(thresholdDate) as (ValueBet & { startTime: string; matchId: string })[];
  }

  // ─── CLV TRACKING ────────────────────────────────────────────────────────────

  saveCLVRecord(record: Omit<CLVRecord, 'id' | 'recordedAt'>): string {
    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO clv_tracking (id, valueBetId, matchId, openingOdds, closingOdds, ourOdds, clvValue, clvPercentage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, record.valueBetId, record.matchId,
      record.openingOdds, record.closingOdds,
      record.ourOdds, record.clvValue, record.clvPercentage
    );
    return id;
  }

  getCLVSummary(): { avgCLV: number; totalBets: number; positiveCLV: number } {
    const row = this.db.prepare(`
      SELECT
        AVG(clvValue) as avgCLV,
        COUNT(*) as totalBets,
        SUM(CASE WHEN clvValue > 0 THEN 1 ELSE 0 END) as positiveCLV
      FROM clv_tracking
    `).get() as any;

    return {
      avgCLV: row?.avgCLV || 0,
      totalBets: row?.totalBets || 0,
      positiveCLV: row?.positiveCLV || 0,
    };
  }

  // ─── CORNERS GRADING ─────────────────────────────────────────────────────

  enqueueCornersGrading(entry: Omit<CornersGradingQueueEntry, 'id' | 'status' | 'createdAt'>): void {
    const existing = this.db.prepare(`
      SELECT id FROM corners_grading_queue WHERE matchId = ? AND targetSelection = ?
    `).get(entry.matchId, entry.targetSelection) as { id: string } | undefined;

    if (existing) return;

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO corners_grading_queue
        (id, matchId, homeTeam, awayTeam, league, startTime, targetSelection, predictedProbability, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, entry.matchId, entry.homeTeam, entry.awayTeam, entry.league,
      entry.startTime, entry.targetSelection, entry.predictedProbability
    );
  }

  getPendingCornersGrading(limit: number): CornersGradingQueueEntry[] {
    return this.db.prepare(`
      SELECT * FROM corners_grading_queue
      WHERE status = 'pending' AND startTime < CURRENT_TIMESTAMP
      ORDER BY startTime ASC
      LIMIT ?
    `).all(limit) as CornersGradingQueueEntry[];
  }

  markCornersGraded(id: string, actualCorners: number, hit: boolean, brierScore: number): void {
    this.db.prepare(`
      UPDATE corners_grading_queue
      SET status = 'graded', actualCorners = ?, hit = ?, brierScore = ?, gradedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actualCorners, hit ? 1 : 0, brierScore, id);
  }

  markCornersUnresolvable(id: string): void {
    this.db.prepare(`
      UPDATE corners_grading_queue
      SET status = 'unresolvable', gradedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  }

  getCornersGradingSummary(): { totalGraded: number; hitRate: number; avgBrierScore: number } {
    const row = this.db.prepare(`
      SELECT
        COUNT(*) as totalGraded,
        AVG(hit) as hitRate,
        AVG(brierScore) as avgBrierScore
      FROM corners_grading_queue
      WHERE status = 'graded'
    `).get() as any;

    return {
      totalGraded: row?.totalGraded || 0,
      hitRate: row?.hitRate || 0,
      avgBrierScore: row?.avgBrierScore || 0,
    };
  }
  // ─── GOALS GRADING ───────────────────────────────────────────────────────────

  enqueueGoalsGrading(entry: Omit<GoalsGradingQueueEntry, 'id' | 'status' | 'createdAt'>): void {
    const existing = this.db.prepare(`
      SELECT id FROM goals_grading_queue WHERE matchId = ? AND targetSelection = ?
    `).get(entry.matchId, entry.targetSelection) as { id: string } | undefined;

    if (existing) return;

    const id = uuidv4();
    this.db.prepare(`
      INSERT INTO goals_grading_queue
        (id, matchId, homeTeam, awayTeam, league, startTime, targetSelection, predictedProbability, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(
      id, entry.matchId, entry.homeTeam, entry.awayTeam, entry.league,
      entry.startTime, entry.targetSelection, entry.predictedProbability
    );
  }
}
