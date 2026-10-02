// src/core/engine/hockeyBacktest1.ts
//
// Backtests moneyline predictions across ALL 14 leagues confirmed
// working in ELITEPROSPECTS_LEAGUE_MAP (verified 2026-08-31/09-01 — see
// eliteProspectsScraper.ts's header for the verification history).
// Mirrors basketballBacktest1.ts's structure and reasoning closely; see
// that file for the fuller original commentary on each design choice.
//
// NO ODDS/ROI here — see hockeyOddsBacktestNHL.ts for the real ROI
// backtest, which imports several functions/constants from this file
// (hence the exports below) so both scripts use the EXACT SAME
// prediction logic rather than two independently-drifting versions.
//
// SEASON STRINGS: unlike Proballers' single-year params, EliteProspects
// uses "YYYY-YYYY". Confirmed real data across a full run 2026-09-04:
// 2025-2026, 2024-2025, 2023-2024, and 2022-2023 all returned real games
// for all 14 leagues.
//
// FIXED 2026-09-14: predictMoneyline() below used to maintain its OWN
// hand-duplicated copy of the raw ELO formula (a local eloStrengthRatio()
// plus inline "eloHome * 0.85 + 0.04" compression), completely separate
// from probabilityModel.ts's modelHockey(). That's exactly the kind of
// drift this file's own header comment above warns hockeyOddsBacktestNHL.ts
// against — it just didn't apply the same discipline to ITSELF relative
// to probabilityModel.ts. Consequence: when modelHockey()'s home-ice
// placement was fixed the same night (see probabilityModel.ts's
// computeHockeyRawMoneylineProb() comment for the full story), this
// file's copy was untouched, and a same-night isotonic refit
// (hockeyIsotonicFit.ts imports predictMoneyline() from HERE) came back
// byte-for-byte identical to the pre-fix calibration table — silently
// recalibrating the OLD, still-broken formula instead of the fixed one.
// Fix: predictMoneyline() now calls computeHockeyRawMoneylineProb()
// directly from probabilityModel.ts instead of re-deriving the formula.
// There is now exactly ONE copy of this formula in the codebase — any
// future change to it is automatically picked up by both production
// (modelHockey) and every backtest/fit script that imports from this
// file, with no way for the two to silently diverge again.

import {
  fetchLeagueScores,
  EPGame,
  ELITEPROSPECTS_LEAGUE_MAP,
} from '../../scrapers/hockey/eliteProspectsScraper';
import { computeHockeyRawMoneylineProb, HOCKEY_HOME_ICE_ADVANTAGE } from './probabilityModel';

// ─── CONFIG ─────────────────────────────────────────────────────────────

export const MIN_TIP_CONFIDENCE = 0.75;
export const MIN_PRIOR_GAMES = 5;

// Re-exported from probabilityModel.ts (single source of truth as of the
// 2026-09-14 fix above) rather than declared here — kept under this same
// name so hockeyOddsBacktestNHL.ts's existing `import { HOME_ICE_ADVANTAGE }
// from './hockeyBacktest1'` (or similar) doesn't need to change. Starting
// value, NOT independently backtested/tuned yet, unlike basketball's
// 0.075 which was confirmed via a real before/after Home/Away split
// test. Confirmed 2026-09-04: a real, consistent Home>Away hit-rate skew
// showed up across nearly every one of the 14 leagues in the full
// backtest run — strong candidate for tuning upward, not yet done.
export const HOME_ICE_ADVANTAGE = HOCKEY_HOME_ICE_ADVANTAGE;

// Confirmed real data sources as of the 2026-09-04 full run — all four
// seasons returned real games for all 14 leagues, no guessing needed.
const SEASONS: string[] = ['2025-2026', '2024-2025', '2023-2024', '2022-2023'];

// No leagues confirmed broken — unlike Proballers' BROKEN_LEAGUES
// (Philippines - PBA, confirmed stuck on stale data), nothing like that
// has been found for these 14 hockey leagues.
const BROKEN_LEAGUES = new Set<string>([]);

// Leagues with a pooled hit rate below this are excluded from the grand
// total / season breakdown, same cutoff value and same reasoning as
// basketballBacktest1.ts — a rough quality filter given small early
// sample sizes, not a confident verdict on any single league.
const MIN_LEAGUE_HIT_RATE_TO_INCLUDE = 0.70;

