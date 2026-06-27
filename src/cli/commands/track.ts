// src/cli/commands/track.ts
// Resolves pending value bets against real results, and records CLV
// (closing line value) by comparing the odds we got vs the closing odds
// fetched from Pinnacle at scan time.
//
// Run daily: npx ts-node src/cli/commands/track.ts [sport]

process.env.CLI_SILENT = 'true';

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../core/database/db';
import { Repository } from '../../core/database/repository';
import { oddsClient, RawScore } from '../../data-bridge/apiClients/oddsClient';
import { SUPPORTED_SPORTS, Sport } from '../../data-bridge/realFetcher';
import { ValueBet, Match } from '../../core/database/schema';
import { logger } from '../../core/utils/logger';

// ─── RESULT EVALUATION ─────────────────────────────────────

type Outcome = 'won' | 'lost' | 'void';

/**
 * Decide if a value bet won, lost, or voided based on the final score
 * and the bet's market + selection.
 */
function evaluateBet(bet: ValueBet, match: Match, score: RawScore): Outcome | null {
  if (score.homeScore === null || score.awayScore === null) return null;

  const homeScore = score.homeScore;
  const awayScore = score.awayScore;
  const total = homeScore + awayScore;

  // ── TOTALS: "Over 2.5" / "Under 2.5" etc ──────────────
  if (bet.market === 'totals') {
    const m = bet.selection.match(/^(Over|Under)\s+([\d.]+)$/i);
    if (!m) return null;

    const side = m[1].toLowerCase();
    const line = parseFloat(m[2]);

    if (total === line) return 'void'; // shouldn't happen with .5 lines, but guard anyway
    if (side === 'over')  return total > line ? 'won' : 'lost';
    if (side === 'under') return total < line ? 'won' : 'lost';
    return null;
  }

  // ── MONEYLINE: "Home" / "Away" / "Draw" / actual team or player name ──
  if (bet.market === 'moneyline') {
    const sel = bet.selection.toLowerCase();

    if (sel === 'draw') {
      return homeScore === awayScore ? 'won' : 'lost';
    }
    if (sel === 'home' || sel === match.homeTeam.toLowerCase()) {
      return homeScore > awayScore ? 'won' : (homeScore === awayScore ? 'void' : 'lost');
    }
    if (sel === 'away' || sel === match.awayTeam.toLowerCase()) {
      return awayScore > homeScore ? 'won' : (homeScore === awayScore ? 'void' : 'lost');
    }
    return null;
  }

  return null; // unknown market — leave pending, don't guess
}

// ─── CLV CALCULATION ────────────────────────────────────────

/**
 * CLV = how much better/worse our odds were vs the closing line.
 * Positive CLV means we beat the market — the gold standard signal
 * that a betting strategy has a real, sustainable edge.
 */
function calculateCLV(ourOdds: number, closingOdds: number): { clvValue: number; clvPercentage: number } {
  const ourImplied = 1 / ourOdds;
  const closingImplied = 1 / closingOdds;
  const clvValue = closingImplied - ourImplied; // positive = we got better odds than closing
  const clvPercentage = (ourOdds / closingOdds - 1) * 100;
  return { clvValue: parseFloat(clvValue.toFixed(6)), clvPercentage: parseFloat(clvPercentage.toFixed(4)) };
}

// ─── RESOLVE PENDING BETS ───────────────────────────────────

