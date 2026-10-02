// src/core/engine/nbaOddsBacktest.ts
//
// Backtests the NBA moneyline model against REAL historical odds from
// the same Kaggle odds CSV (nba_2008-2026.csv) — not squared/assumed
// combined probabilities, actual bookmaker prices matched to actual
// outcomes. Answers: does the calibrated model + MIN_TIP_CONFIDENCE
// floor actually clear breakeven at real prices, not just hit rate.
//
// Also includes a SHORT-ODDS 2-LEG PARLAY test: pairs up tips where the
// market AGREED with the model (short odds, previously "rejected" by the
// single-bet odds floor) into same-day 2-leg parlays, using REAL combined
// odds and REAL combined outcomes — not squared assumptions.
//
// IMPORTANT CAVEAT: per the dataset's own documentation, moneyline odds
// are ABSENT for Jan 17 2023 - Jun 22 2025 (ESPN-sourced period). Games
// in that window are automatically skipped (no odds to check) — this is
// expected, not a bug. Real moneyline coverage is Oct 2007-Jan 2023 and
// Oct 2025 onward.
//
// Run with: npx ts-node src/core/engine/nbaOddsBacktest.ts
// Set NBA_ODDS_CSV env var to override the CSV path (defaults to
// nba_2008-2026.csv in cwd).

import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const SEASONS: number[] = [2017, 2018, 2019]; // adjust to your actual 6-season range;
                                                // NOTE: keep this within the pre-2023
                                                // window until you confirm 2025-26
                                                // odds coverage resumed post-Oct 2025
const FORM_WINDOW = 10;
const MIN_PRIOR_GAMES = 5;
const CONFIDENCE_FLOOR = 0.70; // matches MIN_TIP_CONFIDENCE.basketball
const STAKE = 10000; // ₦10,000 flat per bet
const ODDS_CSV_PATH = process.env.NBA_ODDS_CSV ?? path.join(process.cwd(), 'nba_2008-2026.csv');

// Minimum-odds-to-bet buffer, matching the table we built earlier:
// minOdds ≈ 1 / (confidence - 0.05)
function minAcceptableOdds(confidence: number): number {
  return 1 / (confidence - 0.05);
}

// ─── CSV PARSING (quote-aware, same as nbaIsotonicFit.ts) ──────────────

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ─── AMERICAN -> DECIMAL ODDS ───────────────────────────────────────────

function americanToDecimal(american: number): number {
  if (american > 0) return (american / 100) + 1;
  return (100 / Math.abs(american)) + 1;
}

// ─── TYPES ──────────────────────────────────────────────────────────────

interface OddsGame {
  date: Date;
  season: number;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  moneylineHomeDecimal: number | null;
  moneylineAwayDecimal: number | null;
}

interface TeamGameRecord {
  date: Date;
  opponent: string;
  result: 'W' | 'L';
  isHome: boolean;
  pointsFor: number;
  pointsAgainst: number;
}

interface BacktestResult {
  matchId: string;
  date: string;
  favoredSide: 'home' | 'away';
  confidence: number;
  oddsUsed: number;
  minRequiredOdds: number;
  clearedOddsFloor: boolean;
  won: boolean;
  staked: number;
  profit: number;
}

interface ParlayResult {
  date: string;
  leg1Odds: number;
  leg2Odds: number;
  combinedOdds: number;
  leg1Won: boolean;
  leg2Won: boolean;
  bothWon: boolean;
  staked: number;
  profit: number;
}

// ─── LOAD CSV ───────────────────────────────────────────────────────────

