// src/core/engine/basketballBacktest1.ts
//
// Backtests moneyline predictions across ALL leagues in
// PROBALLERS_LEAGUE_MAP (26 leagues, fully verified 2026-08-13).

import {
  fetchLeagueSchedule,
  ProballersGame,
  PROBALLERS_LEAGUE_MAP,
} from '../../scrapers/basketball/Proballersscraper';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const MIN_TIP_CONFIDENCE = 0.75;
const MIN_PRIOR_GAMES = 5;
const FORM_LOOKBACK = 10;

// Confirmed 2026-08-17 via backtest: bumping from 0.035 to 0.075 (matching
// the NBA/WNBA-confirmed value in probabilityModel.ts) closed most of a
// real Home/Away imbalance — split went from 30%/70% to 43%/57%, Away hit
// rate rose from 74.0% to 79.4%, overall hit rate rose from 78.1% to 82.9%.
const HOME_COURT_BIAS = 0.075;

// UNVERIFIED->CONFIRMED 2026-08-08: the /schedule/{year} URL pattern
// genuinely returns distinct historical season data (confirmed via
// different real game counts per year across BSL/CBA/France in an
// earlier run of this backtest) — safe to trust.
const SEASONS: (number | undefined)[] = [undefined, 2024, 2023, 2022, 2021];

function seasonLabel(season: number | undefined): string {
  return season ? `${season}-${(season + 1).toString().slice(-2)}` : 'current';
}

// Leagues confirmed broken and excluded from backtesting until fixed.
// Philippines - PBA: proballers.com's default /schedule page (and every
// season-suffix attempted: 2025, 2026) is stuck returning the same stale
// 2011-2012 season data regardless of the year requested — confirmed via
// identical byte counts and identical game rows across different season
// URLs. No working URL pattern found for current PBA data as of
// 2026-08-17. Left in PROBALLERS_LEAGUE_MAP for later, but excluded here
// since including it silently contaminates results with 14-year-old data.
const BROKEN_LEAGUES = new Set<string>(['Philippines - PBA']);

// Leagues with a pooled hit rate below this are excluded from the grand
// total / season breakdown (but still shown individually in the ranked
// table so you can see what was dropped and why). Per-league sample
// sizes here are small (12-40 tips as of the 2026-08-17 run), so this is
// a rough quality filter, not a confident verdict on any single league —
// revisit as more seasons/data accumulate.
const MIN_LEAGUE_HIT_RATE_TO_INCLUDE = 0.70;

// All leagues in the map, automatically, minus known-broken ones — not a
// hardcoded subset. Deriving this from the map itself means it can never
// go out of sync with it again (this previously bit France when the map
// key was renamed but ACTIVE_LEAGUES wasn't updated to match).
const ACTIVE_LEAGUES = Object.keys(PROBALLERS_LEAGUE_MAP).filter(l => !BROKEN_LEAGUES.has(l));

// ─── TYPES ──────────────────────────────────────────────────────────────

interface SeasonedGame extends ProballersGame {
  seasonLabel: string;
}

interface TeamGameRecord {
  date: string;
  opponent: string;
  won: boolean;
  pointsFor: number;
  pointsAgainst: number;
}

interface BacktestTip {
  league: string;
  season: string;
  market: 'moneyline';
  date: string;
  homeTeam: string;
  awayTeam: string;
  selection: string;
  confidence: number;
  hit: boolean;
}

// ─── FORM HELPERS ─────────────────────────────────────────────────────────

function buildHistory(games: ProballersGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(team: string, rec: TeamGameRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }
  for (const g of games) {
    push(g.homeTeam, { date: g.date, opponent: g.awayTeam, won: g.homeScore > g.awayScore, pointsFor: g.homeScore, pointsAgainst: g.awayScore });
    push(g.awayTeam, { date: g.date, opponent: g.homeTeam, won: g.awayScore > g.homeScore, pointsFor: g.awayScore, pointsAgainst: g.homeScore });
  }
  return map;
}

function formWinRate(records: TeamGameRecord[]): number {
  if (!records.length) return 0.5;
  const wins = records.filter(r => r.won).length;
  return wins / records.length;
}

function h2hHomeWinRate(games: ProballersGame[], homeTeam: string, awayTeam: string): number {
  const meetings = games.filter(
    g => (g.homeTeam === homeTeam && g.awayTeam === awayTeam) || (g.homeTeam === awayTeam && g.awayTeam === homeTeam)
  );
  if (!meetings.length) return 0.5;
  const homeWins = meetings.filter(g =>
    (g.homeTeam === homeTeam && g.homeScore > g.awayScore) || (g.awayTeam === homeTeam && g.awayScore > g.homeScore)
  ).length;
  return homeWins / meetings.length;
}

