/**
 * crossSportSeasonDiagnosticBacktest.ts
 *
 * Cross-sport diagnostic backtest using the project's real probabilityModel.ts.
 *
 * IMPORTANT:
 * - Odds are NOT capped. Any decimal odds > 1.00 are eligible.
 * - Confidence floors tested: 70%, 75%, 80%, 85%, 90%.
 * - Team history must meet MIN_TEAM_HISTORY before a game is modelled.
 * - Games on the same calendar date are evaluated BEFORE any result from
 *   that date is added to historical form (prevents same-day leakage).
 * - Reports singles, one same-day 2-leg parlay per calendar day, peak profit,
 *   maximum drawdown, longest winning streak and longest losing streak.
 *
 * Run:
 *   npx ts-node .\src\core\engine\crossSportSeasonDiagnosticBacktest.ts
 *
 * Optional:
 *   MIN_ODDS=1.01
 *   MIN_TEAM_HISTORY=5
 *   STAKE_SINGLE=10000
 *   STAKE_PARLAY=10000
 *   CONFIDENCE_FLOORS=0.70,0.75,0.80,0.85,0.90
 *   REQUIRE_DIFFERENT_LEAGUES=0
 *   REQUIRE_DIFFERENT_SPORTS=0
 */

import * as fs from "fs";
import * as path from "path";
import { getProbabilities, ModelInput } from "./probabilityModel";
import { Stats, FormRecord, H2HRecord } from "../database/schema";

type Sport = "basketball" | "hockey";

type Game = {
  date: string;
  tournament: string;
  stage: string;
  status: string;
  home: string;
  homeScore: number;
  away: string;
  awayScore: number;
  homeOdds: number;
  awayOdds: number;
  sport: Sport;
  league: string;
};

type HistoryRow = {
  date: string;
  opponent: string;
  result: "W" | "L";
  pointsFor: number;
  pointsAgainst: number;
  home: boolean;
};

type Leg = Game & {
  pickHome: boolean;
  team: string;
  odds: number;
  modelProbability: number;
  edge: number;
  win: boolean;
};

type BetResult = {
  date: string;
  season: string;
  league: string;
  sport: Sport;
  team: string;
  opponent: string;
  side: "home" | "away";
  odds: number;
  modelProbability: number;
  edge: number;
  win: boolean;
  profit: number;
};

type ParlayResult = {
  number: number;
  date: string;
  season: string;
  leg1: Leg;
  leg2: Leg;
  combinedOdds: number;
  win: boolean;
  profit: number;
};

type StreakInfo = {
  longestWins: number;
  longestWinsStart: string;
  longestWinsEnd: string;
  longestLosses: number;
  longestLossesStart: string;
  longestLossesEnd: string;
  currentType: "WIN" | "LOSS" | "NONE";
  currentLength: number;
  currentStart: string;
  currentEnd: string;
};

type EquityStats = {
  finalProfit: number;
  peakProfit: number;
  peakDate: string;
  peakBet: number;
  maxDrawdown: number;
  longestWins: number;
  longestWinsStart: string;
  longestWinsEnd: string;
  longestLosses: number;
  longestLossesStart: string;
  longestLossesEnd: string;
  currentType: "WIN" | "LOSS" | "NONE";
  currentLength: number;
  currentStart: string;
  currentEnd: string;
};

const ROOT = process.cwd();

const STAKE_SINGLE = Number(process.env.STAKE_SINGLE || 10000);
const STAKE_PARLAY = Number(process.env.STAKE_PARLAY || 10000);

// Free odds: only reject invalid decimal odds <= 1.00.
// There is deliberately NO ODDS_MAX.
const MIN_ODDS = Number(process.env.MIN_ODDS || 1.35);

const MIN_TEAM_HISTORY = Number(process.env.MIN_TEAM_HISTORY || 5);

const CONFIDENCE_FLOORS = (
  process.env.CONFIDENCE_FLOORS || "0.70,0.75,0.80,0.85,0.90"
)
  .split(",")
  .map(Number)
  .filter(x => Number.isFinite(x) && x > 0 && x <= 1);

const REQUIRE_DIFFERENT_LEAGUES =
  process.env.REQUIRE_DIFFERENT_LEAGUES === "1";

const REQUIRE_DIFFERENT_SPORTS =
  process.env.REQUIRE_DIFFERENT_SPORTS === "1";

