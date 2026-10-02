// src/core/engine/nbaIsotonicFit.ts
//
// Fits isotonic regression to correct NBA model overconfidence,
// using pooled historical NBA data from a local Kaggle CSV export
// (eoinamoore/historical-nba-data-and-player-box-scores, Games.csv),
// reusing the exact pipeline architecture from basketballIsotonicFit.ts.
//
// IMPORTANT: run this only while probabilityModel.ts's NBA branch of
// applyBasketballIsotonicCalibration is a raw passthrough (`if (isNba)
// return rawProb;`). If a real NBA_ISOTONIC_BLOCKS table is live when this
// runs, this script will be calibrating an already-calibrated number,
// producing a corrupted, self-referential fit.
//
// Data source: Games.csv is read directly from disk (no network calls,
// no rate limiting, no scraping). The CSV contains games across many
// seasons/years, so we filter down to POOL_YEARS ourselves using NBA
// season-year convention (a season spanning Oct 2024 - June 2025 is
// "season year" 2025).
//
// Run with: npx ts-node src/core/engine/nbaIsotonicFit.ts
// By default it looks for Games.csv in the current working directory.
// Override with: NBA_GAMES_CSV=path/to/Games.csv npx ts-node ...

import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const POOL_YEARS = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const FORM_WINDOW = 10;
const MIN_PRIOR_GAMES = 5;
const MIN_RELIABLE_WEIGHT = 30;

const GAMES_CSV_PATH = process.env.NBA_GAMES_CSV ?? path.join(process.cwd(), 'Games.csv');

// gameType values we don't want polluting the fit — anything not in this
// exclusion list (Regular Season, Playoffs, Play-In, etc.) is kept.
const EXCLUDED_GAME_TYPES = new Set(['preseason', 'all star', 'all-star']);

interface HistGame {
  date: Date;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName: string;
  awayTeamName: string;
  homeScore: number;
  awayScore: number;
  gameType: string;
}

interface TeamGameRecord {
  date: Date;
  opponent: string;
  result: 'W' | 'L';
  isHome: boolean;
  pointsFor: number;
  pointsAgainst: number;
}

interface RawPrediction {
  rawProb: number;
  hit: number;
}

// Quote-aware CSV parser — handles commas and newlines embedded inside
// quoted fields (e.g. the `officials` column: "James Capers, Scott Foster, ...").
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\r') {
        // skip, \n handles the line break
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += c;
      }
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// NBA season-year convention: a season starting in October of year Y and
// ending in June of year Y+1 is labeled by its *ending* year, Y+1.
function getSeasonYear(date: Date): number {
  const month = date.getMonth(); // 0-indexed; August = 7
  return month >= 7 ? date.getFullYear() + 1 : date.getFullYear();
}