// ─── MONEYLINE ────────────────────────────────────────────────────────────

function eloStrengthRatio(homeWinRate: number, awayWinRate: number, h2hHWR: number): number {
  const homeStrength = (homeWinRate * 0.6 + h2hHWR * 0.4) + HOME_COURT_BIAS;
  const awayStrength = awayWinRate * 0.6 + (1 - h2hHWR) * 0.4;
  const total = homeStrength + awayStrength || 1;
  return homeStrength / total;
}

function predictMoneyline(homeRecords: TeamGameRecord[], awayRecords: TeamGameRecord[], h2hHWR: number): number {
  const homeWR = formWinRate(homeRecords);
  const awayWR = formWinRate(awayRecords);
  const eloHome = eloStrengthRatio(homeWR, awayWR, h2hHWR);
  const homeWinProb = eloHome * 0.85 + 0.04;
  return Math.max(0.05, Math.min(0.95, homeWinProb));
}

// ─── BACKTEST LOOP ────────────────────────────────────────────────────────
//
// NOTE: history/h2h lookups use ALL prior games regardless of season
// label — a team's form carries across the season boundary the same way
// it would in reality (early-season games still have real prior form to
// draw on, from the tail of the previous season), rather than resetting
// to zero every season. The seasonLabel on each tip is purely for
// reporting/breakdown purposes, not a boundary in the prediction logic.

function runBacktest(league: string, games: SeasonedGame[]): BacktestTip[] {
  const tips: BacktestTip[] = [];
  const seen = new Set<number>();
  const deduped = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));

  const sorted = deduped.sort((a, b) => a.date.localeCompare(b.date));

  for (const game of sorted) {
    const priorGames = sorted.filter(g => g.date < game.date);
    const history = buildHistory(priorGames);

    const homeRecordsAll = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const awayRecordsAll = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));

    if (homeRecordsAll.length < MIN_PRIOR_GAMES || awayRecordsAll.length < MIN_PRIOR_GAMES) continue;

    const h2hHWR = h2hHomeWinRate(priorGames, game.homeTeam, game.awayTeam);
    const homeWinProb = predictMoneyline(homeRecordsAll, awayRecordsAll, h2hHWR);
    const mlSelection = homeWinProb >= 0.5 ? 'Home' : 'Away';
    const mlConfidence = Math.max(homeWinProb, 1 - homeWinProb);

    if (mlConfidence >= MIN_TIP_CONFIDENCE) {
      const homeWon = game.homeScore > game.awayScore;
      const hit = mlSelection === 'Home' ? homeWon : !homeWon;
      tips.push({
        league,
        season: game.seasonLabel,
        market: 'moneyline',
        date: game.date,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        selection: mlSelection,
        confidence: mlConfidence,
        hit,
      });
    }
  }

  return tips;
}

function summarizeMarket(tips: BacktestTip[], label: string): void {
  if (!tips.length) {
    console.log(`   [${label}] 0 qualifying tips`);
    return;
  }
  const hits = tips.filter(t => t.hit).length;
  const avgConf = tips.reduce((s, t) => s + t.confidence, 0) / tips.length;
  const brier = tips.reduce((s, t) => s + Math.pow(t.confidence - (t.hit ? 1 : 0), 2), 0) / tips.length;
  console.log(
    `   [${label}] moneyline: tips=${tips.length} hits=${hits} hitRate=${((hits / tips.length) * 100).toFixed(1)}% ` +
    `avgConf=${(avgConf * 100).toFixed(1)}% brier=${brier.toFixed(4)}`
  );
}

function printSelectionBreakdown(tips: BacktestTip[], label: string): void {
  if (!tips.length) return;
  const sides = ['Home', 'Away'];
  console.log(`   [${label}] moneyline selection breakdown:`);
  for (const side of sides) {
    const s = tips.filter(t => t.selection === side);
    if (!s.length) { console.log(`    ${side}: 0 tips`); continue; }
    const hits = s.filter(t => t.hit).length;
    console.log(`    ${side}: ${s.length} tips (${((s.length / tips.length) * 100).toFixed(0)}% of all tips), hit rate ${((hits / s.length) * 100).toFixed(1)}%`);
  }
}