function loadOddsGames(seasons: number[]): OddsGame[] {
  if (!fs.existsSync(ODDS_CSV_PATH)) {
    throw new Error(`Odds CSV not found at ${ODDS_CSV_PATH}. Set NBA_ODDS_CSV env var or place the file in cwd.`);
  }

  const raw = fs.readFileSync(ODDS_CSV_PATH, 'utf-8');
  const rows = parseCsv(raw);
  const header = rows[0];
  const col = (name: string) => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`Expected column "${name}" not found. Header: ${header.join(', ')}`);
    return idx;
  };

  const idx = {
    season: col('season'),
    date: col('date'),
    regular: col('regular'),
    away: col('away'),
    home: col('home'),
    score_away: col('score_away'),
    score_home: col('score_home'),
    moneyline_away: col('moneyline_away'),
    moneyline_home: col('moneyline_home'),
  };

  const seasonSet = new Set(seasons);
  const games: OddsGame[] = [];
  let skippedNoOdds = 0;
  let skippedNoScore = 0;
  let skippedNotRegular = 0;
  let skippedOutOfRange = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length || !r[idx.date]) continue;

    const season = parseInt(r[idx.season], 10);
    if (!seasonSet.has(season)) { skippedOutOfRange++; continue; }

    if (r[idx.regular]?.trim().toLowerCase() !== 'true') { skippedNotRegular++; continue; }

    const date = new Date(r[idx.date]);
    if (isNaN(date.getTime())) continue;

    const homeScore = parseInt(r[idx.score_home], 10);
    const awayScore = parseInt(r[idx.score_away], 10);
    if (isNaN(homeScore) || isNaN(awayScore) || homeScore === awayScore) { skippedNoScore++; continue; }

    const mlHomeRaw = r[idx.moneyline_home]?.trim();
    const mlAwayRaw = r[idx.moneyline_away]?.trim();
    if (!mlHomeRaw || !mlAwayRaw) { skippedNoOdds++; continue; } // ESPN-gap period, or missing

    const mlHome = parseFloat(mlHomeRaw);
    const mlAway = parseFloat(mlAwayRaw);
    if (isNaN(mlHome) || isNaN(mlAway)) { skippedNoOdds++; continue; }

    games.push({
      date,
      season,
      home: r[idx.home].trim(),
      away: r[idx.away].trim(),
      homeScore,
      awayScore,
      moneylineHomeDecimal: americanToDecimal(mlHome),
      moneylineAwayDecimal: americanToDecimal(mlAway),
    });
  }

  games.sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`Loaded ${games.length} games with real odds for seasons ${seasons.join(', ')}`);
  console.log(`  (skipped ${skippedOutOfRange} out-of-season, ${skippedNotRegular} non-regular, ${skippedNoScore} missing/tied scores, ${skippedNoOdds} missing odds)`);

  return games;
}

// ─── TEAM HISTORY (same walk-forward pattern as nbaIsotonicFit.ts) ─────

function buildTeamHistoryMap(games: OddsGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(team: string, rec: TeamGameRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }
  for (const g of games) {
    push(g.home, { date: g.date, opponent: g.away, result: g.homeScore > g.awayScore ? 'W' : 'L', isHome: true, pointsFor: g.homeScore, pointsAgainst: g.awayScore });
    push(g.away, { date: g.date, opponent: g.home, result: g.awayScore > g.homeScore ? 'W' : 'L', isHome: false, pointsFor: g.awayScore, pointsAgainst: g.homeScore });
  }
  return map;
}

function toFormRecords(recent: TeamGameRecord[]): FormRecord[] {
  return recent.map(r => ({
    date: r.date.toISOString(),
    opponent: r.opponent,
    result: r.result,
    goalsFor: r.pointsFor,
    goalsAgainst: r.pointsAgainst,
    venue: r.isHome ? 'home' : 'away',
  }));
}

function toH2HRecords(home: string, away: string, priorGames: OddsGame[]): H2HRecord[] {
  return priorGames
    .filter(g => (g.home === home && g.away === away) || (g.home === away && g.away === home))
    .map(g => {
      const flip = g.home !== home;
      const normHomeScore = flip ? g.awayScore : g.homeScore;
      const normAwayScore = flip ? g.homeScore : g.awayScore;
      const winner: 'home' | 'away' | 'draw' = normHomeScore > normAwayScore ? 'home' : normAwayScore > normHomeScore ? 'away' : 'draw';
      return { date: g.date.toISOString(), homeTeam: home, awayTeam: away, homeScore: normHomeScore, awayScore: normAwayScore, winner };
    });
}

function daysSinceLastGame(history: TeamGameRecord[], asOf: Date): number | undefined {
  if (!history.length) return undefined;
  return Math.floor((asOf.getTime() - history[history.length - 1].date.getTime()) / (1000 * 60 * 60 * 24));
}

// ─── SINGLE-BET BACKTEST (bets everything — no odds filter) ────────────

