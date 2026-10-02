// src/core/engine/sbroNhlPuckLineGoalieBacktest.ts
//
// A/B test: runs the SAME games through the SAME puck-line backtest
// logic twice — once with additionalContext.homeGoalieGSaxPer60 /
// awayGoalieGSaxPer60 populated, once without — so any difference in
// the output is isolated to the goalie adjustment in
// computeHockeyGoalLambdas() and nothing else. Requires the patch in
// probabilityModel_GOALIE_PATCH.md to already be applied.
//
// IMPORTANT SIMPLIFYING ASSUMPTION, READ BEFORE TRUSTING RESULTS:
// this does NOT know which goalie actually started a given game. SBRO
// odds files carry team names, not goalie names. What this script uses
// instead is "this team's most recent known rolling GSAx as of any
// prior date" — a proxy for "how has this team's goaltending been
// performing lately", not "who is between the pipes tonight". NHL
// starters are reasonably sticky game-to-game (the same goalie often
// starts 3-4 games in a row), so this proxy is defensible as a FIRST
// PASS, but it will be wrong on back-to-back nights where a backup
// starts unexpectedly, and it silently blends in whoever was hot/cold
// recently even if they're hurt or traded. If this feature shows
// promise, the next-level improvement is a real starting-goalie feed
// (odds providers/lineup sites publish confirmed starters pregame) —
// don't skip that step before trusting this for anything live.
//
// FIXED (this revision): the goalie CSV's gameDate column is a compact
// "YYYYMMDD" string (e.g. "20161028"), but the SBRO side's isoDate is
// dashed "YYYY-MM-DD". lookupRollingGsax() compared these two formats
// directly as strings — which is not a valid date comparison in either
// format (a raw string compare between "20161028" and "2016-10-28"
// diverges from real chronological order at the first punctuation
// character). This was confirmed via the coverage-by-month output: 0%
// coverage Oct-Dec 2016, then a hard jump to 100% Jan 2017 onward — a
// pattern neither a real "not enough prior starts yet" ramp-up nor a
// data-availability gap would produce (the goalie CSV was independently
// confirmed to contain full Oct-Apr data). normalizeGoalieDate() below
// converts the compact format to dashed ISO the moment it's read, so
// every date used downstream (StarterApp.gameDate, the teamRolling
// timeline, and the beforeIsoDate comparison) is in the same format.
// Re-run the coverage-by-month table after this change — a smooth/
// consistent coverage percentage from October onward (not a hard
// 0%-then-100% cliff) is the sign this actually fixed it, not just
// moved the bug.
//
// USAGE:
//   npx ts-node src/core/engine/sbroNhlPuckLineGoalieBacktest.ts <sbro-file.txt> <goalie-csv> <season-start-year>
//   npx ts-node src/core/engine/sbroNhlPuckLineGoalieBacktest.ts "C:\...\nhl 2016 2017.txt" "C:\...\2016.csv" 2016

import * as fs from 'fs';
import { computeHockeyGoalLambdas, marginDistribution, handicapCoverProbability } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_PRIOR_GAMES = 5;
const CONFIDENCE_FLOORS = [0.55, 0.60, 0.65, 0.70];
const FIXED_STAKE = 10_000;
const ROLLING_GOALIE_WINDOW = 10;
const MIN_PRIOR_GOALIE_STARTS = 3;

// Same 30-team map validated earlier via mergeGoalieGSAx.ts. Add
// expansion teams (Seattle, Vegas, Utah) if you run this on a season
// that includes them and get an "unknown team" warning.
const SBRO_TEAM_TO_CODE: Record<string, string> = {
  Toronto: 'TOR', Ottawa: 'OTT', 'St.Louis': 'STL', Chicago: 'CHI',
  Calgary: 'CGY', Edmonton: 'EDM', LosAngeles: 'LAK', SanJose: 'SJS',
  Boston: 'BOS', Columbus: 'CBJ', Montreal: 'MTL', Buffalo: 'BUF',
  NYIslanders: 'NYI', NYRangers: 'NYR', Detroit: 'DET', TampaBay: 'TBL',
  NewJersey: 'NJD', Florida: 'FLA', Carolina: 'CAR', Winnipeg: 'WPG',
  Washington: 'WSH', Pittsburgh: 'PIT', Minnesota: 'MIN', Anaheim: 'ANA',
  Dallas: 'DAL', Nashville: 'NSH', Philadelphia: 'PHI', Colorado: 'COL',
  Arizona: 'ARI', Vancouver: 'VAN',
  // Seattle: 'SEA', VegasGoldenKnights: 'VGK', Utah: 'UTA',
};