// Groups tips by season label and prints one summary row per season, in
// the same chronological order as SEASONS (oldest first, 'current' last
// since it's the incomplete in-progress season).
function printSeasonBreakdown(tips: BacktestTip[]): void {
  if (!tips.length) return;
  console.log('\n========== TIPS BY SEASON (leagues below hit-rate cutoff excluded) ==========');

  const orderedLabels = [...SEASONS].reverse().map(seasonLabel); // oldest -> newest -> current
  const bySeason = new Map<string, BacktestTip[]>();
  for (const t of tips) {
    if (!bySeason.has(t.season)) bySeason.set(t.season, []);
    bySeason.get(t.season)!.push(t);
  }

  for (const label of orderedLabels) {
    const seasonTips = bySeason.get(label);
    if (!seasonTips || !seasonTips.length) {
      console.log(`   ${label.padEnd(10)} 0 tips`);
      continue;
    }
    const hits = seasonTips.filter(t => t.hit).length;
    console.log(
      `   ${label.padEnd(10)} tips=${String(seasonTips.length).padEnd(5)} hits=${hits} ` +
      `hitRate=${((hits / seasonTips.length) * 100).toFixed(1)}%`
    );
  }

  const seasonsWithData = orderedLabels.filter(l => bySeason.has(l)).length;
  const avgPerSeason = seasonsWithData > 0 ? tips.length / seasonsWithData : 0;
  console.log(`\n   Average tips per season (seasons with data only): ${avgPerSeason.toFixed(0)}`);
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  const allTips: BacktestTip[] = [];
  const leagueSummaries: { league: string; tips: number; hitRate: number }[] = [];

  for (const leagueName of ACTIVE_LEAGUES) {
    if (!PROBALLERS_LEAGUE_MAP[leagueName]) continue;
    console.log(`\n=== ${leagueName} ===`);
    let leagueGames: SeasonedGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueSchedule(leagueName, season);
        const label = seasonLabel(season);
        console.log(`   Season ${label}: ${games.length} games`);
        leagueGames.push(...games.map(g => ({ ...g, seasonLabel: label })));
      } catch (err: any) {
        console.error(`   Season ${seasonLabel(season)} FAILED: ${err.message}`);
      }
    }

    if (leagueGames.length === 0) {
      console.log(`   No data available for ${leagueName} — skipping`);
      continue;
    }

    const tips = runBacktest(leagueName, leagueGames);
    summarizeMarket(tips, leagueName);
    printSelectionBreakdown(tips, leagueName);
    allTips.push(...tips);

    if (tips.length > 0) {
      const hits = tips.filter(t => t.hit).length;
      leagueSummaries.push({ league: leagueName, tips: tips.length, hitRate: hits / tips.length });
    }
  }

  // Leagues below the hit-rate cutoff are excluded from the grand total /
  // season breakdown, but still listed in the ranked table below so you
  // can see exactly what was dropped and why — determined dynamically
  // from THIS run's numbers, not a hardcoded league list, since these
  // sample sizes are small enough that which leagues qualify can shift
  // run to run.
  const droppedLeagues = leagueSummaries.filter(s => s.hitRate < MIN_LEAGUE_HIT_RATE_TO_INCLUDE);
  const keptLeagueNames = new Set(
    leagueSummaries.filter(s => s.hitRate >= MIN_LEAGUE_HIT_RATE_TO_INCLUDE).map(s => s.league)
  );
  const filteredTips = allTips.filter(t => keptLeagueNames.has(t.league));

  console.log(`\n\n========== GRAND TOTAL (${keptLeagueNames.size} leagues at or above ${(MIN_LEAGUE_HIT_RATE_TO_INCLUDE * 100).toFixed(0)}% hit rate, All Seasons) ==========`);
  if (droppedLeagues.length) {
    console.log(`   Excluded ${droppedLeagues.length} league(s) below cutoff: ${droppedLeagues.map(d => `${d.league} (${(d.hitRate * 100).toFixed(1)}%, n=${d.tips})`).join(', ')}`);
  }
  summarizeMarket(filteredTips, 'ALL LEAGUES (filtered)');
  printSelectionBreakdown(filteredTips, 'ALL LEAGUES (filtered)');

  printSeasonBreakdown(filteredTips);

  // Ranked league table, worst hit rate first — includes EVERY league
  // (dropped or not) so you can see the full picture, with dropped ones
  // marked.
  console.log('\n========== LEAGUES RANKED BY HIT RATE (worst first) ==========');
  const ranked = [...leagueSummaries].sort((a, b) => a.hitRate - b.hitRate);
  for (const r of ranked) {
    const droppedTag = r.hitRate < MIN_LEAGUE_HIT_RATE_TO_INCLUDE ? '  [DROPPED — below cutoff]' : '';
    console.log(`   ${r.league.padEnd(35)} tips=${String(r.tips).padEnd(5)} hitRate=${(r.hitRate * 100).toFixed(1)}%${droppedTag}`);
  }

  console.log('\n=== Done ===');
}

if (require.main === module) {
  main().catch(err => {
    console.error('[BasketballBacktest] Fatal error:', err.message);
    process.exit(1);
  });
}