async function resolveBetsForSport(repo: Repository, sport: Sport): Promise<{
  resolved: number;
  won: number;
  lost: number;
  voided: number;
  clvRecorded: number;
}> {
  const stats = { resolved: 0, won: 0, lost: 0, voided: 0, clvRecorded: 0 };

  const db = getDb();

  // Pull all pending value bets for this sport, joined with their match
  const pendingBets = db.prepare(`
    SELECT vb.*, m.homeTeam, m.awayTeam, m.externalId, m.startTime, m.sport
    FROM value_bets vb
    JOIN matches m ON m.id = vb.matchId
    WHERE vb.status = 'pending' AND m.sport = ?
  `).all(sport) as (ValueBet & Match)[];

  if (!pendingBets.length) {
    logger.info(`[Tracker] No pending bets for ${sport}`);
    return stats;
  }

  logger.info(`[Tracker] Checking ${pendingBets.length} pending bets for ${sport}`);

  let scores: RawScore[];
  try {
    scores = await oddsClient.fetchScores(sport, 3);
  } catch (err: any) {
    logger.error(`[Tracker] Failed to fetch scores for ${sport}`, { error: err.message });
    return stats;
  }

  const scoreByExternalId = new Map(scores.map(s => [s.externalId, s]));

  for (const bet of pendingBets) {
    const score = scoreByExternalId.get((bet as any).externalId);
    if (!score) continue; // match not finished yet, or outside the 3-day window

    const match: Match = {
      id: bet.matchId,
      sport: (bet as any).sport,
      league: '',
      homeTeam: (bet as any).homeTeam,
      awayTeam: (bet as any).awayTeam,
      startTime: (bet as any).startTime,
    };

    const outcome = evaluateBet(bet, match, score);
    if (!outcome) continue; // couldn't parse this market/selection — leave pending for manual review

    repo.updateValueBetStatus(bet.id, outcome);
    stats.resolved++;
    if (outcome === 'won') stats.won++;
    else if (outcome === 'lost') stats.lost++;
    else stats.voided++;

    logger.info(`[Tracker] ${outcome.toUpperCase()} — ${match.homeTeam} vs ${match.awayTeam} — ${bet.market} ${bet.selection} @ ${bet.bookmakerOdds}`, {
      finalScore: `${score.homeScore}-${score.awayScore}`,
    });
  }

  return stats;
}

// ─── CLOSING LINE VALUE ──────────────────────────────────────
// Run this BEFORE a match starts (e.g. a few hours before kickoff) to
// snapshot Pinnacle's near-closing odds. Compares against the odds we
// originally bet at, recorded in value_bets.bookmakerOdds.

async function recordCLVForSport(repo: Repository, sport: Sport): Promise<number> {
  const db = getDb();

  const pendingBets = db.prepare(`
    SELECT vb.*, m.homeTeam, m.awayTeam, m.externalId, m.startTime
    FROM value_bets vb
    JOIN matches m ON m.id = vb.matchId
    WHERE vb.status = 'pending' AND vb.clvValue IS NULL AND m.sport = ?
  `).all(sport) as (ValueBet & Match)[];

  if (!pendingBets.length) return 0;

  let recorded = 0;

  // Fetch fresh odds (live, near-closing) for this sport
  let live: { matches: any[]; oddsMap: Map<string, any[]> };
  try {
    oddsClient.clearCache(sport); // force a fresh pull, not the cached scan-time snapshot
    live = await oddsClient.fetchForSport(sport);
  } catch (err: any) {
    logger.warn(`[Tracker] Failed to fetch live odds for CLV (${sport})`, { error: err.message });
    return 0;
  }

  for (const bet of pendingBets) {
    const externalId = (bet as any).externalId;
    const currentOdds = live.oddsMap.get(externalId);
    if (!currentOdds) continue;

    const pinnacleLine = currentOdds.find(
      (o: any) => o.bookmaker === 'Pinnacle' && o.market === bet.market && o.selection === bet.selection,
    );
    if (!pinnacleLine) continue;

    const { clvValue, clvPercentage } = calculateCLV(bet.bookmakerOdds, pinnacleLine.odds);

    db.prepare(`
      UPDATE value_bets SET closingOdds = ?, clvValue = ?, updatedAt = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(pinnacleLine.odds, clvValue, bet.id);

    repo.saveCLVRecord({
      valueBetId: bet.id,
      matchId: bet.matchId,
      openingOdds: bet.bookmakerOdds,
      closingOdds: pinnacleLine.odds,
      ourOdds: bet.bookmakerOdds,
      clvValue,
      clvPercentage,
    });

    recorded++;
    logger.info(`[Tracker] CLV recorded — ${bet.market} ${bet.selection}`, {
      ourOdds: bet.bookmakerOdds,
      closingOdds: pinnacleLine.odds,
      clvPercentage: `${clvPercentage.toFixed(2)}%`,
    });
  }

  return recorded;
}

// ─── SUMMARY REPORT ──────────────────────────────────────────

function printSummary(repo: Repository) {
  const db = getDb();

  const overall = db.prepare(`
    SELECT
      status,
      COUNT(*) as count,
      AVG(edge) as avgEdge,
      AVG(confidence) as avgConfidence
    FROM value_bets
    WHERE status IN ('won', 'lost', 'void')
    GROUP BY status
  `).all() as any[];

  const roi = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'won' THEN (bookmakerOdds - 1) * kellyStake ELSE 0 END) as totalWinnings,
      SUM(CASE WHEN status = 'lost' THEN kellyStake ELSE 0 END) as totalLosses,
      SUM(kellyStake) as totalStaked,
      COUNT(*) as totalSettled
    FROM value_bets
    WHERE status IN ('won', 'lost')
  `).get() as any;

  const clv = repo.getCLVSummary();

  console.log('\n\x1b[1m\x1b[36m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m\x1b[36m   📈 BET TRACKER SUMMARY\x1b[0m');
  console.log('\x1b[1m\x1b[36m' + '═'.repeat(60) + '\x1b[0m\n');

  console.log('  RESULTS BY STATUS');
  console.log('  ' + '─'.repeat(50));
  for (const row of overall) {
    console.log(
      `  ${row.status.toUpperCase().padEnd(8)} ` +
      `count: ${String(row.count).padEnd(6)} ` +
      `avg edge: ${(row.avgEdge * 100).toFixed(2)}%`.padEnd(16) +
      `avg conf: ${(row.avgConfidence * 100).toFixed(1)}%`
    );
  }

  const wonCount = overall.find(r => r.status === 'won')?.count || 0;
  const lostCount = overall.find(r => r.status === 'lost')?.count || 0;
  const totalDecided = wonCount + lostCount;
  const strikeRate = totalDecided > 0 ? (wonCount / totalDecided) * 100 : 0;

  console.log('\n  PROFIT / LOSS (in units of kellyStake bankroll %)');
  console.log('  ' + '─'.repeat(50));
  console.log(`  Total settled bets : ${roi.totalSettled || 0}`);
  console.log(`  Strike rate        : ${strikeRate.toFixed(1)}%`);
  console.log(`  Total staked       : ${(roi.totalStaked || 0).toFixed(4)}`);
  console.log(`  Total winnings     : ${(roi.totalWinnings || 0).toFixed(4)}`);
  console.log(`  Net profit/loss    : ${((roi.totalWinnings || 0) - (roi.totalLosses || 0)).toFixed(4)}`);

  const netPL = (roi.totalWinnings || 0) - (roi.totalLosses || 0);
  const roiPct = roi.totalStaked > 0 ? (netPL / roi.totalStaked) * 100 : 0;
  console.log(`  ROI                : ${roiPct.toFixed(2)}%`);

  console.log('\n  CLOSING LINE VALUE (the real test of model sharpness)');
  console.log('  ' + '─'.repeat(50));
  console.log(`  Bets with CLV data : ${clv.totalBets}`);
  console.log(`  Positive CLV       : ${clv.positiveCLV} (${clv.totalBets > 0 ? ((clv.positiveCLV / clv.totalBets) * 100).toFixed(1) : 0}%)`);
  console.log(`  Avg CLV            : ${(clv.avgCLV * 100).toFixed(3)}%`);

  console.log('\n\x1b[36m' + '═'.repeat(60) + '\x1b[0m\n');
}

// ─── MAIN ─────────────────────────────────────────────────────

async function runTracker(sportArg?: string) {
  const sportsToCheck: Sport[] = (sportArg && sportArg !== 'all')
    ? [sportArg as Sport]
    : [...SUPPORTED_SPORTS];

  const repo = new Repository(getDb());

  for (const sport of sportsToCheck) {
    console.log(`\n\x1b[90m[track] Checking results for ${sport}...\x1b[0m`);
    const result = await resolveBetsForSport(repo, sport);
    console.log(
      `\x1b[90m[track] ${sport}: ${result.resolved} resolved ` +
      `(${result.won} won, ${result.lost} lost, ${result.voided} void)\x1b[0m`
    );

    console.log(`\x1b[90m[track] Recording CLV for ${sport}...\x1b[0m`);
    const clvCount = await recordCLVForSport(repo, sport);
    console.log(`\x1b[90m[track] ${sport}: ${clvCount} CLV records saved\x1b[0m`);
  }

  printSummary(repo);
}

const sportArg = process.argv[2];
runTracker(sportArg).catch(err => {
  logger.error('[Tracker] Failed', { error: err.message });
  process.exit(1);
});