// ─── CLI ────────────────────────────────────────────────────────────────

const [sbroPath, goalieCsvPath, seasonStartYearStr] = process.argv.slice(2);
if (!sbroPath || !goalieCsvPath || !seasonStartYearStr) {
  console.error('Usage: npx ts-node src/core/engine/sbroNhlPuckLineGoalieBacktest.ts <sbro-file.txt> <goalie-csv> <season-start-year>');
  process.exit(1);
}
const seasonStartYear = parseInt(seasonStartYearStr, 10);
if (isNaN(seasonStartYear)) { console.error(`Bad season-start-year: ${seasonStartYearStr}`); process.exit(1); }
for (const p of [sbroPath, goalieCsvPath]) {
  if (!fs.existsSync(p)) { console.error(`File not found: ${p}`); process.exit(1); }
}

// ─── DATE NORMALIZATION (new) ──────────────────────────────────────────

// Converts a compact "YYYYMMDD" string to dashed ISO "YYYY-MM-DD". If the
// input is already dashed (or some other format), it's returned as-is —
// this is defensive, not a silent no-op: if a goalie CSV ever ships dates
// in a different shape, this function is the first place to check.
function normalizeGoalieDate(raw: string): string {
  const s = raw.trim();
  if (/^\d{8}$/.test(s)) {
    return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  }
  return s;
}

// ─── SBRO PARSING (unchanged from sbroNhlPuckLineBacktest.ts) ──────────

interface SbroRow { date: string; vh: 'V' | 'H' | 'N'; team: string; final: number; puckLine: number; puckLineOdds: number; }
function parseSbroRows(text: string): SbroRow[] {
  const lines = text.trim().split(/\r?\n/);
  const rows: SbroRow[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 16) continue;
    if (!/^\d+$/.test(fields[0])) continue;
    const vh = fields[2];
    if (vh !== 'V' && vh !== 'H' && vh !== 'N') continue;
    const n = (s: string) => parseFloat(s);
    const [date, , , team, , , , final, , , puckLine, puckLineOdds] = fields;
    if (isNaN(n(puckLine)) || isNaN(n(puckLineOdds))) continue;
    rows.push({ date, vh: vh as 'V' | 'H' | 'N', team, final: n(final), puckLine: n(puckLine), puckLineOdds: n(puckLineOdds) });
  }
  return rows;
}