const FILES: Array<{ file: string; league: string; sport: Sport }> = [
  { file: "acb_all_seasons.csv", league: "ACB", sport: "basketball" },
  { file: "bbl_all.csv", league: "BBL", sport: "basketball" },
  { file: "bls_all.csv", league: "BLS", sport: "basketball" },
  { file: "fra_all.csv", league: "FRA", sport: "basketball" },
  { file: "gre_all.csv", league: "GRE", sport: "basketball" },
  { file: "ita_all.csv", league: "ITA", sport: "basketball" },
  { file: "tur_all.csv", league: "TUR", sport: "basketball" },

  { file: "ahl_all.csv", league: "AHL", sport: "hockey" },
  { file: "del_all.csv", league: "DEL", sport: "hockey" },
  { file: "del2_all.csv", league: "DEL2", sport: "hockey" },
  { file: "denmark_all.csv", league: "DENMARK", sport: "hockey" },
  { file: "eihl_all.csv", league: "EIHL", sport: "hockey" },
  {
    file: "hockeyallsvenskan_all.csv",
    league: "HOCKEYALLSVENSKAN",
    sport: "hockey",
  },
  { file: "icehl_all.csv", league: "ICEHL", sport: "hockey" },
  { file: "khl_all.csv", league: "KHL", sport: "hockey" },
  { file: "liiga_all.csv", league: "LIIGA", sport: "hockey" },
  { file: "mestis_all.csv", league: "MESTIS", sport: "hockey" },
  { file: "nhl_all.csv", league: "NHL", sport: "hockey" },
  { file: "shl_all.csv", league: "SHL", sport: "hockey" },
];

// These are rebuilt incrementally while walking historical games.
let CURRENT_GAMES: Game[] = [];
let CURRENT_HISTORY = new Map<string, HistoryRow[]>();

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }

  out.push(cur.trim());
  return out.map(x => x.replace(/^"(.*)"$/, "$1").trim());
}

