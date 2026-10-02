/**
 * crossSportSeasonDiagnosticBacktest.ts
 *
 * Season-by-season diagnostic for the cross-sport model.
 *
 * Reports BOTH single bets and one same-day 2-leg parlay per calendar day.
 * Parlay legs may be hockey+hockey, basketball+basketball, or mixed.
 *
 * Also reports peak cumulative profit and maximum drawdown for singles
 * and parlays, plus season-by-season and season x league breakdowns.
 *
 * Uses the project's existing probabilityModel.ts.
 *
 * Run:
 *   npx ts-node .\src\core\engine\crossSportSeasonDiagnosticBacktest.ts
 *
 * Optional environment variables:
 *   ODDS_MIN=1.25
 *   ODDS_MAX=1.65
 *   CONFIDENCE_FLOOR=0.70
 *   MIN_TEAM_HISTORY=5
 *   STAKE_SINGLE=10000
 *   STAKE_PARLAY=10000
 *   REQUIRE_DIFFERENT_LEAGUES=0
 *   REQUIRE_DIFFERENT_SPORTS=0
 */

import * as fs from "fs";
import * as path from "path";
import { getProbabilities } from "./probabilityModel";

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

const ROOT = process.cwd();

const STAKE_SINGLE = Number(process.env.STAKE_SINGLE || 10000);
const STAKE_PARLAY = Number(process.env.STAKE_PARLAY || 10000);
const CONFIDENCE_FLOOR = Number(process.env.CONFIDENCE_FLOOR || 0.70);
const ODDS_MIN = Number(process.env.ODDS_MIN || 1.25);
const ODDS_MAX = Number(process.env.ODDS_MAX || 1.65);
const MIN_TEAM_HISTORY = Number(process.env.MIN_TEAM_HISTORY || 5);
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
  { file: "hockeyallsvenskan_all.csv", league: "HOCKEYALLSVENSKAN", sport: "hockey" },
  { file: "icehl_all.csv", league: "ICEHL", sport: "hockey" },
  { file: "khl_all.csv", league: "KHL", sport: "hockey" },
  { file: "liiga_all.csv", league: "LIIGA", sport: "hockey" },
  { file: "mestis_all.csv", league: "MESTIS", sport: "hockey" },
  { file: "nhl_all.csv", league: "NHL", sport: "hockey" },
  { file: "shl_all.csv", league: "SHL", sport: "hockey" },
];

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
  return x.trim().replace(/^"|"$/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getColumnMap(header: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  header.forEach((h, i) => { map[normaliseHeader(h)] = i; });
  return map;
}

function col(map: Record<string, number>, aliases: string[], file: string): number {
  for (const alias of aliases) {
    const idx = map[normaliseHeader(alias)];
    if (idx !== undefined) return idx;
  }
  throw new Error(`${file}: missing required CSV column for ${aliases[0]}`);
}

function readGames(filename: string, league: string, sport: Sport): Game[] {
  const full = path.join(ROOT, filename);
  if (!fs.existsSync(full)) throw new Error(`file not found: .\\${filename}`);

  const lines = fs.readFileSync(full, "utf8").split(/\r?\n/).filter(x => x.trim());
  if (lines.length < 2) return [];

  const m = getColumnMap(parseCsvLine(lines[0]));
  const date = col(m, ["Date", "GameDate"], filename);
  const tournament = col(m, ["Tournament", "League", "Competition"], filename);
  const stage = col(m, ["Stage"], filename);
  const status = col(m, ["Status"], filename);
  const home = col(m, ["Home_Team", "HomeTeam", "Home"], filename);
  const homeScore = col(m, ["Home_Score", "HomeScore", "HomePoints"], filename);
  const away = col(m, ["Away_Team", "AwayTeam", "Away"], filename);
  const awayScore = col(m, ["Away_Score", "AwayScore", "AwayPoints"], filename);
  const homeOdds = col(m, ["Home_Odds", "HomeOdds", "HomePrice"], filename);
  const awayOdds = col(m, ["Away_Odds", "AwayOdds", "AwayPrice"], filename);

  const games: Game[] = [];
  for (let i = 1; i < lines.length; i++) {
    const p = parseCsvLine(lines[i]);
    const hs = Number(p[homeScore]), as = Number(p[awayScore]);
    const ho = Number(p[homeOdds]), ao = Number(p[awayOdds]);
    if (!p[date] || !p[tournament] || !p[home] || !p[away] ||
        !Number.isFinite(hs) || !Number.isFinite(as) ||
        !Number.isFinite(ho) || !Number.isFinite(ao)) continue;

    games.push({
      date: p[date], tournament: p[tournament], stage: p[stage] || "",
      status: p[status] || "Finished", home: p[home], homeScore: hs,
      away: p[away], awayScore: as, homeOdds: ho, awayOdds: ao,
      sport, league
    });
  }
  return games;
}

function seasonFromTournament(tournament: string): string {
  const m = tournament.match(/(\d{4}\/\d{4})/);
  return m ? m[1] : tournament || "UNKNOWN";
}

/*
 * Adapter for the existing project probability model.
 * If probabilityModel.ts has a different return property shape, only this
 * function needs adjustment.
 */
function modelProbability(g: Game, pickHome: boolean): number {
  // probabilityModel.ts expects the match object under `input.match`.
  // The previous version passed these fields at the top level, which caused
  // getProbabilities() to receive input.match === undefined.
  const result = getProbabilities({
    match: {
      homeTeam: g.home,
      awayTeam: g.away,
      sport: g.sport,
      date: g.date,
    },
  } as any);

  const r: any = result;
  const hp =
    typeof r.home === "number" ? r.home :
    typeof r.homeProbability === "number" ? r.homeProbability :
    typeof r.homeWinProbability === "number" ? r.homeWinProbability : NaN;

  const ap =
    typeof r.away === "number" ? r.away :
    typeof r.awayProbability === "number" ? r.awayProbability :
    typeof r.awayWinProbability === "number" ? r.awayWinProbability : NaN;

  const p = pickHome ? hp : ap;
  if (!Number.isFinite(p)) {
    throw new Error(
      "Could not read home/away probability from getProbabilities() result. " +
      "Adapt modelProbability() to the existing probabilityModel.ts return shape."
    );
  }
  return p > 1 ? p / 100 : p;
}

function settlesWin(g: Game, pickHome: boolean): boolean {
  if (g.sport === "hockey" && /After OT|After Pen\.?/i.test(g.status)) {
    return false;
  }
  if (g.homeScore === g.awayScore) return false;
  return pickHome ? g.homeScore > g.awayScore : g.awayScore > g.homeScore;
}

function makeLeg(g: Game, pickHome: boolean): Leg | null {
  const odds = pickHome ? g.homeOdds : g.awayOdds;
  if (!Number.isFinite(odds) || odds < ODDS_MIN || odds > ODDS_MAX) return null;

  const p = modelProbability(g, pickHome);
  if (p < CONFIDENCE_FLOOR) return null;

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
  if (a.modelProbability !== b.modelProbability)
    return a.modelProbability > b.modelProbability ? a : b;
  if (a.edge !== b.edge) return a.edge > b.edge ? a : b;
  return a.odds < b.odds ? a : b;
}

function calcProfit(odds: number, stake: number, win: boolean): number {
  return win ? stake * (odds - 1) : -stake;
}

function roi(profit: number, staked: number): number {
  return staked ? profit / staked * 100 : 0;
}

function pct(wins: number, n: number): number {
  return n ? wins / n * 100 : 0;
}

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}₦${Math.round(Math.abs(n)).toLocaleString("en-NG")}`;
}

function peakAndDrawdown(bets: Array<{ date: string; profit: number }>) {
  let cumulative = 0, peak = 0, peakDate = "", peakBet = 0, maxDrawdown = 0;
  bets.forEach((b, i) => {
    cumulative += b.profit;
    if (cumulative > peak) {
      peak = cumulative;
      peakDate = b.date;
      peakBet = i + 1;
    }
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  });
  return { finalProfit: cumulative, peakProfit: peak, peakDate, peakBet, maxDrawdown };
}

function main() {
  console.log("=== CROSS-SPORT SEASON DIAGNOSTIC BACKTEST ===");
  console.log(`Stake/single: ${money(STAKE_SINGLE)}`);
  console.log(`Stake/day parlay: ${money(STAKE_PARLAY)}`);
  console.log(`Confidence floor: ${CONFIDENCE_FLOOR}`);
  console.log(`Odds range: ${ODDS_MIN}-${ODDS_MAX}`);
  console.log(`Minimum team history: ${MIN_TEAM_HISTORY}`);
  console.log(`Different leagues required: ${REQUIRE_DIFFERENT_LEAGUES}`);
  console.log(`Different sports required: ${REQUIRE_DIFFERENT_SPORTS}`);
  console.log("Hockey After OT / After Pen.: LOSS for regulation Home/Away bet");

  const allGames: Game[] = [];
  for (const cfg of FILES) {
    try {
      const games = readGames(cfg.file, cfg.league, cfg.sport);
      allGames.push(...games);
      console.log(`${cfg.sport.toUpperCase()} ${cfg.league}: ${games.length.toLocaleString()} games loaded`);
    } catch (e) {
      console.error(`FAILED ${cfg.league}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  allGames.sort((a, b) => a.date.localeCompare(b.date));

  const teamHistory = new Map<string, number>();
  const qualifyingLegs: Leg[] = [];

  for (const g of allGames) {
    const hk = `${g.sport}|${g.league}|${g.home}`;
    const ak = `${g.sport}|${g.league}|${g.away}`;
    const hh = teamHistory.get(hk) || 0;
    const ah = teamHistory.get(ak) || 0;

    if (hh >= MIN_TEAM_HISTORY && ah >= MIN_TEAM_HISTORY) {
      const h = makeLeg(g, true);
      const a = makeLeg(g, false);
      const leg = h && a ? betterLeg(h, a) : (h || a);
      if (leg) qualifyingLegs.push(leg);
    }

    teamHistory.set(hk, hh + 1);
    teamHistory.set(ak, ah + 1);
  }

  console.log(`Total games: ${allGames.length.toLocaleString()}`);
  if (allGames.length) console.log(`Date range: ${allGames[0].date} -> ${allGames[allGames.length - 1].date}`);
  console.log(`Qualifying single legs: ${qualifyingLegs.length}`);

  const singles: BetResult[] = qualifyingLegs.map(l => ({
    date: l.date, season: seasonFromTournament(l.tournament), league: l.league,
    sport: l.sport, odds: l.odds, modelProbability: l.modelProbability,
    edge: l.edge, win: l.win, profit: calcProfit(l.odds, STAKE_SINGLE, l.win)
  }));

  const ss = peakAndDrawdown(singles);
  const singleWins = singles.filter(x => x.win).length;
  console.log("\n=== SINGLE-BET RESULT ===");
  console.log(`Qualifying singles: ${singles.length}`);
  console.log(`Wins: ${singleWins} (${pct(singleWins, singles.length).toFixed(2)}%)`);
  console.log(`Losses: ${singles.length - singleWins}`);
  console.log(`Total staked: ${money(singles.length * STAKE_SINGLE)}`);
  console.log(`Final profit/loss: ${money(ss.finalProfit)}`);
  console.log(`FINAL ROI: ${roi(ss.finalProfit, singles.length * STAKE_SINGLE).toFixed(2)}%`);
  console.log(`Peak cumulative profit: ${money(ss.peakProfit)}`);
  console.log(`Peak occurred: ${ss.peakDate || "N/A"} at single #${ss.peakBet || 0}`);
  console.log(`Maximum drawdown: ${money(ss.maxDrawdown)}`);

  const byDate = new Map<string, Leg[]>();
  for (const leg of qualifyingLegs) {
    if (!byDate.has(leg.date)) byDate.set(leg.date, []);
    byDate.get(leg.date)!.push(leg);
  }

  const parlays: ParlayResult[] = [];
  for (const [date, legs] of [...byDate.entries()].sort()) {
    let bestPair: [Leg, Leg] | null = null;
    let bestScore = -Infinity;

    for (let i = 0; i < legs.length; i++) {
      for (let j = i + 1; j < legs.length; j++) {
        const a = legs[i], b = legs[j];
        if (REQUIRE_DIFFERENT_LEAGUES && a.league === b.league) continue;
        if (REQUIRE_DIFFERENT_SPORTS && a.sport === b.sport) continue;

        const score = a.modelProbability * b.modelProbability;
        if (score > bestScore) {
          bestScore = score;
          bestPair = [a, b];
        }
      }
    }

    if (!bestPair) continue;
    const [a, b] = bestPair;
    const combinedOdds = a.odds * b.odds;
    const win = a.win && b.win;

    parlays.push({
      number: parlays.length + 1,
      date,
      season: seasonFromTournament(a.tournament),
      leg1: a, leg2: b, combinedOdds, win,
      profit: calcProfit(combinedOdds, STAKE_PARLAY, win)
    });
  }

  const ps = peakAndDrawdown(parlays);
  const parlayWins = parlays.filter(x => x.win).length;
  const avgCombined = parlays.length
    ? parlays.reduce((s, x) => s + x.combinedOdds, 0) / parlays.length : 0;

  console.log("\n=== 2-LEG SAME-DAY PARLAY RESULT ===");
  console.log("Rule: exactly one parlay per calendar day; same-day legs only.");
  console.log(`2-leg parlays: ${parlays.length}`);
  console.log(`Wins: ${parlayWins} (${pct(parlayWins, parlays.length).toFixed(2)}%)`);
  console.log(`Losses: ${parlays.length - parlayWins}`);
  console.log(`Average combined odds: ${avgCombined.toFixed(3)}`);
  console.log(`Maximum combined odds: ${parlays.length ? Math.max(...parlays.map(x => x.combinedOdds)).toFixed(3) : "0.000"}`);
  console.log(`Total staked: ${money(parlays.length * STAKE_PARLAY)}`);
  console.log(`Final profit/loss: ${money(ps.finalProfit)}`);
  console.log(`FINAL ROI: ${roi(ps.finalProfit, parlays.length * STAKE_PARLAY).toFixed(2)}%`);
  console.log(`Peak cumulative profit: ${money(ps.peakProfit)}`);
  console.log(`Peak occurred: ${ps.peakDate || "N/A"} at parlay #${ps.peakBet || 0}`);
  console.log(`Maximum drawdown: ${money(ps.maxDrawdown)}`);

  // Season aggregates.
  type SeasonAgg = { singles: BetResult[]; parlays: ParlayResult[] };
  const seasons = new Map<string, SeasonAgg>();
  const ensure = (s: string) => {
    if (!seasons.has(s)) seasons.set(s, { singles: [], parlays: [] });
    return seasons.get(s)!;
  };
  for (const s of singles) ensure(s.season).singles.push(s);
  for (const p of parlays) ensure(p.season).parlays.push(p);

  console.log("\n=== SEASON-BY-SEASON RESULTS ===");
  console.log("Season       Singles S-Win%  S-P/L        S-ROI   Parlays P-Win%  P-P/L        P-ROI");
  console.log("------------------------------------------------------------------------------------------");

  const seasonRows: any[] = [];
  for (const [season, a] of [...seasons.entries()].sort()) {
    const sw = a.singles.filter(x => x.win).length;
    const pw = a.parlays.filter(x => x.win).length;
    const sp = a.singles.reduce((s, x) => s + x.profit, 0);
    const pp = a.parlays.reduce((s, x) => s + x.profit, 0);
    console.log(
      `${season.padEnd(12)} ${String(a.singles.length).padStart(7)} ` +
      `${pct(sw, a.singles.length).toFixed(2).padStart(6)}% ` +
      `${money(sp).padStart(12)} ${roi(sp, a.singles.length * STAKE_SINGLE).toFixed(2).padStart(8)}% ` +
      `${String(a.parlays.length).padStart(8)} ` +
      `${pct(pw, a.parlays.length).toFixed(2).padStart(6)}% ` +
      `${money(pp).padStart(12)} ${roi(pp, a.parlays.length * STAKE_PARLAY).toFixed(2).padStart(8)}%`
    );
    seasonRows.push({
      season,
      singles: a.singles.length, singleWins: sw,
      singleLosses: a.singles.length - sw,
      singleWinRate: pct(sw, a.singles.length),
      singleStaked: a.singles.length * STAKE_SINGLE,
      singleProfit: sp, singleROI: roi(sp, a.singles.length * STAKE_SINGLE),
      parlays: a.parlays.length, parlayWins: pw,
      parlayLosses: a.parlays.length - pw,
      parlayWinRate: pct(pw, a.parlays.length),
      parlayStaked: a.parlays.length * STAKE_PARLAY,
      parlayProfit: pp, parlayROI: roi(pp, a.parlays.length * STAKE_PARLAY)
    });
  }

  // Season x league detail for singles.
  type SL = { sport: Sport; bets: BetResult[] };
  const sl = new Map<string, SL>();
  for (const s of singles) {
    const key = `${s.season}|${s.league}`;
    if (!sl.has(key)) sl.set(key, { sport: s.sport, bets: [] });
    sl.get(key)!.bets.push(s);
  }

  console.log("\n=== SEASON × LEAGUE SINGLE-BET BREAKDOWN ===");
  console.log("Season       League                Sport        Bets Win%   AvgOdds      P/L       ROI");
  console.log("------------------------------------------------------------------------------------------");

  const seasonLeagueRows: any[] = [];
  for (const [key, a] of [...sl.entries()].sort()) {
    const [season, league] = key.split("|");
    const w = a.bets.filter(x => x.win).length;
    const p = a.bets.reduce((s, x) => s + x.profit, 0);
    const avg = a.bets.reduce((s, x) => s + x.odds, 0) / a.bets.length;
    console.log(
      `${season.padEnd(12)} ${league.padEnd(20)} ${a.sport.padEnd(12)} ` +
      `${String(a.bets.length).padStart(4)} ${pct(w, a.bets.length).toFixed(1).padStart(5)}% ` +
      `${avg.toFixed(3).padStart(8)} ${money(p).padStart(12)} ` +
      `${roi(p, a.bets.length * STAKE_SINGLE).toFixed(2).padStart(8)}%`
    );
    seasonLeagueRows.push({
      season, league, sport: a.sport, bets: a.bets.length, wins: w,
      losses: a.bets.length - w, winRate: pct(w, a.bets.length),
      avgOdds: avg, profit: p, ROI: roi(p, a.bets.length * STAKE_SINGLE)
    });
  }

  console.log("\n=== LAST 10 SAME-DAY PARLAYS ===");
  for (const p of parlays.slice(-10)) {
    console.log(
      `#${p.number} ${p.date} | ${p.leg1.league}:${p.leg1.team}@${p.leg1.odds.toFixed(2)}${p.leg1.win ? "✓" : "✗"} + ` +
      `${p.leg2.league}:${p.leg2.team}@${p.leg2.odds.toFixed(2)}${p.leg2.win ? "✓" : "✗"} | ` +
      `${p.win ? "WIN" : "LOSS"} | ${money(p.profit)}`
    );
  }

  const output = {
    config: {
      stakeSingle: STAKE_SINGLE, stakeParlay: STAKE_PARLAY,
      confidenceFloor: CONFIDENCE_FLOOR, oddsMin: ODDS_MIN, oddsMax: ODDS_MAX,
      minTeamHistory: MIN_TEAM_HISTORY,
      requireDifferentLeagues: REQUIRE_DIFFERENT_LEAGUES,
      requireDifferentSports: REQUIRE_DIFFERENT_SPORTS,
      sameDayOnly: true, oneParlayPerDay: true,
      hockeyAfterOTAfterPenLoss: true
    },
    overall: {
      totalGames: allGames.length,
      qualifyingSingles: singles.length,
      singleWins, singleLosses: singles.length - singleWins,
      singleStaked: singles.length * STAKE_SINGLE,
      singleProfit: ss.finalProfit,
      singleROI: roi(ss.finalProfit, singles.length * STAKE_SINGLE),
      singlePeakProfit: ss.peakProfit, singlePeakDate: ss.peakDate,
      singlePeakBet: ss.peakBet, singleMaxDrawdown: ss.maxDrawdown,
      parlays: parlays.length, parlayWins, parlayLosses: parlays.length - parlayWins,
      parlayStaked: parlays.length * STAKE_PARLAY,
      parlayProfit: ps.finalProfit,
      parlayROI: roi(ps.finalProfit, parlays.length * STAKE_PARLAY),
      parlayPeakProfit: ps.peakProfit, parlayPeakDate: ps.peakDate,
      parlayPeakNumber: ps.peakBet, parlayMaxDrawdown: ps.maxDrawdown
    },
    seasons: seasonRows,
    seasonLeague: seasonLeagueRows,
    parlays
  };

  const out = path.join(ROOT, "cross-sport-season-diagnostic-results.json");
  fs.writeFileSync(out, JSON.stringify(output, null, 2), "utf8");
  console.log(`\nFull season diagnostic written to: ${out}`);
}

main();
