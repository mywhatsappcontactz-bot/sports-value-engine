  import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { Match, Odds, Stats, ValueBet, CLVRecord } from './schema';
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

  upsertStats(stats: Omit<Stats, 'id' | 'lastUpdated'>): void {
    const existing = this.db.prepare(
      `SELECT id FROM stats WHERE matchId = ?`
    ).get(stats.matchId) as { id: string } | undefined;

    const values = [
      JSON.stringify(stats.h2h || []),
      JSON.stringify(stats.homeForm || []),
      JSON.stringify(stats.awayForm || []),
      JSON.stringify(stats.referee || {}),
      JSON.stringify(stats.situational || {}),
      JSON.stringify(stats.additionalContext || {}),
      JSON.stringify(stats.confidenceFactors || {}),
    ];

    if (existing) {
      this.db.prepare(`
        UPDATE stats SET
          sport = ?, h2h = ?, homeForm = ?, awayForm = ?, referee = ?,
          situational = ?, additionalContext = ?, confidenceFactors = ?,
          lastUpdated = CURRENT_TIMESTAMP
        WHERE matchId = ?
      `).run(stats.sport, ...values, stats.matchId);
    } else {
      this.db.prepare(`
        INSERT INTO stats (id, matchId, sport, h2h, homeForm, awayForm, referee, situational, additionalContext, confidenceFactors)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), stats.matchId, stats.sport, ...values);
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
}