// src/scrapers/darts/dartsMatchStore.ts
//
// Self-built H2H replacement. dartsdatabase.co.uk's own H2H search was
// confirmed broken (returns unrelated static content regardless of
// input — see dartsDatabaseScraper.ts comments for the full story).
//
// Instead: every event result we scrape gets appended here, permanently
// (not on a TTL like the stats caches — completed matches never change).
// H2H between two players is then just a query over this accumulated
// history — same principle as football's FDCO/FCStats H2H, just
// computed from our own data instead of a live third-party lookup.
//
// This starts empty and gets richer over time as more events are
// scraped. Early on, H2H may return few/no meetings for players who
// haven't faced each other since scraping began — that's an expected
// cold-start gap, not a bug.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';
import { DartsMatchResult } from './dartsDatabaseScraper';

// ─── TYPES ───────────────────────────────────────────────────────────────────

export interface StoredDartsMatch {
  eventId:     string;
  eventName:   string;
  date:        string;
  player1:     string;
  player2:     string;
  player1Avg:  number | null;
  player2Avg:  number | null;
  player1Legs: number;
  player2Legs: number;
  round:       string | null;
  winner:      string;
}

export interface DartsH2HResult {
  player1Name:     string;
  player2Name:      string;
  player1Wins:      number;
  player2Wins:      number;
  totalMeetings:    number;
  recentMeetings:   StoredDartsMatch[]; // most recent first, capped
  player1RecentAvg: number | null;      // avg of player1Avg across recent meetings
  player2RecentAvg: number | null;
}

const STORE_PATH = path.join(__dirname, '../../../.cache/stats/darts-match-history.json');
const MAX_H2H_MEETINGS_RETURNED = 10;

// ─── STORE I/O ────────────────────────────────────────────────────────────────
// Flat JSON array. Simple and sufficient for realistic darts match
// volumes (a full PDC season is a few thousand matches, not millions) —
// revisit with a real DB table if this ever becomes a performance
// concern, but it won't at this scale.

function readStore(): StoredDartsMatch[] {
  try {
    if (!fs.existsSync(STORE_PATH)) return [];
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
  } catch (err: any) {
    logger.warn('[DartsMatchStore] Failed to read store — starting fresh', { error: err.message });
    return [];
  }
}

function writeStore(matches: StoredDartsMatch[]): void {
  try {
    const dir = path.dirname(STORE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(matches), 'utf-8');
  } catch (err: any) {
    logger.error('[DartsMatchStore] Failed to write store', { error: err.message });
  }
}

function normalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── RECORD RESULTS ───────────────────────────────────────────────────────────
// Call this after every fetchEventResults() — appends new matches,
// de-duplicating by (eventId + player1 + player2 + round), so re-running
// a scan against an already-scraped event doesn't create duplicates.

export function recordEventResults(
  eventId: string,
  eventName: string,
  date: string,
  matches: DartsMatchResult[],
): number {
  const store = readStore();

  const existingKeys = new Set(
    store.map(m => `${m.eventId}|${normalize(m.player1)}|${normalize(m.player2)}|${m.round}`)
  );

  let added = 0;

  for (const match of matches) {
    const key = `${eventId}|${normalize(match.player1)}|${normalize(match.player2)}|${match.round}`;
    if (existingKeys.has(key)) continue;

    store.push({
      eventId,
      eventName,
      date,
      player1: match.player1,
      player2: match.player2,
      player1Avg: match.player1Avg,
      player2Avg: match.player2Avg,
      player1Legs: match.player1Legs,
      player2Legs: match.player2Legs,
      round: match.round,
      winner: match.player1Legs > match.player2Legs ? match.player1 : match.player2,
    });
    existingKeys.add(key);
    added++;
  }

  if (added > 0) {
    writeStore(store);
    logger.info('[DartsMatchStore] Recorded new matches', { eventId, eventName, added });
  }

  return added;
}

// ─── QUERY H2H ────────────────────────────────────────────────────────────────

export function getH2H(player1Name: string, player2Name: string): DartsH2HResult {
  const store = readStore();
  const n1 = normalize(player1Name);
  const n2 = normalize(player2Name);

  const meetings = store
    .filter(m => {
      const mp1 = normalize(m.player1);
      const mp2 = normalize(m.player2);
      return (mp1 === n1 && mp2 === n2) || (mp1 === n2 && mp2 === n1);
    })
    .sort((a, b) => b.date.localeCompare(a.date)); // most recent first (assumes ISO-sortable date strings)

  let p1Wins = 0, p2Wins = 0;
  const p1Avgs: number[] = [];
  const p2Avgs: number[] = [];

  for (const m of meetings) {
    const mp1IsPlayer1 = normalize(m.player1) === n1;
    const winnerIsPlayer1 = normalize(m.winner) === n1;

    if (winnerIsPlayer1) p1Wins++; else p2Wins++;

    const p1Avg = mp1IsPlayer1 ? m.player1Avg : m.player2Avg;
    const p2Avg = mp1IsPlayer1 ? m.player2Avg : m.player1Avg;
    if (p1Avg !== null) p1Avgs.push(p1Avg);
    if (p2Avg !== null) p2Avgs.push(p2Avg);
  }

  const avg = (arr: number[]): number | null =>
    arr.length ? parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2)) : null;

  return {
    player1Name,
    player2Name,
    player1Wins: p1Wins,
    player2Wins: p2Wins,
    totalMeetings: meetings.length,
    recentMeetings: meetings.slice(0, MAX_H2H_MEETINGS_RETURNED),
    player1RecentAvg: avg(p1Avgs),
    player2RecentAvg: avg(p2Avgs),
  };
}

// ─── RECENT FORM (for a single player, not a pair) ───────────────────────────
// Useful for the "dominant form" tip rule even without an H2H history —
// pulls a player's own recent matches regardless of opponent.

export function getRecentForm(playerName: string, limit: number = 10): StoredDartsMatch[] {
  const store = readStore();
  const n = normalize(playerName);

  return store
    .filter(m => normalize(m.player1) === n || normalize(m.player2) === n)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

export function getStoreSize(): number {
  return readStore().length;
}