function loadGamesFromCsv(poolYears: number[]): HistGame[] {
  if (!fs.existsSync(GAMES_CSV_PATH)) {
    throw new Error(
      `Games.csv not found at ${GAMES_CSV_PATH}. Set NBA_GAMES_CSV env var to the correct path, or run from the directory containing Games.csv.`
    );
  }

  const raw = fs.readFileSync(GAMES_CSV_PATH, 'utf-8');
  const rows = parseCsv(raw);
  if (rows.length < 2) {
    throw new Error('Games.csv appears empty or unparseable.');
  }

  const header = rows[0];
  const col = (name: string) => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`Expected column "${name}" not found in Games.csv header: ${header.join(', ')}`);
    return idx;
  };

  const idx = {
    gameDateTimeEst: col('gameDateTimeEst'),
    hometeamCity: col('hometeamCity'),
    hometeamName: col('hometeamName'),
    hometeamId: col('hometeamId'),
    awayteamCity: col('awayteamCity'),
    awayteamName: col('awayteamName'),
    awayteamId: col('awayteamId'),
    homeScore: col('homeScore'),
    awayScore: col('awayScore'),
    gameType: col('gameType'),
  };

  const poolYearSet = new Set(poolYears);
  const games: HistGame[] = [];
  let skippedNoScore = 0;
  let skippedExcludedType = 0;
  let skippedOutOfRange = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length || !r[idx.gameDateTimeEst]) continue; // blank trailing line etc.

    const gameType = r[idx.gameType].trim();
    if (EXCLUDED_GAME_TYPES.has(gameType.toLowerCase())) {
      skippedExcludedType++;
      continue;
    }

    const date = new Date(r[idx.gameDateTimeEst]);
    if (isNaN(date.getTime())) continue;

    const seasonYear = getSeasonYear(date);
    if (!poolYearSet.has(seasonYear)) {
      skippedOutOfRange++;
      continue;
    }

    const homeScore = parseInt(r[idx.homeScore], 10);
    const awayScore = parseInt(r[idx.awayScore], 10);
    if (isNaN(homeScore) || isNaN(awayScore) || homeScore === awayScore) {
      // Missing scores (future/postponed game) or an impossible tie — skip.
      skippedNoScore++;
      continue;
    }

    games.push({
      date,
      homeTeamId: r[idx.hometeamId],
      awayTeamId: r[idx.awayteamId],
      homeTeamName: `${r[idx.hometeamCity]} ${r[idx.hometeamName]}`.trim(),
      awayTeamName: `${r[idx.awayteamCity]} ${r[idx.awayteamName]}`.trim(),
      homeScore,
      awayScore,
      gameType,
    });
  }

  games.sort((a, b) => a.date.getTime() - b.date.getTime());

  console.log(`Loaded ${games.length} games for season years ${poolYears.join(', ')} from ${GAMES_CSV_PATH}`);
  console.log(
    `  (skipped ${skippedOutOfRange} out-of-range, ${skippedExcludedType} excluded game types, ${skippedNoScore} missing/tied scores)`
  );

  return games;
}