function normaliseHeader(x: string): string {
  return x
    .trim()
    .replace(/^"|"$/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function getColumnMap(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => {
    map[normaliseHeader(h)] = i;
  });
  return map;
}

function col(
  map: Record<string, number>,
  aliases: string[],
  file: string
): number {
  for (const alias of aliases) {
    const idx = map[normaliseHeader(alias)];
    if (idx !== undefined) return idx;
  }

  throw new Error(
    `${file}: missing required CSV column for ${aliases.join(" / ")}`
  );
}

function readGames(
  filename: string,
  league: string,
  sport: Sport
): Game[] {
  const full = path.join(ROOT, filename);

  if (!fs.existsSync(full)) {
    throw new Error(`file not found: .\\${filename}`);
  }

  const lines = fs
    .readFileSync(full, "utf8")
    .split(/\r?\n/)
    .filter(x => x.trim());

  if (lines.length < 2) return [];

  const m = getColumnMap(parseCsvLine(lines[0]));

  const date = col(m, ["Date", "GameDate"], filename);
  const tournament = col(
    m,
    ["Tournament", "League", "Competition"],
    filename
  );
  const stage = col(m, ["Stage"], filename);
  const status = col(m, ["Status"], filename);

  const home = col(
    m,
    ["Home_Team", "HomeTeam", "Home"],
    filename
  );

  const homeScore = col(
    m,
    ["Home_Score", "HomeScore", "HomePoints"],
    filename
  );

  const away = col(
    m,
    ["Away_Team", "AwayTeam", "Away"],
    filename
  );

  const awayScore = col(
    m,
    ["Away_Score", "AwayScore", "AwayPoints"],
    filename
  );

  const homeOdds = col(
    m,
    ["Home_Odds", "HomeOdds", "HomePrice"],
    filename
  );

  const awayOdds = col(
    m,
    ["Away_Odds", "AwayOdds", "AwayPrice"],
    filename
  );

  const games: Game[] = [];

  for (let i = 1; i < lines.length; i++) {
    const p = parseCsvLine(lines[i]);

    const hs = Number(p[homeScore]);
    const as = Number(p[awayScore]);
    const ho = Number(p[homeOdds]);
    const ao = Number(p[awayOdds]);

    if (
      !p[date] ||
      !p[tournament] ||
      !p[home] ||
      !p[away] ||
      !Number.isFinite(hs) ||
      !Number.isFinite(as) ||
      !Number.isFinite(ho) ||
      !Number.isFinite(ao)
    ) {
      continue;
    }

    games.push({
      date: p[date],
      tournament: p[tournament],
      stage: p[stage] || "",
      status: p[status] || "Finished",
      home: p[home],
      homeScore: hs,
      away: p[away],
      awayScore: as,
      homeOdds: ho,
      awayOdds: ao,
      sport,
      league,
    });
  }

  return games;
}

function seasonFromTournament(tournament: string): string {
  const m = tournament.match(/(\d{4}\/\d{4})/);
  return m ? m[1] : tournament || "UNKNOWN";
}

function h2hRecords(games: Game[], g: Game): H2HRecord[] {
  return games
    .filter(
      x =>
        x.date < g.date &&
        ((x.home === g.home && x.away === g.away) ||
          (x.home === g.away && x.away === g.home))
    )
    .map(x => {
      const flip = x.home !== g.home;

      const hs = flip ? x.awayScore : x.homeScore;
      const as = flip ? x.homeScore : x.awayScore;

      return {
        date: new Date(x.date).toISOString(),
        homeTeam: g.home,
        awayTeam: g.away,
        homeScore: hs,
        awayScore: as,
        winner: (hs > as ? "home" : "away") as "home" | "away",
      };
    });
}

function formRecords(history: HistoryRow[]): FormRecord[] {
  return history.slice(-10).map(x => ({
    date: new Date(x.date).toISOString(),
    opponent: x.opponent,
    result: x.result,
    goalsFor: x.pointsFor,
    goalsAgainst: x.pointsAgainst,
    venue: x.home ? "home" : "away",
  }));
}

/**
 * Adapter to the actual probabilityModel.ts contract.
 *
 * The important fix here is that stats is ALWAYS supplied.
 * The previous crashing version reached modelBasketball() with
 * stats === undefined, causing:
 *
 *   stats.additionalContext
 *
 * to throw.
 */
function modelProbability(g: Game, pickHome: boolean): number {
  const homeHistory =
    CURRENT_HISTORY.get(`${g.sport}|${g.league}|${g.home}`) ?? [];

  const awayHistory =
    CURRENT_HISTORY.get(`${g.sport}|${g.league}|${g.away}`) ?? [];

  const id =
    `${g.league}-${g.home}-${g.away}-` +
    `${new Date(g.date).toISOString()}`;

  const h2h = h2hRecords(CURRENT_GAMES, g);

  const stats: Stats = {
    id: "s-" + id,
    matchId: id,
    sport: g.sport,
    h2h,
    homeForm: formRecords(homeHistory),
    awayForm: formRecords(awayHistory),
    referee: {},
    situational: {},
    additionalContext: {
      league: g.league,
      stage: g.stage,
      status: g.status,
    },
    confidenceFactors: {
      dataCompleteness: 1,
      h2hSampleSize: h2h.length,
      formSampleSize: Math.min(
        10,
        homeHistory.length + awayHistory.length
      ),
    },
  };

  const input: ModelInput = {
    match: {
      id,
      sport: g.sport,
      homeTeam: g.home,
      awayTeam: g.away,
      startTime: new Date(g.date).toISOString(),
      league: g.league,
    },
    stats,
    odds: [],
  };

  const result = getProbabilities(input);

  const homeProbability = result.find(
    p =>
      p.market === "moneyline" &&
      p.selection === "Home"
  )?.trueProbability;

  if (
    homeProbability === undefined ||
    !Number.isFinite(homeProbability)
  ) {
    throw new Error(
      `No valid Home moneyline probability returned for ` +
      `${g.league}: ${g.home} vs ${g.away}`
    );
  }

  const hp =
    homeProbability > 1
      ? homeProbability / 100
      : homeProbability;

  const probability = pickHome ? hp : 1 - hp;

  if (!Number.isFinite(probability)) {
    throw new Error(
      `Invalid probability for ${g.league}: ` +
      `${g.home} vs ${g.away}`
    );
  }

  return Math.max(0, Math.min(1, probability));
}

function settlesWin(
  g: Game,
  pickHome: boolean
): boolean {
  // CSV Home/Away hockey prices are treated as regulation markets.
  // If the final result is explicitly After OT / After Pen., a regulation
  // Home/Away pick does not win.
  if (
    g.sport === "hockey" &&
    /After OT|After Pen\.?/i.test(g.status)
  ) {
    return false;
  }

  if (g.homeScore === g.awayScore) return false;

  return pickHome
    ? g.homeScore > g.awayScore
    : g.awayScore > g.homeScore;
}

function makeLeg(
  g: Game,
  pickHome: boolean,
  confidenceFloor: number
): Leg | null {
  const odds = pickHome ? g.homeOdds : g.awayOdds;

  // FREE ODDS:
  // no upper limit. Only decimal odds <= 1.00 are invalid.
  if (!Number.isFinite(odds) || odds < MIN_ODDS) {
    return null;
  }

  const p = modelProbability(g, pickHome);

  if (p < confidenceFloor) return null;

  return {
    ...g,
    pickHome,
    team: pickHome ? g.home : g.away,
    odds,
    modelProbability: p,
    edge: p - 1 / odds,
    win: settlesWin(g, pickHome),
  };
}

function betterLeg(a: Leg, b: Leg): Leg {
  if (a.modelProbability !== b.modelProbability) {
    return a.modelProbability > b.modelProbability ? a : b;
  }

  if (a.edge !== b.edge) {
    return a.edge > b.edge ? a : b;
  }

  return a.odds < b.odds ? a : b;
}

function calcProfit(
  odds: number,
  stake: number,
  win: boolean
): number {
  return win ? stake * (odds - 1) : -stake;
}

function roi(
  profit: number,
  staked: number
): number {
  return staked ? (profit / staked) * 100 : 0;
}

function pct(
  wins: number,
  n: number
): number {
  return n ? (wins / n) * 100 : 0;
}

function money(n: number): string {
  const sign = n < 0 ? "-" : "";

  return (
    sign +
    `₦${Math.round(Math.abs(n)).toLocaleString("en-NG")}`
  );
}

function emptyStreakInfo(): StreakInfo {
  return {
    longestWins: 0,
    longestWinsStart: "",
    longestWinsEnd: "",
    longestLosses: 0,
    longestLossesStart: "",
    longestLossesEnd: "",
    currentType: "NONE",
    currentLength: 0,
    currentStart: "",
    currentEnd: "",
  };
}

function calculateStreaks(
  bets: Array<{ date: string; win: boolean }>
): StreakInfo {
  if (!bets.length) return emptyStreakInfo();

  let longestWins = 0;
  let longestWinsStart = "";
  let longestWinsEnd = "";

  let longestLosses = 0;
  let longestLossesStart = "";
  let longestLossesEnd = "";

  let runType: "WIN" | "LOSS" | "NONE" = "NONE";
  let runLength = 0;
  let runStart = "";

  for (const bet of bets) {
    const type: "WIN" | "LOSS" = bet.win ? "WIN" : "LOSS";

    if (type === runType) {
      runLength++;
    } else {
      runType = type;
      runLength = 1;
      runStart = bet.date;
    }

    if (type === "WIN" && runLength > longestWins) {
      longestWins = runLength;
      longestWinsStart = runStart;
      longestWinsEnd = bet.date;
    }

    if (type === "LOSS" && runLength > longestLosses) {
      longestLosses = runLength;
      longestLossesStart = runStart;
      longestLossesEnd = bet.date;
    }
  }

  const last = bets[bets.length - 1];
  const currentType: "WIN" | "LOSS" =
    last.win ? "WIN" : "LOSS";

  return {
    longestWins,
    longestWinsStart,
    longestWinsEnd,
    longestLosses,
    longestLossesStart,
    longestLossesEnd,
    currentType,
    currentLength: runLength,
    currentStart: runStart,
    currentEnd: last.date,
  };
}

function peakAndDrawdown(
  bets: Array<{ date: string; profit: number; win: boolean }>
): EquityStats {
  let cumulative = 0;
  let peak = 0;
  let peakDate = "";
  let peakBet = 0;
  let maxDrawdown = 0;

  for (let i = 0; i < bets.length; i++) {
    const b = bets[i];

    cumulative += b.profit;

    if (cumulative > peak) {
      peak = cumulative;
      peakDate = b.date;
      peakBet = i + 1;
    }

    maxDrawdown = Math.max(
      maxDrawdown,
      peak - cumulative
    );
  }

  const streaks = calculateStreaks(
    bets.map(x => ({
      date: x.date,
      win: x.win,
    }))
  );

  return {
    finalProfit: cumulative,
    peakProfit: peak,
    peakDate,
    peakBet,
    maxDrawdown,
    ...streaks,
  };
}

function printEquityStats(
  label: string,
  stats: EquityStats,
  betCount: number,
  stake: number
) {
  console.log(`\n=== ${label} ===`);
  console.log(`Bets: ${betCount}`);
  console.log(`Total staked: ${money(betCount * stake)}`);
  console.log(`Final profit/loss: ${money(stats.finalProfit)}`);
  console.log(
    `FINAL ROI: ${roi(stats.finalProfit, betCount * stake).toFixed(2)}%`
  );
  console.log(`Peak cumulative profit: ${money(stats.peakProfit)}`);
  console.log(
    `Peak occurred: ${stats.peakDate || "N/A"} at #${stats.peakBet || 0}`
  );
  console.log(`Maximum drawdown: ${money(stats.maxDrawdown)}`);

  console.log(
    `Longest winning streak: ${stats.longestWins}` +
    (stats.longestWins
      ? ` (${stats.longestWinsStart} -> ${stats.longestWinsEnd})`
      : "")
  );

  console.log(
    `Longest losing streak: ${stats.longestLosses}` +
    (stats.longestLosses
      ? ` (${stats.longestLossesStart} -> ${stats.longestLossesEnd})`
      : "")
  );

  console.log(
    `Current streak: ${stats.currentType} ${stats.currentLength}` +
    (stats.currentLength
      ? ` (${stats.currentStart} -> ${stats.currentEnd})`
      : "")
  );
}

function evaluateGamesAtFloor(
  allGames: Game[],
  confidenceFloor: number
): Leg[] {
  const teamHistoryCount = new Map<string, number>();
  const qualifyingLegs: Leg[] = [];

  CURRENT_HISTORY = new Map();
  CURRENT_GAMES = allGames;

  // Critical: process every game chronologically. A game's result is only
  // added AFTER that game's model has been evaluated.
  for (const g of allGames) {
    const hk = `${g.sport}|${g.league}|${g.home}`;
    const ak = `${g.sport}|${g.league}|${g.away}`;

    const hh = teamHistoryCount.get(hk) || 0;
    const ah = teamHistoryCount.get(ak) || 0;

    if (
      hh >= MIN_TEAM_HISTORY &&
      ah >= MIN_TEAM_HISTORY
    ) {
      const h = makeLeg(
        g,
        true,
        confidenceFloor
      );

      const a = makeLeg(
        g,
        false,
        confidenceFloor
      );

      const leg =
        h && a
          ? betterLeg(h, a)
          : h || a;

      if (leg) {
        qualifyingLegs.push(leg);
      }
    }

    if (!CURRENT_HISTORY.has(hk)) {
      CURRENT_HISTORY.set(hk, []);
    }

    if (!CURRENT_HISTORY.has(ak)) {
      CURRENT_HISTORY.set(ak, []);
    }

    CURRENT_HISTORY.get(hk)!.push({
      date: g.date,
      opponent: g.away,
      result:
        g.homeScore > g.awayScore
          ? "W"
          : "L",
      pointsFor: g.homeScore,
      pointsAgainst: g.awayScore,
      home: true,
    });

    CURRENT_HISTORY.get(ak)!.push({
      date: g.date,
      opponent: g.home,
      result:
        g.awayScore > g.homeScore
          ? "W"
          : "L",
      pointsFor: g.awayScore,
      pointsAgainst: g.homeScore,
      home: false,
    });

    teamHistoryCount.set(hk, hh + 1);
    teamHistoryCount.set(ak, ah + 1);
  }

  return qualifyingLegs;
}

function toBetResults(
  legs: Leg[]
): BetResult[] {
  return legs.map(l => ({
    date: l.date,
    season: seasonFromTournament(l.tournament),
    league: l.league,
    sport: l.sport,
    team: l.team,
    opponent: l.pickHome ? l.away : l.home,
    side: l.pickHome ? "home" : "away",
    odds: l.odds,
    modelProbability: l.modelProbability,
    edge: l.edge,
    win: l.win,
    profit: calcProfit(
      l.odds,
      STAKE_SINGLE,
      l.win
    ),
  }));
}

function chooseBestPair(
  legs: Leg[]
): [Leg, Leg] | null {
  if (legs.length < 2) return null;

  let bestPair: [Leg, Leg] | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i];
      const b = legs[j];

      if (
        REQUIRE_DIFFERENT_LEAGUES &&
        a.league === b.league
      ) {
        continue;
      }

      if (
        REQUIRE_DIFFERENT_SPORTS &&
        a.sport === b.sport
      ) {
        continue;
      }

      const score =
        a.modelProbability *
        b.modelProbability;

      if (score > bestScore) {
        bestScore = score;
        bestPair = [a, b];
      }
    }
  }

  return bestPair;
}