interface Game {
  seq: number; dateLabel: string; isoDate: string;
  awayTeam: string; awayCode: string | null; awayScore: number; awayPuckLine: number; awayPuckLineOdds: number;
  homeTeam: string; homeCode: string | null; homeScore: number; homePuckLine: number; homePuckLineOdds: number;
}
function parseMonthDay(dateLabel: string): { month: number; day: number } {
  const s = dateLabel.trim();
  if (s.length === 3) return { month: parseInt(s[0], 10), day: parseInt(s.slice(1), 10) };
  return { month: parseInt(s.slice(0, 2), 10), day: parseInt(s.slice(2), 10) };
}
function inferIsoDate(dateLabel: string, startYear: number): string {
  const { month, day } = parseMonthDay(dateLabel);
  const year = month >= 7 ? startYear : startYear + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function isPreseasonNoise(dateLabel: string): boolean {
  const { month, day } = parseMonthDay(dateLabel);
  if (month === 8) return true;
  if (month === 9 && day < 15) return true;
  return false;
}
function pairRowsIntoGames(rows: SbroRow[], startYear: number): Game[] {
  const games: Game[] = [];
  let seq = 0;
  for (let i = 0; i < rows.length - 1; i += 2) {
    const a = rows[i], b = rows[i + 1];
    if (a.date !== b.date) { i -= 1; continue; }
    games.push({
      seq: seq++, dateLabel: a.date, isoDate: inferIsoDate(a.date, startYear),
      awayTeam: a.team, awayCode: SBRO_TEAM_TO_CODE[a.team] ?? null, awayScore: a.final, awayPuckLine: a.puckLine, awayPuckLineOdds: a.puckLineOdds,
      homeTeam: b.team, homeCode: SBRO_TEAM_TO_CODE[b.team] ?? null, homeScore: b.final, homePuckLine: b.puckLine, homePuckLineOdds: b.puckLineOdds,
    });
  }
  return games;
}
function americanToDecimal(american: number): number {
  if (american > 0) return 1 + american / 100;
  return 1 + 100 / Math.abs(american);
}

// ─── GOALIE DATA (condensed from mergeGoalieGSAx.ts, validated join) ──

const GOALIE_COLUMN_CANDIDATES: Record<string, string[]> = {
  playerId: ['playerId', 'player_id'], name: ['name', 'playerName'],
  team: ['team', 'playerTeam'], situation: ['situation'],
  gameId: ['gameId', 'game_id', 'gameID'], gameDate: ['gameDate', 'game_date', 'date'],
  icetime: ['icetime', 'iceTime'], xGoals: ['xGoals', 'xgoals'], goals: ['goals'],
};
interface GoalieRow { playerId: string; name: string; team: string; gameKey: string; gameDate: string; icetime: number; xGoals: number; goals: number; }
function loadGoalieRows(path: string): GoalieRow[] {
  const text = fs.readFileSync(path, 'utf-8');
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const map: Record<string, number> = {};
  for (const [field, cands] of Object.entries(GOALIE_COLUMN_CANDIDATES)) {
    const idx = header.findIndex(h => cands.includes(h.trim()));
    if (idx !== -1) map[field] = idx;
  }
  const hardRequired = ['playerId', 'name', 'team', 'icetime', 'xGoals', 'goals'];
  const missing = hardRequired.filter(f => map[f] === undefined);
  if (missing.length) {
    console.error(`Goalie CSV missing required column(s): ${missing.join(', ')}`);
    console.error(`Headers found: ${header.join(', ')}`);
    process.exit(1);
  }
  const gameKeyIdx = map.gameId ?? map.gameDate;
  if (gameKeyIdx === undefined) { console.error('No gameId/gameDate column found.'); process.exit(1); }

  const rows: GoalieRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = lines[i].split(',');
    if (f.length < header.length) continue;
    if (map.situation !== undefined && f[map.situation].trim() !== 'all') continue;
    const icetime = parseFloat(f[map.icetime]), xGoals = parseFloat(f[map.xGoals]), goals = parseFloat(f[map.goals]);
    if (isNaN(icetime) || isNaN(xGoals) || isNaN(goals) || icetime <= 0) continue;
    // FIXED: normalize gameDate to dashed ISO here, at the point of
    // reading — every downstream consumer (StarterApp, teamRolling
    // timeline, lookupRollingGsax's comparison) now gets a consistent
    // format matching game.isoDate on the SBRO side.
    const rawGameDate = map.gameDate !== undefined ? f[map.gameDate] : f[gameKeyIdx];
    rows.push({
      playerId: f[map.playerId], name: f[map.name], team: f[map.team].trim(),
      gameKey: f[gameKeyIdx], gameDate: normalizeGoalieDate(rawGameDate),
      icetime, xGoals, goals,
    });
  }
  return rows;
}

interface StarterApp { team: string; gameDate: string; playerId: string; name: string; gsaxPer60: number; }
function identifyStarters(rows: GoalieRow[]): StarterApp[] {
  const byTeamGame = new Map<string, GoalieRow[]>();
  for (const r of rows) {
    const key = `${r.team}__${r.gameKey}`;
    if (!byTeamGame.has(key)) byTeamGame.set(key, []);
    byTeamGame.get(key)!.push(r);
  }
  const starters: StarterApp[] = [];
  for (const group of byTeamGame.values()) {
    const s = group.reduce((a, b) => (b.icetime > a.icetime ? b : a));
    starters.push({ team: s.team, gameDate: s.gameDate, playerId: s.playerId, name: s.name, gsaxPer60: ((s.xGoals - s.goals) / s.icetime) * 3600 });
  }
  return starters.sort((a, b) => a.gameDate.localeCompare(b.gameDate));
}