const ACTIVE_LEAGUES = Object.keys(ELITEPROSPECTS_LEAGUE_MAP).filter(l => !BROKEN_LEAGUES.has(l));

// ─── TYPES ──────────────────────────────────────────────────────────────

interface SeasonedGame extends EPGame {
  seasonLabel: string;
}

export interface TeamGameRecord {
  date: string;
  opponent: string;
  won: boolean;
  goalsFor: number;
  goalsAgainst: number;
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

export function buildHistory(games: EPGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  function push(team: string, rec: TeamGameRecord) {
    if (!map.has(team)) map.set(team, []);
    map.get(team)!.push(rec);
  }
  for (const g of games) {
    if (!g.isCompleted) continue; // completed-only, same as Proballers implicitly assumes via its data source
    push(g.homeTeam, { date: g.date, opponent: g.awayTeam, won: g.homeScore! > g.awayScore!, goalsFor: g.homeScore!, goalsAgainst: g.awayScore! });
    push(g.awayTeam, { date: g.date, opponent: g.homeTeam, won: g.awayScore! > g.homeScore!, goalsFor: g.awayScore!, goalsAgainst: g.homeScore! });
  }
  return map;
}

function formWinRate(records: TeamGameRecord[]): number {
  if (!records.length) return 0.5;
  const wins = records.filter(r => r.won).length;
  return wins / records.length;
}

export function h2hHomeWinRate(games: EPGame[], homeTeam: string, awayTeam: string): number {
  const meetings = games.filter(
    g => g.isCompleted && ((g.homeTeam === homeTeam && g.awayTeam === awayTeam) || (g.homeTeam === awayTeam && g.awayTeam === homeTeam))
  );
  if (!meetings.length) return 0.5;
  const homeWins = meetings.filter(g =>
    (g.homeTeam === homeTeam && g.homeScore! > g.awayScore!) || (g.awayTeam === homeTeam && g.awayScore! > g.homeScore!)
  ).length;
  return homeWins / meetings.length;
}

// ─── MONEYLINE ────────────────────────────────────────────────────────────
// FIXED 2026-09-14: this used to compute the raw probability itself via
// a local eloStrengthRatio() + inline compression, duplicating
// probabilityModel.ts's formula. Now delegates entirely to
// computeHockeyRawMoneylineProb() (imported above) — see this file's
// header comment and that function's own comment in probabilityModel.ts
// for the full story of why this changed and what it prevents.
export function predictMoneyline(homeRecords: TeamGameRecord[], awayRecords: TeamGameRecord[], h2hHWR: number): number {
  const homeWR = formWinRate(homeRecords);
  const awayWR = formWinRate(awayRecords);
  return computeHockeyRawMoneylineProb(homeWR, awayWR, h2hHWR);
}

// ─── BACKTEST LOOP ────────────────────────────────────────────────────────

function runBacktest(league: string, games: SeasonedGame[]): BacktestTip[] {
  const tips: BacktestTip[] = [];
  const seen = new Set<number>();
  const deduped = games.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
  const completedOnly = deduped.filter(g => g.isCompleted);

  const sorted = completedOnly.sort((a, b) => a.date.localeCompare(b.date));

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
      const homeWon = game.homeScore! > game.awayScore!;
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

function printSeasonBreakdown(tips: BacktestTip[]): void {
  if (!tips.length) return;
  console.log('\n========== TIPS BY SEASON (leagues below hit-rate cutoff excluded) ==========');

  const orderedLabels = [...SEASONS].reverse(); // oldest -> newest
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
    console.log(`\n=== ${leagueName} ===`);
    let leagueGames: SeasonedGame[] = [];

    for (const season of SEASONS) {
      try {
        const games = await fetchLeagueScores(leagueName, season);
        console.log(`   Season ${season}: ${games.length} games`);
        leagueGames.push(...games.map(g => ({ ...g, seasonLabel: season })));
      } catch (err: any) {
        console.error(`   Season ${season} FAILED: ${err.message}`);
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
    console.error('[HockeyBacktest] Fatal error:', err.message);
    process.exit(1);
  });
}