function buildTeamHistoryMap(games: HistGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(teamId: string, rec: TeamGameRecord) {
    if (!map.has(teamId)) map.set(teamId, []);
    map.get(teamId)!.push(rec);
  }
  for (const g of games) {
    push(g.homeTeamId, {
      date: g.date,
      opponent: g.awayTeamName,
      result: g.homeScore > g.awayScore ? 'W' : 'L',
      isHome: true,
      pointsFor: g.homeScore,
      pointsAgainst: g.awayScore,
    });
    push(g.awayTeamId, {
      date: g.date,
      opponent: g.homeTeamName,
      result: g.awayScore > g.homeScore ? 'W' : 'L',
      isHome: false,
      pointsFor: g.awayScore,
      pointsAgainst: g.homeScore,
    });
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

function toH2HRecords(homeTeamId: string, awayTeamId: string, homeTeamName: string, awayTeamName: string, priorGames: HistGame[]): H2HRecord[] {
  return priorGames
    .filter(g => (g.homeTeamId === homeTeamId && g.awayTeamId === awayTeamId) || (g.homeTeamId === awayTeamId && g.awayTeamId === homeTeamId))
    .map(g => {
      const flip = g.homeTeamId !== homeTeamId;
      const normHomeScore = flip ? g.awayScore : g.homeScore;
      const normAwayScore = flip ? g.homeScore : g.awayScore;
      const winner: 'home' | 'away' | 'draw' =
        normHomeScore > normAwayScore ? 'home' : normAwayScore > normHomeScore ? 'away' : 'draw';
      return {
        date: g.date.toISOString(),
        homeTeam: homeTeamName,
        awayTeam: awayTeamName,
        homeScore: normHomeScore,
        awayScore: normAwayScore,
        winner,
      };
    });
}

function daysSinceLastGame(history: TeamGameRecord[], asOf: Date): number | undefined {
  if (!history.length) return undefined;
  const last = history[history.length - 1];
  return Math.floor((asOf.getTime() - last.date.getTime()) / (1000 * 60 * 60 * 24));
}

function generateRawPredictions(allGames: HistGame[], testYears: number[]): RawPrediction[] {
  const predictions: RawPrediction[] = [];
  const testGames = allGames.filter(g => testYears.includes(getSeasonYear(g.date)));

  for (const game of testGames) {
    const priorGames = allGames.filter(g => g.date.getTime() < game.date.getTime());
    const historyMap = buildTeamHistoryMap(priorGames);

    const homeHistory = historyMap.get(game.homeTeamId) ?? [];
    const awayHistory = historyMap.get(game.awayTeamId) ?? [];
    if (homeHistory.length < MIN_PRIOR_GAMES || awayHistory.length < MIN_PRIOR_GAMES) continue;

    // CHANGED (see conversation): no longer truncates to FORM_WINDOW —
    // modelBasketball's basketballDecayWinRate now applies exponential
    // decay internally, same as the live scraper's buildForm (also
    // untruncated now). Passing the full history here matches what the
    // live path actually feeds the model; truncating here while the
    // model expects full-season data would silently mismatch the fit
    // against live behavior, the same class of bug the corners
    // self-referential calibration issue was (just live-vs-fit drift
    // instead of a literal self-reference).
    const homeRecent = homeHistory;
    const awayRecent = awayHistory;

    const homeRest = daysSinceLastGame(homeHistory, game.date);
    const awayRest = daysSinceLastGame(awayHistory, game.date);
    const fatigueDays = homeRest !== undefined && awayRest !== undefined ? Math.min(homeRest, awayRest) : undefined;
    const homeFatigue = homeRest !== undefined && awayRest !== undefined ? homeRest < awayRest : undefined;

    const h2hRecords = toH2HRecords(game.homeTeamId, game.awayTeamId, game.homeTeamName, game.awayTeamName, priorGames);
    const matchId = `nba-${game.homeTeamId}-${game.awayTeamId}-${game.date.toISOString()}`;

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
      confidenceFactors: {
        dataCompleteness: 1,
        h2hSampleSize: h2hRecords.length,
        formSampleSize: Math.min(homeRecent.length, awayRecent.length),
      },
    };

    const input: ModelInput = {
      match: {
        id: matchId,
        sport: 'basketball',
        homeTeam: game.homeTeamName,
        awayTeam: game.awayTeamName,
        startTime: game.date.toISOString(),
        league: 'nba',
      },
      stats,
      odds: [],
    };

    const probs = getProbabilities(input);
    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const rawProb = Math.max(homeProb, 1 - homeProb);
    const predictedHome = homeProb >= 0.5;
    const actualHome = game.homeScore > game.awayScore;
    const hit = predictedHome === actualHome ? 1 : 0;

    predictions.push({ rawProb, hit });
  }

  return predictions;
}

interface IsotonicPoint {
  x: number;
  y: number;
  weight: number;
}

function fitIsotonicRegression(predictions: RawPrediction[]): IsotonicPoint[] {
  const sorted = [...predictions].sort((a, b) => a.rawProb - b.rawProb);
  let blocks: IsotonicPoint[] = sorted.map(p => ({ x: p.rawProb, y: p.hit, weight: 1 }));

  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < blocks.length - 1; i++) {
      if (blocks[i].y > blocks[i + 1].y) {
        const totalWeight = blocks[i].weight + blocks[i + 1].weight;
        const mergedY = (blocks[i].y * blocks[i].weight + blocks[i + 1].y * blocks[i + 1].weight) / totalWeight;
        const mergedX = (blocks[i].x * blocks[i].weight + blocks[i + 1].x * blocks[i + 1].weight) / totalWeight;
        blocks.splice(i, 2, { x: mergedX, y: mergedY, weight: totalWeight });
        merged = true;
        break;
      }
    }
  }

  return blocks;
}

function findReliableCutoff(blocks: IsotonicPoint[]): number {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return blocks.length - 1;
}

function findReliableStart(blocks: IsotonicPoint[]): number {
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  }
  return 0;
}

function isotonicPredict(blocks: IsotonicPoint[], rawProb: number, startIdx: number, cutoffIdx: number): number {
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);

  if (rawProb <= reliableBlocks[0].x) return reliableBlocks[0].y;
  if (rawProb >= reliableBlocks[reliableBlocks.length - 1].x) {
    return reliableBlocks[reliableBlocks.length - 1].y;
  }

  for (let i = 0; i < reliableBlocks.length - 1; i++) {
    if (rawProb >= reliableBlocks[i].x && rawProb <= reliableBlocks[i + 1].x) {
      const t = (rawProb - reliableBlocks[i].x) / (reliableBlocks[i + 1].x - reliableBlocks[i].x || 1);
      return reliableBlocks[i].y + t * (reliableBlocks[i + 1].y - reliableBlocks[i].y);
    }
  }
  return rawProb;
}