// Rolling GSAx per (team, date): the most recent value known strictly
// before `beforeDate`, averaged over that goalie's prior N starts.
// Cached per team so repeated lookups across games are cheap.
function buildTeamRollingLookup(starters: StarterApp[]): Map<string, { date: string; rollingGsax: number }[]> {
  const byPlayer = new Map<string, StarterApp[]>();
  for (const s of starters) {
    if (!byPlayer.has(s.playerId)) byPlayer.set(s.playerId, []);
    byPlayer.get(s.playerId)!.push(s);
  }
  // Flatten into per-team timeline of (date, rollingGsax) using whichever
  // goalie started that game for that team.
  const byTeam = new Map<string, { date: string; rollingGsax: number }[]>();
  for (const [, apps] of byPlayer) {
    const sorted = [...apps].sort((a, b) => a.gameDate.localeCompare(b.gameDate));
    for (let i = 0; i < sorted.length; i++) {
      const prior = sorted.slice(Math.max(0, i - ROLLING_GOALIE_WINDOW), i);
      if (prior.length < MIN_PRIOR_GOALIE_STARTS) continue;
      const rollingGsax = prior.reduce((s, a) => s + a.gsaxPer60, 0) / prior.length;
      const team = sorted[i].team;
      if (!byTeam.has(team)) byTeam.set(team, []);
      byTeam.get(team)!.push({ date: sorted[i].gameDate, rollingGsax });
    }
  }
  for (const arr of byTeam.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return byTeam;
}
function lookupRollingGsax(byTeam: Map<string, { date: string; rollingGsax: number }[]>, teamCode: string, beforeIsoDate: string): number | undefined {
  const timeline = byTeam.get(teamCode);
  if (!timeline) return undefined;
  let best: number | undefined;
  for (const entry of timeline) {
    if (entry.date >= beforeIsoDate) break; // sorted ascending, safe to stop early — now a valid comparison since both sides are dashed ISO
    best = entry.rollingGsax;
  }
  return best;
}

// ─── HISTORY (unchanged pattern) ───────────────────────────────────────

interface TeamRecord { date: number; opp: string; res: 'W' | 'L'; home: boolean; pf: number; pa: number; }
function buildHistory(games: Game[]): Map<string, TeamRecord[]> {
  const hist = new Map<string, TeamRecord[]>();
  const push = (team: string, rec: TeamRecord) => { if (!hist.has(team)) hist.set(team, []); hist.get(team)!.push(rec); };
  for (const g of games) {
    push(g.homeTeam, { date: g.seq, opp: g.awayTeam, res: g.homeScore > g.awayScore ? 'W' : 'L', home: true, pf: g.homeScore, pa: g.awayScore });
    push(g.awayTeam, { date: g.seq, opp: g.homeTeam, res: g.awayScore > g.homeScore ? 'W' : 'L', home: false, pf: g.awayScore, pa: g.homeScore });
  }
  return hist;
}
function toForm(recs: TeamRecord[]): FormRecord[] {
  return recs.slice(-10).map(r => ({ date: String(r.date), opponent: r.opp, result: r.res, goalsFor: r.pf, goalsAgainst: r.pa, venue: r.home ? 'home' : 'away' }));
}
function fmtNaira(n: number): string { return `₦${Math.round(n).toLocaleString()}`; }

// ─── BACKTEST CORE (runs once per variant: 'baseline' | 'goalie') ─────

interface Leg { confidence: number; odds: number; won: boolean; }

function runVariant(games: Game[], variant: 'baseline' | 'goalie', teamRolling: Map<string, { date: string; rollingGsax: number }[]>): { legs: Leg[]; coverage: number; coverageByMonth: Map<string, { total: number; covered: number }> } {
  const legs: Leg[] = [];
  let gamesWithGoalieData = 0;
  const coverageByMonth = new Map<string, { total: number; covered: number }>();

  for (const game of games) {
    const priorGames = games.filter(g => g.seq < game.seq);
    const history = buildHistory(priorGames);
    const homeRecords = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date - a.date);
    const awayRecords = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date - a.date);
    if (homeRecords.length < MIN_PRIOR_GAMES || awayRecords.length < MIN_PRIOR_GAMES) continue;

    const h2h: H2HRecord[] = priorGames
      .filter(g => (g.homeTeam === game.homeTeam && g.awayTeam === game.awayTeam) || (g.homeTeam === game.awayTeam && g.awayTeam === game.homeTeam))
      .map(g => {
        const flip = g.homeTeam !== game.homeTeam;
        const hs = flip ? g.awayScore : g.homeScore, as = flip ? g.homeScore : g.awayScore;
        return { date: String(g.seq), homeTeam: game.homeTeam, awayTeam: game.awayTeam, homeScore: hs, awayScore: as, winner: (hs > as ? 'home' : 'away') as 'home' | 'away' };
      });

    const additionalContext: Record<string, unknown> = {};
    const monthKey = game.isoDate.slice(0, 7); // YYYY-MM
    if (!coverageByMonth.has(monthKey)) coverageByMonth.set(monthKey, { total: 0, covered: 0 });
    const monthStat = coverageByMonth.get(monthKey)!;
    monthStat.total++;

    if (variant === 'goalie' && game.homeCode && game.awayCode) {
      const homeG = lookupRollingGsax(teamRolling, game.homeCode, game.isoDate);
      const awayG = lookupRollingGsax(teamRolling, game.awayCode, game.isoDate);
      if (homeG !== undefined) additionalContext.homeGoalieGSaxPer60 = homeG;
      if (awayG !== undefined) additionalContext.awayGoalieGSaxPer60 = awayG;
      if (homeG !== undefined && awayG !== undefined) {
        gamesWithGoalieData++;
        monthStat.covered++;
      }
    }

    const stats: Stats = {
      id: `s-${game.seq}`, matchId: `m-${game.seq}`, sport: 'hockey',
      h2h, homeForm: toForm(homeRecords), awayForm: toForm(awayRecords),
      referee: {}, situational: {}, additionalContext,
      confidenceFactors: { dataCompleteness: 1, h2hSampleSize: h2h.length, formSampleSize: 10 },
    };

    const { lambdaHome, lambdaAway } = computeHockeyGoalLambdas(stats);
    const dist = marginDistribution(lambdaHome, lambdaAway);

    const homeIsRealFavorite = game.homePuckLine < 0;
    const homeLine = homeIsRealFavorite ? -1.5 : 1.5;
    const modelHomeCoverProb = handicapCoverProbability(dist, homeLine);

    const favHomeCover = modelHomeCoverProb >= 0.5;
    const confidence = Math.max(modelHomeCoverProb, 1 - modelHomeCoverProb);
    const americanOdds = favHomeCover ? game.homePuckLineOdds : game.awayPuckLineOdds;
    const odds = americanToDecimal(americanOdds);

    const margin = game.homeScore - game.awayScore;
    const homeCovered = homeIsRealFavorite ? margin >= 2 : margin >= -1;
    const won = favHomeCover ? homeCovered : !homeCovered;

    legs.push({ confidence, odds, won });
  }

  const coverage = games.length ? gamesWithGoalieData / games.length : 0;
  return { legs, coverage, coverageByMonth };
}