function runBacktest(allGames: OddsGame[]): BacktestResult[] {
  const results: BacktestResult[] = [];

  for (const game of allGames) {
    const priorGames = allGames.filter(g => g.date.getTime() < game.date.getTime());
    const historyMap = buildTeamHistoryMap(priorGames);

    const homeHistory = historyMap.get(game.home) ?? [];
    const awayHistory = historyMap.get(game.away) ?? [];
    if (homeHistory.length < MIN_PRIOR_GAMES || awayHistory.length < MIN_PRIOR_GAMES) continue;

    const homeRecent = homeHistory.slice(-FORM_WINDOW);
    const awayRecent = awayHistory.slice(-FORM_WINDOW);

    const homeRest = daysSinceLastGame(homeHistory, game.date);
    const awayRest = daysSinceLastGame(awayHistory, game.date);
    const fatigueDays = homeRest !== undefined && awayRest !== undefined ? Math.min(homeRest, awayRest) : undefined;
    const homeFatigue = homeRest !== undefined && awayRest !== undefined ? homeRest < awayRest : undefined;

    const h2hRecords = toH2HRecords(game.home, game.away, priorGames);
    const matchId = `nba-odds-${game.home}-${game.away}-${game.date.toISOString()}`;

    const stats: Stats = {
      id: `stats-${matchId}`,
      matchId,
      sport: 'basketball',
      h2h: h2hRecords,
      homeForm: toFormRecords(homeRecent),
      awayForm: toFormRecords(awayRecent),
      referee: {},
      situational: { fatigueDays },
      additionalContext: { homeFatigue, league: 'nba' },
      confidenceFactors: { dataCompleteness: 1, h2hSampleSize: h2hRecords.length, formSampleSize: Math.min(homeRecent.length, awayRecent.length) },
    };

    const input: ModelInput = {
      match: { id: matchId, sport: 'basketball', homeTeam: game.home, awayTeam: game.away, startTime: game.date.toISOString(), league: 'nba' },
      stats,
      odds: [],
    };

    const probs = getProbabilities(input);
    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const favoredSide: 'home' | 'away' = homeProb >= 0.5 ? 'home' : 'away';
    const confidence = Math.max(homeProb, 1 - homeProb);

    if (confidence < CONFIDENCE_FLOOR) continue; // doesn't qualify as a tip at all

    const actualWinner: 'home' | 'away' = game.homeScore > game.awayScore ? 'home' : 'away';
    const won = favoredSide === actualWinner;

    const oddsUsed = favoredSide === 'home' ? game.moneylineHomeDecimal! : game.moneylineAwayDecimal!;
    const minRequired = minAcceptableOdds(confidence);
    const clearedOddsFloor = oddsUsed >= minRequired;

    const profit = won ? STAKE * (oddsUsed - 1) : -STAKE;

    results.push({
      matchId, date: game.date.toISOString(), favoredSide, confidence,
      oddsUsed, minRequiredOdds: minRequired, clearedOddsFloor,
      won, staked: STAKE, profit,
    });
  }

  return results;
}

// ─── SHORT-ODDS 2-LEG PARLAY BACKTEST ───────────────────────────────────
// Pairs tips where clearedOddsFloor === false (short odds — market AGREED
// with the model, per the adverse-selection check that showed 81.7% real
// hit rate on this group) into same-day 2-leg parlays, using REAL
// combined odds (leg1 x leg2) and REAL combined outcomes (both legs
// actually hit) — not squared/assumed combined probability.

function runShortOddsParlayBacktest(allGames: OddsGame[]): ParlayResult[] {
  const singleTips = runBacktest(allGames).filter(r => !r.clearedOddsFloor);

  const byDate = new Map<string, BacktestResult[]>();
  for (const tip of singleTips) {
    const day = tip.date.slice(0, 10); // YYYY-MM-DD
    if (!byDate.has(day)) byDate.set(day, []);
    byDate.get(day)!.push(tip);
  }

  const parlays: ParlayResult[] = [];
  for (const [day, tips] of byDate) {
    for (let i = 0; i + 1 < tips.length; i += 2) {
      const leg1 = tips[i];
      const leg2 = tips[i + 1];
      const combinedOdds = leg1.oddsUsed * leg2.oddsUsed;
      const bothWon = leg1.won && leg2.won;
      const profit = bothWon ? STAKE * (combinedOdds - 1) : -STAKE;

      parlays.push({
        date: day,
        leg1Odds: leg1.oddsUsed,
        leg2Odds: leg2.oddsUsed,
        combinedOdds,
        leg1Won: leg1.won,
        leg2Won: leg2.won,
        bothWon,
        staked: STAKE,
        profit,
      });
    }
  }

  return parlays;
}

// ─── REPORTING ──────────────────────────────────────────────────────────

function printReport(results: BacktestResult[]) {
  const actuallyBet = results; // bet everything, no odds filter
  const rejectedOnPrice = results.filter(r => !r.clearedOddsFloor);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  NBA MONEYLINE — REAL ODDS BACKTEST RESULTS (SINGLES, BET ALL)`);
  console.log('='.repeat(60));
  console.log(`\nQualifying tips (confidence >= ${CONFIDENCE_FLOOR}): ${results.length}`);
  console.log(`  Short-odds (market agreed): ${rejectedOnPrice.length}`);
  console.log(`  Long-odds (market disagreed): ${actuallyBet.length - rejectedOnPrice.length}`);

  const rejectedHitRate = rejectedOnPrice.length
    ? (rejectedOnPrice.filter(r => r.won).length / rejectedOnPrice.length) * 100
    : 0;
  const acceptedGroup = results.filter(r => r.clearedOddsFloor);
  const acceptedHitRate = acceptedGroup.length
    ? (acceptedGroup.filter(r => r.won).length / acceptedGroup.length) * 100
    : 0;

  console.log(`\n── Adverse selection check ──`);
  console.log(`Short-odds group: actual hit rate ${rejectedHitRate.toFixed(1)}%`);
  console.log(`Long-odds group: actual hit rate ${acceptedHitRate.toFixed(1)}%`);
  console.log(`──────────────────────────────\n`);

  const wins = actuallyBet.filter(r => r.won).length;
  const losses = actuallyBet.length - wins;
  const totalStaked = actuallyBet.reduce((s, r) => s + r.staked, 0);
  const totalProfit = actuallyBet.reduce((s, r) => s + r.profit, 0);
  const roi = (totalProfit / totalStaked) * 100;
  const hitRate = (wins / actuallyBet.length) * 100;

  console.log(`Hit rate (betting everything): ${hitRate.toFixed(1)}% (${wins}W / ${losses}L)`);
  console.log(`Total staked: ₦${totalStaked.toLocaleString()}`);
  console.log(`Total profit/loss: ₦${totalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`REAL ROI: ${roi.toFixed(2)}%`);
  console.log('='.repeat(60) + '\n');
}

function printParlayReport(parlays: ParlayResult[]) {
  if (!parlays.length) {
    console.log('\nNo short-odds parlays could be formed (need 2+ short-odds tips on the same day).\n');
    return;
  }

  const wins = parlays.filter(p => p.bothWon).length;
  const totalStaked = parlays.length * STAKE;
  const totalProfit = parlays.reduce((s, p) => s + p.profit, 0);
  const roi = (totalProfit / totalStaked) * 100;
  const avgCombinedOdds = parlays.reduce((s, p) => s + p.combinedOdds, 0) / parlays.length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  SHORT-ODDS 2-LEG PARLAY BACKTEST`);
  console.log('='.repeat(60));
  console.log(`Parlays formed: ${parlays.length}`);
  console.log(`Wins (both legs hit): ${wins} (${((wins / parlays.length) * 100).toFixed(1)}%)`);
  console.log(`Avg combined odds: ${avgCombinedOdds.toFixed(2)}`);
  console.log(`Total staked: ₦${totalStaked.toLocaleString()}`);
  console.log(`Total profit/loss: ₦${totalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`REAL ROI: ${roi.toFixed(2)}%`);
  console.log('='.repeat(60) + '\n');
}

// ─── ENTRY POINT ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Running real-odds NBA backtest for seasons ${SEASONS.join(', ')}...\n`);
  const games = loadOddsGames(SEASONS);

  const uniqueTeams = new Set(games.flatMap(g => [g.home, g.away]));
  console.log(`Unique team name strings found: ${uniqueTeams.size}`);
  console.log([...uniqueTeams].sort().join(', '));

  const singleResults = runBacktest(games);
  printReport(singleResults);

  const parlays = runShortOddsParlayBacktest(games);
  printParlayReport(parlays);
}

main().catch(err => {
  console.error('[NbaOddsBacktest] Fatal error:', err.message);
  process.exit(1);
});