function evaluateCalibration(predictions: RawPrediction[], blocks: IsotonicPoint[], startIdx: number, cutoffIdx: number) {
  console.log('\nBand       | Raw Avg | Calibrated Avg | Actual Hit Rate | Games');
  console.log('------------------------------------------------------------------');
  const bandDefs = [
    { label: '50-65%', min: 0.50, max: 0.65 },
    { label: '65-70%', min: 0.65, max: 0.70 },
    { label: '70-75%', min: 0.70, max: 0.75 },
    { label: '75-80%', min: 0.75, max: 0.80 },
    { label: '80%+',   min: 0.80, max: 1.01 },
  ];
  for (const band of bandDefs) {
    const items = predictions.filter(p => p.rawProb >= band.min && p.rawProb < band.max);
    if (!items.length) continue;
    const rawAvg = items.reduce((s, p) => s + p.rawProb, 0) / items.length;
    const calAvg = items.reduce((s, p) => s + isotonicPredict(blocks, p.rawProb, startIdx, cutoffIdx), 0) / items.length;
    const hitRate = items.reduce((s, p) => s + p.hit, 0) / items.length;
    console.log(`${band.label.padEnd(10)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(calAvg * 100).toFixed(1).padStart(14)}% | ${(hitRate * 100).toFixed(1).padStart(15)}% | ${items.length}`);
  }
}

async function main() {
  console.log(`Fitting isotonic regression for NBA model (pooled ${POOL_YEARS.join(', ')})...\n`);

  const allGames = loadGamesFromCsv(POOL_YEARS);

  if (allGames.length < 1000) {
    console.log(`WARNING: expected ~1,230 games per NBA season (~${POOL_YEARS.length * 1230} total) — got ${allGames.length}. Check Games.csv content and the season-year filter before trusting this fit.`);
  }

  console.log(`\nGenerating raw predictions across pooled years ${POOL_YEARS.join(', ')}...`);
  const predictions = generateRawPredictions(allGames, POOL_YEARS);
  console.log(`Total predictions for fitting: ${predictions.length}`);

  if (predictions.length === 0) {
    console.log('No predictions generated — aborting fit. Check MIN_PRIOR_GAMES and the CSV filter above and rerun.');
    return;
  }

  const blocks = fitIsotonicRegression(predictions);
  const startIdx = findReliableStart(blocks);
  const cutoffIdx = findReliableCutoff(blocks);
  console.log(`\nFitted isotonic regression: ${blocks.length} monotonic blocks`);
  console.log(`Reliable range: blocks ${startIdx}-${cutoffIdx} (low: x=${blocks[startIdx].x.toFixed(4)}, y=${blocks[startIdx].y.toFixed(4)}, weight=${blocks[startIdx].weight} | high: x=${blocks[cutoffIdx].x.toFixed(4)}, y=${blocks[cutoffIdx].y.toFixed(4)}, weight=${blocks[cutoffIdx].weight}) — ${startIdx} low-end + ${blocks.length - 1 - cutoffIdx} high-end noisy blocks excluded`);

  console.log('\n=== BEFORE/AFTER CALIBRATION CHECK ===');
  evaluateCalibration(predictions, blocks, startIdx, cutoffIdx);

  console.log('\n=== Calibration lookup table (for probabilityModel.ts) ===');
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);
  const step = Math.max(1, Math.floor(reliableBlocks.length / 30));
  for (let i = 0; i < reliableBlocks.length; i += step) {
    console.log(`  { x: ${reliableBlocks[i].x.toFixed(4)}, y: ${reliableBlocks[i].y.toFixed(4)} }, // weight: ${reliableBlocks[i].weight}`);
  }
}

main().catch(err => {
  console.error('[NbaIsotonicFit] Fatal error:', err.message);
  process.exit(1);
});