function printCoverageByMonth(coverageByMonth: Map<string, { total: number; covered: number }>) {
  console.log('\n── Coverage by month (goalie variant) ──');
  console.log('Month      Games   Covered   Coverage%');
  const months = [...coverageByMonth.keys()].sort();
  for (const m of months) {
    const stat = coverageByMonth.get(m)!;
    const pct = stat.total ? (stat.covered / stat.total) * 100 : 0;
    console.log(`${m}    ${String(stat.total).padStart(5)}   ${String(stat.covered).padStart(7)}   ${pct.toFixed(1).padStart(8)}%`);
  }
}

function printFloorTable(label: string, legs: Leg[]) {
  console.log(`\n── ${label} ──`);
  console.log('Floor   Bets   Wins   Win%     AvgOdds   ROI%      Profit(Fixed)');
  for (const floor of CONFIDENCE_FLOORS) {
    const sel = legs.filter(l => l.confidence >= floor);
    if (!sel.length) { console.log(`${(floor * 100).toFixed(0)}%      0`); continue; }
    const wins = sel.filter(l => l.won).length;
    const avgOdds = sel.reduce((s, l) => s + l.odds, 0) / sel.length;
    const staked = sel.length * FIXED_STAKE;
    const profit = sel.reduce((s, l) => s + (l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE), 0);
    const roi = (profit / staked) * 100;
    console.log(
      `${(floor * 100).toFixed(0)}%     ${String(sel.length).padStart(4)}   ${String(wins).padStart(4)}   ` +
      `${((wins / sel.length) * 100).toFixed(1).padStart(5)}%   ${avgOdds.toFixed(3).padStart(7)}   ` +
      `${roi.toFixed(2).padStart(7)}%   ${fmtNaira(profit).padStart(14)}`
    );
  }
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Loading SBRO file: ${sbroPath}`);
  const sbroRows = parseSbroRows(fs.readFileSync(sbroPath, 'utf-8'));
  const allGames = pairRowsIntoGames(sbroRows, seasonStartYear).sort((a, b) => a.seq - b.seq);
  const games = allGames.filter(g => !isPreseasonNoise(g.dateLabel));
  console.log(`Parsed ${allGames.length} games (${allGames.length - games.length} preseason excluded).`);

  const unresolvedTeams = new Set<string>();
  for (const g of games) {
    if (!g.homeCode) unresolvedTeams.add(g.homeTeam);
    if (!g.awayCode) unresolvedTeams.add(g.awayTeam);
  }
  if (unresolvedTeams.size) {
    console.warn(`\nWARNING: ${unresolvedTeams.size} team string(s) did not resolve to a MoneyPuck code:`);
    console.warn(`  ${[...unresolvedTeams].join(', ')}`);
    console.warn(`These games will run WITHOUT goalie data in the 'goalie' variant (falls back to neutral).`);
    console.warn(`Add missing teams to SBRO_TEAM_TO_CODE at the top of this file if this list isn't empty.\n`);
  }

  console.log(`Loading goalie CSV: ${goalieCsvPath}`);
  const goalieRows = loadGoalieRows(goalieCsvPath);
  const starters = identifyStarters(goalieRows);
  const teamRolling = buildTeamRollingLookup(starters);
  console.log(`Loaded ${goalieRows.length} goalie-game rows -> ${starters.length} starter appearances -> rolling GSAx built for ${teamRolling.size} teams.\n`);

  const baseline = runVariant(games, 'baseline', teamRolling);
  const goalie = runVariant(games, 'goalie', teamRolling);

  console.log(`Qualifying games: ${baseline.legs.length} (same set used for both variants).`);
  console.log(`Goalie-variant coverage: ${(goalie.coverage * 100).toFixed(1)}% of games had rolling GSAx for BOTH starters.`);
  console.log(`(Games missing goalie data fall back to neutral/no-adjustment automatically —`);
  console.log(` this is why the two variants won't diverge on every single game.)`);

  printFloorTable('BASELINE (no goalie adjustment — matches original sbroNhlPuckLineBacktest.ts)', baseline.legs);
  printFloorTable('WITH GOALIE ADJUSTMENT (GOALIE_GSAX_SENSITIVITY, unvalidated)', goalie.legs);
  printCoverageByMonth(goalie.coverageByMonth);

  console.log('\n── Delta (goalie ROI% minus baseline ROI%, per floor) ──');
  for (const floor of CONFIDENCE_FLOORS) {
    const b = baseline.legs.filter(l => l.confidence >= floor);
    const g = goalie.legs.filter(l => l.confidence >= floor);
    if (!b.length || !g.length) { console.log(`${(floor * 100).toFixed(0)}%   n/a (empty bucket)`); continue; }
    const roiOf = (arr: Leg[]) => {
      const staked = arr.length * FIXED_STAKE;
      const profit = arr.reduce((s, l) => s + (l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE), 0);
      return (profit / staked) * 100;
    };
    const delta = roiOf(g) - roiOf(b);
    console.log(`${(floor * 100).toFixed(0)}%   ${(delta >= 0 ? '+' : '') + delta.toFixed(2)}pp`);
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`READ THE PROXY CAVEAT AT THE TOP OF THIS FILE before acting on`);
  console.log(`any result. This uses "team's most recent known rolling GSAx",`);
  console.log(`not a confirmed starting goalie for this specific game.`);
  console.log(`GOALIE_GSAX_SENSITIVITY (0.05) is an unfitted placeholder — if`);
  console.log(`this delta is meaningfully positive, the next real step is`);
  console.log(`fitting that sensitivity properly (and confirming on the other`);
  console.log(`three seasons), not shipping it on one season's word.`);
  console.log(`────────────────────────────────────────────────────────────`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });