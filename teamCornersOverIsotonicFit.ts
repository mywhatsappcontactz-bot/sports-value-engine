// scripts/teamCornersOverIsotonicFit.ts
//
// Fits SEPARATE isotonic regressions for team_corners_over predictions,
// split by BOTH side (Home/Away) AND line (3.5/4.5/5.5) — six curves
// total, not two. See original header rationale in git history / prior
// session — pooling all three lines into one curve per side hid a real
// spread in hit rate (Home 3.5 vs Home 5.5) behind near-identical raw
// confidence; splitting by line as well fixes this.
//
// UPDATED (this pass): computeExpectedCornersRolling now applies the
// same shrinkage cornersAggregator.ts's applyShrinkage does (see
// SHRINKAGE_PRIOR_GAMES/shrinkTowardLeagueAvg below) — this script
// hand-duplicates cornersAggregator.ts's formula and had drifted out of
// sync after shrinkage was added there, same class of bug as the other
// two corners fit scripts (cornersTotalsIsotonicFit.ts,
// cornersWinnerIsotonicFit.ts) had before their own fix.
//
// ALSO FIXED (this pass): this script reads row.trueProbability off
// getProbabilities()'s team_corners_over output as "rawProb" — but
// modelFootballTeamCornersOver returns the CALIBRATED probability in
// trueProbability, not the raw NB probability. Run this ONLY while
// applyTeamCornersOverIsotonicCalibration in probabilityModel.ts is a
// temporary passthrough (return rawProb;) — same self-reference risk
// nbaIsotonicFit.ts's header warns about for NBA moneyline. If a real
// calibration table is live when this runs, this script silently
// calibrates an already-calibrated number.
//
// Run with: npx ts-node scripts/teamCornersOverIsotonicFit.ts
// Override seasons: CORNERS_BACKTEST_SEASONS=1617,1718,... npx ts-node ...

import { getProbabilities, ModelInput } from '../src/core/engine/probabilityModel';
import { Stats } from '../src/core/database/schema';

const FOOTBALL_DATA_LEAGUE_MAP: Record<string, string> = {
  'EPL': 'E0',
  'Championship': 'E1',
  'League 1': 'E2',
  'League 2': 'E3',
  'La Liga - Spain': 'SP1',
  'La Liga 2 - Spain': 'SP2',
  'Bundesliga - Germany': 'D1',
  '2. Bundesliga - Germany': 'D2',
  'Serie A - Italy': 'I1',
  'Turkey': 'T1',
  'Netherlands - Eredivisie': 'N1',
  'Scotland - Premiership': 'SC0',
  'Belgium': 'B1',
};

const DEFAULT_SEASONS = ['1617', '1718', '1819', '1920', '2021', '2122', '2223', '2324', '2425'];
const SEASONS = (process.env.CORNERS_BACKTEST_SEASONS ?? DEFAULT_SEASONS.join(','))
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MIN_RELIABLE_WEIGHT = 30;
const MIN_VENUE_MATCHES = 4;
const MIN_LEAGUE_MATCHES_FOR_AVERAGES = 20;
const LINES = [3.5, 4.5, 5.5] as const;

// Same shrinkage constant as cornersAggregator.ts's SHRINKAGE_PRIOR_GAMES
// — MUST be kept in sync if that file's value ever changes.
const SHRINKAGE_PRIOR_GAMES = 4;

interface HistMatch {
  date: Date;
  homeTeam: string;
  awayTeam: string;
  hc: number;
  ac: number;
}

interface RawPrediction {
  side: 'home' | 'away';
  line: number;
  rawProb: number;
  hit: number;
}

function parseCsv(text: string): string[][] {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  return lines.map(line => line.split(','));
}

async function fetchSeasonCsv(leagueCode: string, season: string): Promise<HistMatch[]> {
  const url = `https://www.football-data.co.uk/mmz4281/${season}/${leagueCode}.csv`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err: any) {
    console.warn(`  Failed to fetch ${url}: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    console.warn(`  HTTP ${res.status} for ${url} — skipping`);
    return [];
  }

  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) return [];

  const header = rows[0].map(h => h.trim());
  const dateIdx = header.indexOf('Date');
  const homeIdx = header.indexOf('HomeTeam');
  const awayIdx = header.indexOf('AwayTeam');
  const hcIdx = header.indexOf('HC');
  const acIdx = header.indexOf('AC');

  if (dateIdx === -1 || homeIdx === -1 || awayIdx === -1 || hcIdx === -1 || acIdx === -1) {
    console.warn(`  ${leagueCode}/${season}: missing expected columns — skipping`);
    return [];
  }

  const matches: HistMatch[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length <= Math.max(dateIdx, homeIdx, awayIdx, hcIdx, acIdx)) continue;

    const dateStr = r[dateIdx]?.trim();
    if (!dateStr) continue;

    const parts = dateStr.split('/');
    if (parts.length !== 3) continue;
    let [dd, mm, yy] = parts;
    if (yy.length === 2) yy = (parseInt(yy, 10) < 50 ? '20' : '19') + yy;
    const date = new Date(`${yy}-${mm}-${dd}`);
    if (isNaN(date.getTime())) continue;

    const hc = parseInt(r[hcIdx], 10);
    const ac = parseInt(r[acIdx], 10);
    if (isNaN(hc) || isNaN(ac)) continue;

    const homeTeam = r[homeIdx]?.trim();
    const awayTeam = r[awayIdx]?.trim();
    if (!homeTeam || !awayTeam) continue;

    matches.push({ date, homeTeam, awayTeam, hc, ac });
  }

  matches.sort((a, b) => a.date.getTime() - b.date.getTime());
  return matches;
}

interface TeamVenueStats {
  homeFor: number[];
  homeAgainst: number[];
  awayFor: number[];
  awayAgainst: number[];
}

function emptyVenueStats(): TeamVenueStats {
  return { homeFor: [], homeAgainst: [], awayFor: [], awayAgainst: [] };
}

function avg(arr: number[]): number {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

// Same shrinkage formula as cornersAggregator.ts's shrinkTowardLeagueAvg.
function shrinkTowardLeagueAvg(observed: number, gamesPlayed: number, leagueAvg: number): number {
  if (gamesPlayed <= 0) return leagueAvg;
  const weight = gamesPlayed / (gamesPlayed + SHRINKAGE_PRIOR_GAMES);
  return weight * observed + (1 - weight) * leagueAvg;
}

// UPDATED: now applies shrinkage before computing attack/defense
// strength ratios — see file header comment.
function computeExpectedCornersRolling(
  homeStats: TeamVenueStats,
  awayStats: TeamVenueStats,
  leagueAvg: { avgHomeCornersWon: number; avgHomeCornersConceded: number; avgAwayCornersWon: number; avgAwayCornersConceded: number }
): { homeCornersAvg: number; awayCornersAvg: number } {
  const homeForShrunk = shrinkTowardLeagueAvg(avg(homeStats.homeFor), homeStats.homeFor.length, leagueAvg.avgHomeCornersWon);
  const homeAgainstShrunk = shrinkTowardLeagueAvg(avg(homeStats.homeAgainst), homeStats.homeAgainst.length, leagueAvg.avgHomeCornersConceded);
  const awayForShrunk = shrinkTowardLeagueAvg(avg(awayStats.awayFor), awayStats.awayFor.length, leagueAvg.avgAwayCornersWon);
  const awayAgainstShrunk = shrinkTowardLeagueAvg(avg(awayStats.awayAgainst), awayStats.awayAgainst.length, leagueAvg.avgAwayCornersConceded);

  const homeAttackStrength = leagueAvg.avgHomeCornersWon > 0
    ? homeForShrunk / leagueAvg.avgHomeCornersWon : 1;
  const awayDefenseWeakness = leagueAvg.avgAwayCornersConceded > 0
    ? awayAgainstShrunk / leagueAvg.avgAwayCornersConceded : 1;

  const awayAttackStrength = leagueAvg.avgAwayCornersWon > 0
    ? awayForShrunk / leagueAvg.avgAwayCornersWon : 1;
  const homeDefenseWeakness = leagueAvg.avgHomeCornersConceded > 0
    ? homeAgainstShrunk / leagueAvg.avgHomeCornersConceded : 1;

  const homeCornersAvg = leagueAvg.avgHomeCornersWon * homeAttackStrength * awayDefenseWeakness;
  const awayCornersAvg = leagueAvg.avgAwayCornersWon * awayAttackStrength * homeDefenseWeakness;

  return { homeCornersAvg, awayCornersAvg };
}

async function generatePredictionsForSeason(leagueCode: string, season: string): Promise<RawPrediction[]> {
  const matches = await fetchSeasonCsv(leagueCode, season);
  if (!matches.length) return [];

  const predictions: RawPrediction[] = [];
  const teamStats = new Map<string, TeamVenueStats>();
  let leagueHomeForSum = 0, leagueHomeAgainstSum = 0, leagueAwayForSum = 0, leagueAwayAgainstSum = 0;
  let matchesSoFar = 0;

  function getTeam(name: string): TeamVenueStats {
    if (!teamStats.has(name)) teamStats.set(name, emptyVenueStats());
    return teamStats.get(name)!;
  }

  for (const match of matches) {
    const homeStats = getTeam(match.homeTeam);
    const awayStats = getTeam(match.awayTeam);

    const readyForPrediction =
      homeStats.homeFor.length >= MIN_VENUE_MATCHES &&
      awayStats.awayFor.length >= MIN_VENUE_MATCHES &&
      matchesSoFar >= MIN_LEAGUE_MATCHES_FOR_AVERAGES;

    if (readyForPrediction) {
      const leagueAvg = {
        avgHomeCornersWon: leagueHomeForSum / matchesSoFar,
        avgHomeCornersConceded: leagueHomeAgainstSum / matchesSoFar,
        avgAwayCornersWon: leagueAwayForSum / matchesSoFar,
        avgAwayCornersConceded: leagueAwayAgainstSum / matchesSoFar,
      };

      const expected = computeExpectedCornersRolling(homeStats, awayStats, leagueAvg);

      const stats: Stats = {
        id: `stats-teamcornersfit-${leagueCode}-${season}-${match.date.toISOString()}`,
        matchId: `teamcornersfit-${leagueCode}-${season}-${match.date.toISOString()}`,
        sport: 'football',
        h2h: [],
        homeForm: [],
        awayForm: [],
        referee: {},
        situational: {},
        additionalContext: {},
        confidenceFactors: { dataCompleteness: 1, h2hSampleSize: 0, formSampleSize: 0 },
        homeCornersAvg: expected.homeCornersAvg,
        awayCornersAvg: expected.awayCornersAvg,
      };

      const input: ModelInput = {
        match: {
          id: stats.matchId,
          sport: 'football',
          homeTeam: match.homeTeam,
          awayTeam: match.awayTeam,
          startTime: match.date.toISOString(),
        },
        stats,
        odds: [],
      };

      try {
        const probs = getProbabilities(input);
        const teamCornersRows = probs.filter(p => p.market === 'team_corners_over');

        for (const row of teamCornersRows) {
          const sideMatch = row.selection.match(/^(Home|Away)\s+Over\s+([\d.]+)/);
          if (!sideMatch) continue;
          const side = sideMatch[1].toLowerCase() as 'home' | 'away';
          const line = parseFloat(sideMatch[2]);
          const actual = side === 'home' ? match.hc : match.ac;
          const hit = actual > line ? 1 : 0;
          predictions.push({ side, line, rawProb: row.trueProbability, hit });
        }
      } catch {
        // skip
      }
    }

    homeStats.homeFor.push(match.hc);
    homeStats.homeAgainst.push(match.ac);
    awayStats.awayFor.push(match.ac);
    awayStats.awayAgainst.push(match.hc);

    leagueHomeForSum += match.hc;
    leagueHomeAgainstSum += match.ac;
    leagueAwayForSum += match.ac;
    leagueAwayAgainstSum += match.hc;
    matchesSoFar++;
  }

  return predictions;
}

interface IsotonicPoint { x: number; y: number; weight: number; }

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
  for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  return blocks.length - 1;
}
function findReliableStart(blocks: IsotonicPoint[]): number {
  for (let i = 0; i < blocks.length; i++) if (blocks[i].weight >= MIN_RELIABLE_WEIGHT) return i;
  return 0;
}

function isotonicPredict(blocks: IsotonicPoint[], rawProb: number, startIdx: number, cutoffIdx: number): number {
  const rb = blocks.slice(startIdx, cutoffIdx + 1);
  if (rawProb <= rb[0].x) return rb[0].y;
  if (rawProb >= rb[rb.length - 1].x) return rb[rb.length - 1].y;
  for (let i = 0; i < rb.length - 1; i++) {
    if (rawProb >= rb[i].x && rawProb <= rb[i + 1].x) {
      const t = (rawProb - rb[i].x) / (rb[i + 1].x - rb[i].x || 1);
      return rb[i].y + t * (rb[i + 1].y - rb[i].y);
    }
  }
  return rawProb;
}

function tableKey(side: 'home' | 'away', line: number): string {
  return `${side.toUpperCase()}_${line}`;
}

function reportAndPrintTable(side: 'home' | 'away', line: number, predictions: RawPrediction[]) {
  const label = tableKey(side, line);
  console.log(`\n\n########## ${label} (${predictions.length} predictions) ##########`);

  if (predictions.length === 0) {
    console.log('No predictions — skipping fit.');
    return;
  }
  if (predictions.length < MIN_RELIABLE_WEIGHT) {
    console.log(`WARNING: only ${predictions.length} predictions, below MIN_RELIABLE_WEIGHT=${MIN_RELIABLE_WEIGHT} — fit may be unreliable.`);
  }

  // Sanity check: with the passthrough active, every rawProb here should
  // be >= 0.80 (TEAM_CORNERS_MIN_CONFIDENCE) — bestTeamCornersOverLine
  // only ever returns lines clearing that floor. If this fires, the
  // passthrough is NOT actually active — STOP and check probabilityModel.ts
  // before trusting this table.
  const belowFloor = predictions.filter(p => p.rawProb < 0.80);
  if (belowFloor.length > 0) {
    console.log(`*** WARNING: ${belowFloor.length}/${predictions.length} predictions have rawProb < 0.80 — this means the passthrough in probabilityModel.ts is NOT active, or something else is wrong. DO NOT USE THIS TABLE. ***`);
  }

  const blocks = fitIsotonicRegression(predictions);
  const startIdx = findReliableStart(blocks);
  const cutoffIdx = findReliableCutoff(blocks);
  console.log(`Fitted isotonic regression: ${blocks.length} monotonic blocks`);
  console.log(`Reliable range: blocks ${startIdx}-${cutoffIdx} (low: x=${blocks[startIdx].x.toFixed(4)}, weight=${blocks[startIdx].weight} | high: x=${blocks[cutoffIdx].x.toFixed(4)}, weight=${blocks[cutoffIdx].weight})`);

  const minRaw = Math.min(...predictions.map(p => p.rawProb));
  const maxRaw = Math.max(...predictions.map(p => p.rawProb));
  const bandWidth = 0.02;
  const bandDefs: { label: string; min: number; max: number }[] = [];
  for (let b = Math.floor(minRaw / bandWidth) * bandWidth; b < maxRaw; b += bandWidth) {
    bandDefs.push({ label: `${(b * 100).toFixed(0)}-${((b + bandWidth) * 100).toFixed(0)}%`, min: b, max: b + bandWidth });
  }

  console.log('\nBand       | Raw Avg | Calibrated Avg | Actual Hit Rate | Games');
  console.log('------------------------------------------------------------------');
  for (const band of bandDefs) {
    const items = predictions.filter(p => p.rawProb >= band.min && p.rawProb < band.max);
    if (!items.length) continue;
    const rawAvg = items.reduce((s, p) => s + p.rawProb, 0) / items.length;
    const calAvg = items.reduce((s, p) => s + isotonicPredict(blocks, p.rawProb, startIdx, cutoffIdx), 0) / items.length;
    const hitRate = items.reduce((s, p) => s + p.hit, 0) / items.length;
    console.log(`${band.label.padEnd(10)} | ${(rawAvg * 100).toFixed(1).padStart(6)}% | ${(calAvg * 100).toFixed(1).padStart(14)}% | ${(hitRate * 100).toFixed(1).padStart(15)}% | ${items.length}`);
  }

  console.log(`\n=== ${label} calibration lookup table ===`);
  const reliableBlocks = blocks.slice(startIdx, cutoffIdx + 1);
  const step = Math.max(1, Math.floor(reliableBlocks.length / 30));
  for (let i = 0; i < reliableBlocks.length; i += step) {
    console.log(`  { x: ${reliableBlocks[i].x.toFixed(4)}, y: ${reliableBlocks[i].y.toFixed(4)} }, // weight: ${reliableBlocks[i].weight}`);
  }
}

async function main() {
  console.log(`Fitting team_corners_over isotonic regression (SIX tables: Home/Away x 3.5/4.5/5.5) across ${Object.keys(FOOTBALL_DATA_LEAGUE_MAP).length} leagues, seasons: ${SEASONS.join(', ')}\n`);
  console.log('(This run includes the corners shrinkage fix — see file header. Requires applyTeamCornersOverIsotonicCalibration to be a passthrough in probabilityModel.ts — verify before trusting output.)\n');

  const allPredictions: RawPrediction[] = [];

  for (const [leagueName, leagueCode] of Object.entries(FOOTBALL_DATA_LEAGUE_MAP)) {
    for (const season of SEASONS) {
      console.log(`Fetching ${leagueName} (${leagueCode}) season ${season}...`);
      const preds = await generatePredictionsForSeason(leagueCode, season);
      console.log(`  -> ${preds.length} predictions`);
      allPredictions.push(...preds);
    }
  }

  console.log(`\nTotal predictions pooled: ${allPredictions.length}`);

  for (const side of ['home', 'away'] as const) {
    for (const line of LINES) {
      const subset = allPredictions.filter(p => p.side === side && p.line === line);
      reportAndPrintTable(side, line, subset);
    }
  }
}

main().catch(err => {
  console.error('[TeamCornersOverIsotonicFit] Fatal error:', err.message);
  process.exit(1);
});