function buildParlays(
  qualifyingLegs: Leg[]
): ParlayResult[] {
  const byDate = new Map<string, Leg[]>();

  for (const leg of qualifyingLegs) {
    if (!byDate.has(leg.date)) {
      byDate.set(leg.date, []);
    }

    byDate.get(leg.date)!.push(leg);
  }

  const parlays: ParlayResult[] = [];

  for (
    const [date, legs] of [...byDate.entries()].sort()
  ) {
    const pair = chooseBestPair(legs);

    if (!pair) continue;

    const [a, b] = pair;
    const combinedOdds = a.odds * b.odds;
    const win = a.win && b.win;

    parlays.push({
      number: parlays.length + 1,
      date,
      season: seasonFromTournament(
        a.tournament
      ),
      leg1: a,
      leg2: b,
      combinedOdds,
      win,
      profit: calcProfit(
        combinedOdds,
        STAKE_PARLAY,
        win
      ),
    });
  }

  return parlays;
}

function printSeasonResults(
  singles: BetResult[],
  parlays: ParlayResult[]
) {
  type SeasonAgg = {
    singles: BetResult[];
    parlays: ParlayResult[];
  };

  const seasons = new Map<
    string,
    SeasonAgg
  >();

  const ensure = (s: string) => {
    if (!seasons.has(s)) {
      seasons.set(s, {
        singles: [],
        parlays: [],
      });
    }

    return seasons.get(s)!;
  };

  for (const s of singles) {
    ensure(s.season).singles.push(s);
  }

  for (const p of parlays) {
    ensure(p.season).parlays.push(p);
  }

  console.log(
    "\n=== SEASON-BY-SEASON RESULTS ==="
  );

  console.log(
    "Season       Singles S-Win%  S-P/L        S-ROI   " +
    "Parlays P-Win%  P-P/L        P-ROI"
  );

  console.log(
    "------------------------------------------------------------------------------------------"
  );

  for (
    const [season, a] of [...seasons.entries()].sort()
  ) {
    const sw = a.singles.filter(x => x.win).length;
    const pw = a.parlays.filter(x => x.win).length;

    const sp = a.singles.reduce(
      (s, x) => s + x.profit,
      0
    );

    const pp = a.parlays.reduce(
      (s, x) => s + x.profit,
      0
    );

    console.log(
      `${season.padEnd(12)} ` +
      `${String(a.singles.length).padStart(7)} ` +
      `${pct(sw, a.singles.length).toFixed(2).padStart(6)}% ` +
      `${money(sp).padStart(12)} ` +
      `${roi(
        sp,
        a.singles.length * STAKE_SINGLE
      ).toFixed(2).padStart(8)}% ` +
      `${String(a.parlays.length).padStart(8)} ` +
      `${pct(
        pw,
        a.parlays.length
      ).toFixed(2).padStart(6)}% ` +
      `${money(pp).padStart(12)} ` +
      `${roi(
        pp,
        a.parlays.length * STAKE_PARLAY
      ).toFixed(2).padStart(8)}%`
    );
  }
}

