// src/core/engine/cornersGradingJob.ts
//
// Run this once daily (separate Task Scheduler job from the 30-min scanner).
// Pulls a budget-limited batch of pending corners tips whose matches have
// already kicked off, looks up the real fixture on API-Football, fetches
// final corner stats, and grades hit/miss + Brier score.
//
// This is DELIBERATELY not real-time. A tip from Saturday might not get
// graded until Tuesday if the queue is backed up — that's fine, nothing
// here needs same-day settlement. The queue exists specifically so a busy
// weekend's tip volume doesn't need to fit inside a single day's API budget.

import 'dotenv/config';
import { getDb } from '../database/db';
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';
import { CornersGradingQueueEntry } from '../database/schema';

const API_FOOTBALL_KEY = process.env.API_FOOTBALL_KEY;
const API_FOOTBALL_BASE = 'https://v3.football.api-sports.io';

// Leave headroom below the 100/day free-tier cap — other jobs may also use
// this key, and a lookup call plus a stats call can both be needed per tip.
const DAILY_BUDGET = 40;

if (!API_FOOTBALL_KEY) {
  throw new Error('[CornersGradingJob] API_FOOTBALL_KEY not set in .env');
}

async function apiFootballGet(path: string, params: Record<string, string>): Promise<any> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API_FOOTBALL_BASE}${path}?${query}`, {
    headers: { 'x-apisports-key': API_FOOTBALL_KEY! },
  });
  if (!res.ok) throw new Error(`API-Football HTTP ${res.status} for ${path}`);
  return res.json();
}

// Finds the API-Football fixture ID for a given match. This is a best-effort
// name match — API-Football team names won't line up perfectly with your
// internal names any more than FCStats/SoccerStats did, so this reuses the
// same normalize-and-compare approach as the other scrapers rather than
// assuming exact string equality.
function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

async function findFixtureId(entry: CornersGradingQueueEntry): Promise<number | null> {
  const dateOnly = entry.startTime.split('T')[0];
  const data = await apiFootballGet('/fixtures', { date: dateOnly, status: 'FT' });

  const homeKey = normalize(entry.homeTeam);
  const awayKey = normalize(entry.awayTeam);

  for (const fixture of data.response ?? []) {
    const fHome = normalize(fixture.teams?.home?.name ?? '');
    const fAway = normalize(fixture.teams?.away?.name ?? '');
    if (
      (fHome.includes(homeKey) || homeKey.includes(fHome)) &&
      (fAway.includes(awayKey) || awayKey.includes(fAway))
    ) {
      return fixture.fixture.id;
    }
  }
  return null;
}

// Sums both teams' corner-kick stats from the fixture statistics response.
// Returns null if corners weren't reported for this fixture (documented
// API-Football limitation — not every league/match has every stat type).
function extractTotalCorners(statsResponse: any): number | null {
  let total = 0;
  let found = false;

  for (const teamStats of statsResponse.response ?? []) {
    const cornerStat = (teamStats.statistics ?? []).find(
      (s: any) => s.type === 'Corner Kicks'
    );
    if (cornerStat && cornerStat.value != null) {
      total += Number(cornerStat.value);
      found = true;
    }
  }

  return found ? total : null;
}

function evaluateSelection(selection: string, actualCorners: number): boolean {
  // selection is shaped like "Over 9.5"
  const match = selection.match(/Over\s+([\d.]+)/);
  if (!match) return false;
  const line = parseFloat(match[1]);
  return actualCorners > line;
}

export async function runCornersGradingJob(): Promise<void> {
  const db = getDb();
  const repository = new Repository(db);

  const pending = repository.getPendingCornersGrading(DAILY_BUDGET);
  if (!pending.length) {
    logger.info('[CornersGradingJob] No pending corners tips to grade');
    return;
  }

  logger.info(`[CornersGradingJob] Grading ${pending.length} pending tips (budget: ${DAILY_BUDGET}/day)`);

  let graded = 0;
  let unresolved = 0;

  for (const entry of pending) {
    try {
      const fixtureId = entry.apiFootballFixtureId ?? (await findFixtureId(entry));

      if (!fixtureId) {
        logger.warn('[CornersGradingJob] Could not match fixture', {
          matchId: entry.matchId,
          homeTeam: entry.homeTeam,
          awayTeam: entry.awayTeam,
        });
        repository.markCornersUnresolvable(entry.id);
        unresolved++;
        continue;
      }

      const statsResponse = await apiFootballGet('/fixtures/statistics', {
        fixture: String(fixtureId),
      });

      const actualCorners = extractTotalCorners(statsResponse);

      if (actualCorners == null) {
        logger.warn('[CornersGradingJob] No corners stat in response', {
          matchId: entry.matchId,
          fixtureId,
        });
        repository.markCornersUnresolvable(entry.id);
        unresolved++;
        continue;
      }

      const hit = evaluateSelection(entry.targetSelection, actualCorners);
      const actualOutcome = hit ? 1 : 0;
      const brierScore = Math.pow(entry.predictedProbability - actualOutcome, 2);

      repository.markCornersGraded(entry.id, actualCorners, hit, brierScore);
      graded++;

      logger.info('[CornersGradingJob] Graded', {
        matchId: entry.matchId,
        selection: entry.targetSelection,
        actualCorners,
        hit,
        brierScore: brierScore.toFixed(4),
      });
    } catch (err: any) {
      logger.error('[CornersGradingJob] Failed to grade entry', {
        matchId: entry.matchId,
        error: err.message,
      });
      // Leave as 'pending' — will retry on next run, not marked unresolvable
      // for a transient error (network, rate limit, etc.).
    }
  }

  logger.info(`[CornersGradingJob] Done — graded: ${graded}, unresolvable: ${unresolved}`);

  const summary = repository.getCornersGradingSummary();
  logger.info('[CornersGradingJob] Running summary', {
    totalGraded: summary.totalGraded,
    hitRate: (summary.hitRate * 100).toFixed(1) + '%',
    avgBrierScore: summary.avgBrierScore.toFixed(4),
  });
}

// Allow running directly: npx ts-node src/core/engine/cornersGradingJob.ts
if (require.main === module) {
  runCornersGradingJob()
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error('[CornersGradingJob] Fatal error', { error: err.message });
      process.exit(1);
    });
}