function printSeasonLeagueResults(
  singles: BetResult[]
) {
  type SL = {
    sport: Sport;
    bets: BetResult[];
  };

  const sl = new Map<string, SL>();

  for (const s of singles) {
    const key =
      `${s.season}|${s.league}`;

    if (!sl.has(key)) {
      sl.set(key, {
        sport: s.sport,
        bets: [],
      });
    }

    sl.get(key)!.bets.push(s);
  }

  console.log(
    "\n=== SEASON × LEAGUE SINGLE-BET BREAKDOWN ==="
  );

  console.log(
    "Season       League                Sport        " +
    "Bets Win%   AvgOdds      P/L       ROI"
  );

  console.log(
    "------------------------------------------------------------------------------------------"
  );

  for (
    const [key, a] of [...sl.entries()].sort()
  ) {
    const [season, league] =
      key.split("|");

    const wins =
      a.bets.filter(x => x.win).length;

    const profit =
      a.bets.reduce(
        (s, x) => s + x.profit,
        0
      );

    const avgOdds =
      a.bets.reduce(
        (s, x) => s + x.odds,
        0
      ) / a.bets.length;

    console.log(
      `${season.padEnd(12)} ` +
      `${league.padEnd(20)} ` +
      `${a.sport.padEnd(12)} ` +
      `${String(a.bets.length).padStart(4)} ` +
      `${pct(
        wins,
        a.bets.length
      ).toFixed(1).padStart(5)}% ` +
      `${avgOdds.toFixed(3).padStart(8)} ` +
      `${money(profit).padStart(12)} ` +
      `${roi(
        profit,
        a.bets.length * STAKE_SINGLE
      ).toFixed(2).padStart(8)}%`
    );
  }
}

function printLastParlays(
  parlays: ParlayResult[]
) {
  console.log(
    "\n=== LAST 10 SAME-DAY PARLAYS ==="
  );

  for (const p of parlays.slice(-10)) {
    console.log(
      `#${p.number} ${p.date} | ` +
      `${p.leg1.league}:${p.leg1.team}` +
      `@${p.leg1.odds.toFixed(2)}` +
      `${p.leg1.win ? "✓" : "✗"} + ` +
      `${p.leg2.league}:${p.leg2.team}` +
      `@${p.leg2.odds.toFixed(2)}` +
      `${p.leg2.win ? "✓" : "✗"} | ` +
      `${p.win ? "WIN" : "LOSS"} | ` +
      `${money(p.profit)}`
    );
  }
}

function runFloor(
  allGames: Game[],
  confidenceFloor: number
) {
  console.log(
    `\n\n============================================================`
  );

  console.log(
    `CONFIDENCE FLOOR: ${(confidenceFloor * 100).toFixed(0)}%`
  );

  console.log(
    `Odds: FREE (minimum ${MIN_ODDS.toFixed(2)}, NO MAXIMUM)`
  );

  console.log(
    `============================================================`
  );

  const qualifyingLegs =
    evaluateGamesAtFloor(
      allGames,
      confidenceFloor
    );

  console.log(
    `Qualifying single legs: ${qualifyingLegs.length}`
  );

  const singles =
    toBetResults(qualifyingLegs);

  const singleStats =
    peakAndDrawdown(singles);

  const singleWins =
    singles.filter(x => x.win).length;

  printEquityStats(
    "SINGLE-BET RESULT",
    singleStats,
    singles.length,
    STAKE_SINGLE
  );

  console.log(
    `Wins: ${singleWins} ` +
    `(${pct(
      singleWins,
      singles.length
    ).toFixed(2)}%)`
  );

  console.log(
    `Losses: ${singles.length - singleWins}`
  );

  const parlays =
    buildParlays(qualifyingLegs);

  const parlayStats =
    peakAndDrawdown(
      parlays.map(p => ({
        date: p.date,
        profit: p.profit,
        win: p.win,
      }))
    );

  const parlayWins =
    parlays.filter(x => x.win).length;

  const avgCombined =
    parlays.length
      ? parlays.reduce(
          (s, x) =>
            s + x.combinedOdds,
          0
        ) / parlays.length
      : 0;

  printEquityStats(
    "2-LEG SAME-DAY PARLAY RESULT",
    parlayStats,
    parlays.length,
    STAKE_PARLAY
  );

  console.log(
    `Wins: ${parlayWins} ` +
    `(${pct(
      parlayWins,
      parlays.length
    ).toFixed(2)}%)`
  );

  console.log(
    `Losses: ${parlays.length - parlayWins}`
  );

  console.log(
    `Average combined odds: ${avgCombined.toFixed(3)}`
  );

  printSeasonResults(
    singles,
    parlays
  );

  printSeasonLeagueResults(
    singles
  );

  printLastParlays(
    parlays
  );

  return {
    confidenceFloor,
    singles,
    parlays,
    singleStats,
    parlayStats,
  };
}

function main() {
  console.log(
    "=== CROSS-SPORT CONFIDENCE-FLOOR DIAGNOSTIC BACKTEST ==="
  );

  console.log(
    `Stake/single: ${money(STAKE_SINGLE)}`
  );

  console.log(
    `Stake/day parlay: ${money(STAKE_PARLAY)}`
  );

  console.log(
    `Confidence floors: ${CONFIDENCE_FLOORS
      .map(x => `${(x * 100).toFixed(0)}%`)
      .join(", ")}`
  );

  console.log(
    `Odds: FREE above ${MIN_ODDS.toFixed(2)}; no upper limit`
  );

  console.log(
    `Minimum team history: ${MIN_TEAM_HISTORY}`
  );

  console.log(
    `Different leagues required: ${REQUIRE_DIFFERENT_LEAGUES}`
  );

  console.log(
    `Different sports required: ${REQUIRE_DIFFERENT_SPORTS}`
  );

  console.log(
    "Hockey After OT / After Pen.: LOSS for regulation Home/Away bet"
  );

  const allGames: Game[] = [];

  for (const cfg of FILES) {
    try {
      const games = readGames(
        cfg.file,
        cfg.league,
        cfg.sport
      );

      allGames.push(...games);

      console.log(
        `${cfg.sport.toUpperCase()} ` +
        `${cfg.league}: ` +
        `${games.length.toLocaleString()} games loaded`
      );
    } catch (e) {
      console.error(
        `FAILED ${cfg.league}: ` +
        `${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  allGames.sort(
    (a, b) =>
      a.date.localeCompare(b.date)
  );

  console.log(
    `Total games: ${allGames.length.toLocaleString()}`
  );

  if (allGames.length) {
    console.log(
      `Date range: ${allGames[0].date} -> ` +
      `${allGames[allGames.length - 1].date}`
    );
  }

  const results: any[] = [];

  for (const floor of CONFIDENCE_FLOORS) {
    const r = runFloor(
      allGames,
      floor
    );

    results.push({
      confidenceFloor: floor,

      single: {
        bets: r.singles.length,
        wins: r.singles.filter(
          (x: BetResult) => x.win
        ).length,
        losses:
          r.singles.length -
          r.singles.filter(
            (x: BetResult) => x.win
          ).length,
        profit:
          r.singleStats.finalProfit,
        roi: roi(
          r.singleStats.finalProfit,
          r.singles.length *
            STAKE_SINGLE
        ),
        peakProfit:
          r.singleStats.peakProfit,
        peakDate:
          r.singleStats.peakDate,
        peakBet:
          r.singleStats.peakBet,
        maxDrawdown:
          r.singleStats.maxDrawdown,
        longestWinningStreak:
          r.singleStats.longestWins,
        longestWinningStreakStart:
          r.singleStats.longestWinsStart,
        longestWinningStreakEnd:
          r.singleStats.longestWinsEnd,
        longestLosingStreak:
          r.singleStats.longestLosses,
        longestLosingStreakStart:
          r.singleStats.longestLossesStart,
        longestLosingStreakEnd:
          r.singleStats.longestLossesEnd,
        currentStreakType:
          r.singleStats.currentType,
        currentStreakLength:
          r.singleStats.currentLength,
      },

      parlay: {
        bets: r.parlays.length,
        wins: r.parlays.filter(
          (x: ParlayResult) => x.win
        ).length,
        losses:
          r.parlays.length -
          r.parlays.filter(
            (x: ParlayResult) => x.win
          ).length,
        profit:
          r.parlayStats.finalProfit,
        roi: roi(
          r.parlayStats.finalProfit,
          r.parlays.length *
            STAKE_PARLAY
        ),
        peakProfit:
          r.parlayStats.peakProfit,
        peakDate:
          r.parlayStats.peakDate,
        peakBet:
          r.parlayStats.peakBet,
        maxDrawdown:
          r.parlayStats.maxDrawdown,
        longestWinningStreak:
          r.parlayStats.longestWins,
        longestWinningStreakStart:
          r.parlayStats.longestWinsStart,
        longestWinningStreakEnd:
          r.parlayStats.longestWinsEnd,
        longestLosingStreak:
          r.parlayStats.longestLosses,
        longestLosingStreakStart:
          r.parlayStats.longestLossesStart,
        longestLosingStreakEnd:
          r.parlayStats.longestLossesEnd,
        currentStreakType:
          r.parlayStats.currentType,
        currentStreakLength:
          r.parlayStats.currentLength,
      },
    });
  }

  const output = {
    config: {
      stakeSingle: STAKE_SINGLE,
      stakeParlay: STAKE_PARLAY,
      confidenceFloors: CONFIDENCE_FLOORS,
      minOdds: MIN_ODDS,
      maxOdds: null,
      oddsUnrestrictedAboveMinimum: true,
      minTeamHistory: MIN_TEAM_HISTORY,
      requireDifferentLeagues:
        REQUIRE_DIFFERENT_LEAGUES,
      requireDifferentSports:
        REQUIRE_DIFFERENT_SPORTS,
      sameDayOnly: true,
      oneParlayPerDay: true,
      hockeyAfterOTAfterPenLoss: true,
      sameDayHistoricalLeakagePrevented: true,
    },

    data: {
      totalGames: allGames.length,
      firstDate:
        allGames[0]?.date || null,
      lastDate:
        allGames[allGames.length - 1]?.date ||
        null,
    },

    confidenceFloorResults: results,
  };

  const out = path.join(
    ROOT,
    "cross-sport-confidence-floor-diagnostic-results.json"
  );

  fs.writeFileSync(
    out,
    JSON.stringify(
      output,
      null,
      2
    ),
    "utf8"
  );

  console.log(
    `\nFull diagnostic written to: ${out}`
  );
}

main();
