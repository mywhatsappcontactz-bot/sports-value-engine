import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { Validator } from '../../data-bridge/validator';
import { getProbabilities, ModelInput, MarketProbability } from './probabilityModel';
import { getPinnacleSignal } from './pinnacleEdge';
import {
  findMatchingSoftLines,
  injectSyntheticDoubleChance,
} from './valueEngine';
import { Repository } from '../database/repository';

const db = getDb();
const validator = new Validator();
const repository = new Repository(db);

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface Tip {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  sport: string;
  startTime: string;
  hoursToKickoff: number;
  targetMarket: string;
  targetSelection: string;
  trueProbability: number;
  confidence: number;
  impliedFairOdds: number;
  localBookmaker: string | null;
  localOdds: number | null;
  pinnacleAvailable: boolean;
  pinnacleAgrees: boolean | null;
  signal: string;
  // Basketball totals only, free-path (no live price) tips: the model's
  // own predicted combined total for this matchup, independent of
  // whichever comparison line was used to compute confidence. Lets the
  // person compare against whatever real line their book shows, instead
  // of trusting a fixed-line comparison that's wrong for most individual
  // games (see probabilityModel.ts's rawExpectedTotal comment).
  rawExpectedTotal: number | null;
  // HOCKEY MONEYLINE ONLY (added for the hockey backtest match-up): the
  // opposing selection's local odds, when available. The validated hockey
  // edge specifically required the picked side to ALSO be the market
  // favorite (pickedOdds <= opponentOdds), not just the model's pick -
  // this is what lets a live tip confirm that same condition. Null for
  // every other sport/market, and null for hockey too when no local odds
  // exist for the opposing side (see isConfirmedFavorite below for what
  // that means).
  opponentOdds: number | null;
  // HOCKEY MONEYLINE ONLY: true = picked side confirmed as market
  // favorite (matches the backtested filter exactly). false = picked
  // side is actually the market UNDERDOG (backtest showed this loses
  // money at every floor except 55% — do not treat as validated).
  // null = no live odds for one or both sides, so favorite status could
  // NOT be confirmed at all. A null tip is running on model-probability-
  // only, which is NOT the strategy that was backtested - treat these
  // as unvalidated until a real odds source is wired in.
  isConfirmedFavorite: boolean | null;
}

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const MIN_TIP_CONFIDENCE: Record<string, number> = {
  football: 0.80,
  basketball: 0.70, // lowered from 0.80 on 2026-08-02 — backtest across 14,168
                     // real NBA games showed the 70-80% band still hits at a
                     // real 73-74%, well above its own break-even odds (~1.36),
                     // while dramatically increasing tip volume (from ~9 to
                     // ~147 moneyline tips/season, ~212 to ~455 totals/season)
  // hockey: lowered from 0.80 to 0.55 — the hockey deep-test backtest (see
  // hockeyFloorSweep.ts / leagueDetailedReport.ts) validated FOUR separate
  // confidence floors (55/60/65/70%, with 70% later dropped for low volume),
  // run as three separate "books." At the old 0.80 floor, this scanner
  // would only ever emit tips above the highest floor tested, making the
  // 55/60/65% split meaningless downstream — every book would receive the
  // same tips. 0.55 is the actual floor of what was validated; the
  // per-book split (55/60/65%) is applied downstream by filtering this
  // scanner's `confidence` field against each book's threshold, not by a
  // second scanner-side gate. Do not raise this back toward 0.80 without
  // re-checking the floor-book split logic downstream.
  hockey: 0.55,
  tennis: 0.80,
  // UNVALIDATED — no MLB backtest exists yet (modelBaseball ships as a
  // raw, uncalibrated passthrough — see probabilityModel.ts). Using the
  // same 0.80 default as everything else pending real data. Revisit once
  // an MLB isotonic fit exists, same process NBA/WNBA went through.
  baseball: 0.80,
  // NFL — this threshold applies to the model's +3.5 HANDICAP-cover
  // confidence, not plain moneyline (see modelNfl() in
  // probabilityModel.ts and nflIsotonicFit.ts). Confidence shown on
  // these tips reflects the accuracy of a +3.5-handicapped version of
  // the pick, which the person applies themselves when placing the bet
  // — NOT a straight moneyline win probability. Calibration confirmed
  // real hit rate ≈70-86% across the 0.70-0.86 confidence range on 496
  // pooled 2024-2025 predictions.
  nfl: 0.70,
};

// Per-market overrides, checked before the sport-level default above.
// PROJECT-WIDE POLICY (per conversation): any market/line/side combo
// with a genuinely CALIBRATED 70%+ real hit rate should be allowed to
// fire — the 80% sport-level football default below was left over from
// an earlier, stricter design and was silently killing markets whose
// real, validated calibration ceiling sits between 70-80%.
//
// corners_totals: calibrated ceiling is 79.96% (see
// CORNERS_TOTALS_ISOTONIC_BLOCKS in probabilityModel.ts) — the flat
// 0.80 football floor made this market fire ZERO tips, ever, since
// calibrated confidence could structurally never reach 0.80. Lowered to
// 0.70 so the market's real, validated range actually reaches tips.
//
// corners_winner: calibrated range spans ~44-93%, but the 0.80 floor
// meant only very lopsided matches (raw ~91%+) ever fired. Lowered to
// 0.70 so the whole validated calibration range — not just its rare top
// tail — can produce tips.
//
// team_corners_over: added earlier, same 0.70 reasoning — see that
// entry's original comment (kept below).
//
// HOCKEY (added this session): puck_line, hockey_totals, team_totals —
// see hockeyLineSweep.ts (raw historical line screening across all 14
// EliteProspects leagues, 4 seasons each) and hockeyCalibrationPrep.ts
// (walk-forward isotonic calibration, 34,532 pooled predictions) for the
// backtest work behind these three. Note the market name 'hockey_totals'
// is DELIBERATE, not a typo — hockey's game-totals market must NOT reuse
// the string 'totals' already used by football's goals market below,
// since this map is keyed by market name only (not sport+market), and
// reusing 'totals' would have silently forced hockey's totals to inherit
// football's 0.70 floor instead of hockey's own backtested 0.65 floor.
// 0.65 here matches HOCKEY_TOTALS_MIN_TIP_CONFIDENCE in
// probabilityModel.ts — kept as two separate checks (same reasoning as
// cards_totals/sot_totals having both a probabilityModel.ts floor AND a
// scanner-level floor) rather than relying on modelHockey's internal
// filter alone to enforce it.
const MARKET_MIN_TIP_CONFIDENCE: Record<string, number> = {
  team_corners_over: 0.70,
  corners_totals: 0.70,
  corners_winner: 0.70,
  // Cards/SOT (see conversation, cardsSotIsotonicFit.ts +
  // cardsSotBacktest.ts) — same 0.70 reasoning as corners above. Both
  // probabilityModel.ts's own post-calibration floor AND this scanner-
  // level floor are set to 0.70 for these four; kept as two separate
  // checks (not just one) for the same reason team_corners_over has
  // both — a future change to one shouldn't silently rely on the other
  // alone to enforce the real floor.
  cards_totals: 0.70,
  sot_totals: 0.70,
  team_cards_over: 0.70,
  team_sot_over: 0.70,
  // Goals (see conversation, goalsTotalsIsotonicFit.ts +
  // goalsTotalsBacktest.ts) — totals was previously inheriting
  // football's flat 0.80 default; explicit 0.70 now, consistent with
  // every other freshly-backtested market, since a real backtest
  // confirmed 70%+ hit rate for it too.
  totals: 0.70,
  team_goals_over: 0.70,
  team_goals_under: 0.70,
  // NBA team-split totals (see conversation, nbaTeamTotalsIsotonicFit.ts)
  // — same 0.70 policy as every other market this session.
  team_points_over: 0.70,
  team_points_under: 0.70,
  // Hockey — see comment above this map for why these use their own
  // distinct names and this specific 0.65 value.
  puck_line: 0.65,
  hockey_totals: 0.65,
  team_totals: 0.65,
};

const DEFAULT_MIN_TIP_CONFIDENCE = 0.80;

// Minimum CURRENT-SEASON games played (stats.homeForm.length /
// stats.awayForm.length — each team's own recent-match log, NOT h2h,
// which is a separate field entirely) before a tip is allowed to fire.
// Added 2026-08-18 after a Turkey match with gp=1 (Galatasaray, one game
// into the new season) produced a 98.1%-confidence tip — the existing
// `hasFallbackStats` check only verifies a homeGoalsAvg/homeCornersAvg
// NUMBER exists, not that it's built on a meaningful sample; a single
// early-season match can still produce a fallback average and sail
// through. This is the first sample-size floor the FREE tip-scanner path
// has ever had (the paid RealFetcher/Validator.ts path already enforces
// its own separate minimums — "Home form too small: min 5" etc. — but
// that validation never runs for runTipScanner()'s matches).
//
// Per-sport because season length and game frequency vary enormously —
// a flat number would either be meaningless for a 162-game MLB season or
// block an entire month of tips for a low-frequency league. These are
// reasoned defaults based on season length/pace, NOT backtested the way
// MIN_TIP_CONFIDENCE's basketball threshold was — revisit once enough
// tip-outcome data exists to check whether these floors are well-calibrated.
const MIN_GAMES_PLAYED: Record<string, number> = {
  football: 4,    // ~10% of a 30-38 game season, enough to smooth one fluke result
  basketball: 5,  // frequent games (82/40-game seasons), 5 games arrives within days
  // hockey: 5 already matches the backtest's own requirement
  // (homeH.length >= 5 && awayH.length >= 5 in loadAllPicks /
  // loadAllHockeyPicks) - no change needed, left as-is intentionally.
  hockey: 5,
  baseball: 8,    // 162-game season, games happen almost daily — can afford a
                  // slightly higher bar without meaningfully delaying tips
  // NFL: matches nflModel.ts's own MIN_PRIOR_GAMES exactly — the stats
  // mapper (nflStatsMapper.ts) already refuses to build RawStats below
  // this bar, so this is a defensive second check, not the primary gate.
  nfl: 3,
};
const DEFAULT_MIN_GAMES_PLAYED = 4;

// Corners now uses this same global floor (see modelFootballCorners in
// probabilityModel.ts) — an earlier 60-70% "sweet spot" version needed its
// own lower threshold, but simulation against real EPL data showed that
// band barely filtered anything (91% tip rate), so corners was moved to
// the same single 0.80 bar as every other market instead.
// UPDATE (see conversation, MARKET_MIN_TIP_CONFIDENCE above): corners_totals
// and corners_winner have since been given their own 0.70 override —
// this paragraph describes history, not the current live floor.
//
// corners_winner (Home/Draw/Away on corner count) uses this same 0.80
// floor too, added when the market was introduced. Being a 3-way market,
// 80%+ confidence is a high bar — expect low tip volume here initially,
// same pattern as NBA moneyline's 80%+ band. Revisit the threshold once
// real grading data (via cornersGradingJob.ts) shows how well-calibrated
// this market actually is; it hasn't been backtested the way NBA
// moneyline/totals were.
// UPDATE: see MARKET_MIN_TIP_CONFIDENCE above — this market's live floor
// is now 0.70, not 0.80.
//
// team_corners_over (per-team corner count, Home/Away independently)
// added to the allowed list below after real backtesting/calibration —
// see scripts/teamCornersOverBacktest.ts and
// scripts/teamCornersOverIsotonicFit.ts. Uses its own 0.70 floor (see
// MARKET_MIN_TIP_CONFIDENCE above); note the underlying calibration is
// stronger for Home than Away (Home Over 3.5 specifically hit 76.9% real
// accuracy on 8,235 pooled predictions — the single best-validated
// combination in this market — while Away-side accuracy is meaningfully
// weaker across all tested lines, and Away 4.5/5.5 never fire at all —
// see TEAM_CORNERS_HOME/AWAY_*_BLOCKS comment in probabilityModel.ts),
// so a Home tip here should generally be trusted more than an Away tip
// at the same displayed confidence.
//
// Goals totals are now restricted to 1.5/3.5 only (see TARGET_LINES in
// probabilityModel.ts) — 2.5 was dropped after backtestModel.ts showed it
// was the worst-calibrated line (63.6% actual hit rate vs 73.9% avg
// confidence), while 1.5 and 3.5 were both well-calibrated. No separate
// line-filter is needed here since probabilityModel.ts only ever
// generates 1.5/3.5 now — filtering at the source, not downstream.
//
// HOCKEY (added this session): three new markets added below —
// puck_line (+/-1.5 and +/-2.5, both calibrated), hockey_totals (fixed
// Over 4.5 / Under 7.5 only — these two specific lines were the only
// ones to clear 70% real historical hit rate across ALL 14
// EliteProspects leagues in hockeyLineSweep.ts's raw sweep; 5.5 and 6.5
// were tested and dropped, landing in the 40-65% range), and
// team_totals (Home Over 1.5 / Away Over 1.5 / Away Under 3.5 — Home
// Under 3.5 was ALSO tested and DROPPED, landing at 53-69% across every
// league, never clearing 70%). All three markets subsequently walk-
// forward calibrated via hockeyCalibrationPrep.ts (34,532 pooled
// predictions, all 14 leagues, 4 seasons) — see the new isotonic tables
// in probabilityModel.ts (PUCK_LINE_1_5_ISOTONIC_BLOCKS,
// PUCK_LINE_2_5_ISOTONIC_BLOCKS, GAME_TOTAL_OVER_4_5_ISOTONIC_BLOCKS,
// GAME_TOTAL_UNDER_7_5_ISOTONIC_BLOCKS,
// HOME_TEAM_TOTAL_OVER_1_5_ISOTONIC_BLOCKS,
// AWAY_TEAM_TOTAL_OVER_1_5_ISOTONIC_BLOCKS,
// AWAY_TEAM_TOTAL_UNDER_3_5_ISOTONIC_BLOCKS). Puck line +/-1.5's real
// hit rate plateaus near 70-71% even at max raw confidence — do not
// expect this specific market to ever show confidence much above ~71%;
// that's the real calibrated ceiling, not a display bug. Away Team
// Total Under 3.5 is the one hockey market where raw model confidence
// OVERclaims relative to real hit rate at every bin — its isotonic
// table corrects DOWNWARD, unlike every other hockey/football market
// added so far, which all correct upward (raw underclaiming).
const ALLOWED_TIP_MARKETS: Record<string, string[]> = {
  football:   ['totals', 'corners_totals', 'corners_winner', 'team_corners_over', 'cards_totals', 'sot_totals', 'team_cards_over', 'team_sot_over', 'team_goals_over', 'team_goals_under'],
  basketball: ['moneyline', 'totals', 'team_points_over', 'team_points_under', 'team_points_expected'],
  tennis:     ['moneyline'],
  hockey:     ['moneyline', 'puck_line', 'hockey_totals', 'team_totals'],
  baseball:   ['moneyline', 'totals'],
  // NFL: moneyline only. The selection text prints as plain "Home"/
  // "Away" — the +3.5 handicap is something the person applies
  // themselves at their bookmaker (see MIN_TIP_CONFIDENCE comment above
  // and buildSignal's explicit reminder below), not a separate market
  // shape the model outputs.
  nfl:        ['moneyline'],
};

function isAllowedTipMarket(sport: string, market: string): boolean {
  return ALLOWED_TIP_MARKETS[sport]?.includes(market) ?? false;
}

// ─── STATS HELPERS ─────────────────────────────────────────────────────────

function buildStatsRow(matchId: string, sport: string): any {
  return db.prepare(`
    SELECT h2h, homeForm, awayForm, referee, situational, additionalContext, confidenceFactors,
           homeGoalsAvg, awayGoalsAvg, homeCornersAvg, awayCornersAvg
    FROM stats
    WHERE matchId = ? AND sport = ?
  `).get(matchId, sport);
}

function parseStats(row: any): any {
  return {
    h2h:                JSON.parse(row.h2h || '[]'),
    homeForm:           JSON.parse(row.homeForm || '[]'),
    awayForm:           JSON.parse(row.awayForm || '[]'),
    referee:            JSON.parse(row.referee || '{}'),
    situational:        JSON.parse(row.situational || '{}'),
    additionalContext:  JSON.parse(row.additionalContext || '{}'),
    confidenceFactors:  JSON.parse(row.confidenceFactors || '{"dataCompleteness":0.35}'),
    homeGoalsAvg:       row.homeGoalsAvg ?? undefined,
    awayGoalsAvg:       row.awayGoalsAvg ?? undefined,
    homeCornersAvg:     row.homeCornersAvg ?? undefined,
    awayCornersAvg:     row.awayCornersAvg ?? undefined,
  };
}

// ─── LOCAL ODDS LOOKUP ─────────────────────────────────────────────────────

function findLocalOdds(matchId: string, market: string, selection: string): { bookmaker: string; odds: number } | null {
  const row = db.prepare(`
    SELECT bookmaker, odds
    FROM odds
    WHERE matchId = ?
    AND market = ?
    AND selection = ?
    AND bookmaker != 'Pinnacle'
    AND odds >= 1.20
    ORDER BY odds DESC
    LIMIT 1
  `).get(matchId, market, selection) as any;
  return row ? { bookmaker: row.bookmaker, odds: row.odds } : null;
}

// ─── SIGNAL TEXT ────────────────────────────────────────────────────────────

function buildSignal(
  prob: MarketProbability,
  pinnacleAvailable: boolean,
  pinnacleAgrees: boolean | null,
  isFreePathBasketballTotal: boolean,
): string {
  // Free-path basketball totals (no live price to check against): lead
  // with the model's own predicted total instead of implying the fixed
  // comparison line is a real market line. See rawExpectedTotal comment
  // in probabilityModel.ts for why — a fixed constant is wrong for most
  // individual games given how much real WNBA/NBA totals lines vary.
  if (prob.market === 'team_points_expected' && prob.rawExpectedTotal !== undefined) {
    return `Model expects ${prob.selection} team ~${prob.rawExpectedTotal.toFixed(1)} points (unvalidated, no line) — compare against your book's team total`;
  }
  if (isFreePathBasketballTotal && prob.rawExpectedTotal !== undefined) {
    return `Model predicts this game totals ~${prob.rawExpectedTotal.toFixed(1)} points — compare against your book's actual line (no live price to cross-check here)`;
  }

  // NFL: confidence reflects +3.5 HANDICAP-cover accuracy, not plain
  // moneyline win/loss — see modelNfl() in probabilityModel.ts and
  // nflIsotonicFit.ts. The selection text above still prints as plain
  // "Home"/"Away" (see ALLOWED_TIP_MARKETS comment), so this explicit
  // reminder is printed every time to avoid it ever being misread as a
  // straight moneyline probability.
  if (prob.method === 'yardage+turnover+amplified+isotonic-handicap') {
    return `⚠️ HANDICAP YOUR OWN PICK +3.5 — Model gives ${prob.selection} a ${(prob.trueProbability * 100).toFixed(1)}% chance to cover a +3.5 handicap (not a straight moneyline win)`;
  }

  const base = `Model gives ${prob.selection} a ${(prob.trueProbability * 100).toFixed(1)}% chance (${prob.method})`;
  if (!pinnacleAvailable) return `${base} — no Pinnacle line to cross-check`;
  if (pinnacleAgrees) return `${base} — confirmed by Pinnacle`;
  return `${base} — Pinnacle diverges, model-only confidence`;
}

// ─── PER-MATCH SCAN ─────────────────────────────────────────────────────────

function scanMatch(match: any, hoursToKickoff: number, tips: Tip[]): void {
  const statsRow = buildStatsRow(match.id, match.sport);
  if (!statsRow) return;

  const stats = parseStats(statsRow);

   const completeness = stats.confidenceFactors?.dataCompleteness ?? 0;
  const hasFallbackStats =
    stats.homeGoalsAvg !== undefined ||
    stats.awayGoalsAvg !== undefined ||
    stats.homeCornersAvg !== undefined ||
    stats.awayCornersAvg !== undefined;

  // Hockey's own real, backtested minDataCompleteness floor (see
  // SPORT_CONFIG.hockey in validator.ts) is 0.30 — well below this
  // function's generic 0.5 fallback gate, which was never updated when
  // hockey was added and checks fields (homeGoalsAvg etc.) hockey never
  // populates. Without this, EVERY hockey match landing in the real
  // 0.30-0.50 completeness range (discovered to be common, not rare, via
  // direct trace against real KHL/VHL matches) was being silently killed
  // here before getProbabilities() ever ran — a bug entirely separate
  // from and upstream of any of modelHockey()'s own market logic.
  const minCompletenessForSport = match.sport === 'hockey' ? 0.30 : 0.5;
  if (completeness < minCompletenessForSport && !hasFallbackStats) return;

  // Minimum current-season sample size — see MIN_GAMES_PLAYED comment
  // above. Tennis is exempt: it isn't season-form based the way team
  // sports are (H2H and rankings drive it, not "games played this
  // season"), so this gate doesn't apply there.
  if (match.sport !== 'tennis') {
    const minGames = MIN_GAMES_PLAYED[match.sport] ?? DEFAULT_MIN_GAMES_PLAYED;
    if (stats.homeForm.length < minGames || stats.awayForm.length < minGames) {
      logger.debug('[TipScanner] Skipping — insufficient current-season sample', {
        matchId: match.id,
        sport: match.sport,
        homeGames: stats.homeForm.length,
        awayGames: stats.awayForm.length,
        required: minGames,
      });
      return;
    }
  }

  let allOdds = db.prepare(`
    SELECT id, matchId, bookmaker, market, selection, odds, impliedProbability, timestamp, source
    FROM odds
    WHERE matchId = ?
  `).all(match.id) as any[];

  if (allOdds.length && match.sport === 'football') {
    allOdds = injectSyntheticDoubleChance(allOdds, match);
  }

  let marketProbs: MarketProbability[];
  try {
    const input: ModelInput = {
      match: {
        id: match.id,
        sport: match.sport,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        startTime: match.startTime,
        league: match.league,
      },
      stats,
      odds: allOdds,
    };
    marketProbs = getProbabilities(input);
  } catch (err: any) {
    logger.debug('[TipScanner] Probability model failed', { matchId: match.id, error: err.message });
    return;
  }

  // Real basketball totals odds present for this specific match? (not
  // just any odds row — specifically a 'totals' market row, since that's
  // what extractTotalLine checks). If none, the model fell back to the
  // fixed default line, and the tip should be presented as a raw
  // prediction rather than an Over/Under-vs-real-line claim.
  const hasRealBasketballTotalsOdds = allOdds.some(o => o.market === 'totals');

  for (const prob of marketProbs) {
    if (!isAllowedTipMarket(match.sport, prob.market)) continue;

    if (prob.market === 'moneyline' && prob.selection === 'Draw') continue;

    const isFreePathBasketballTotal =
      match.sport === 'basketball' && ((prob.market === 'totals' && !hasRealBasketballTotalsOdds) || prob.market === 'team_points_expected');

    // Free-path basketball totals tips skip the confidence floor entirely
    // — they're not claiming "this beats a real line with X% confidence"
    // anymore, just reporting the model's raw predicted total for the
    // person to compare themselves. Every other market keeps the normal
    // confidence gate. Per-market override (MARKET_MIN_TIP_CONFIDENCE) is
    // checked first, falling back to the sport-level default — see that
    // map's comment above for why corners markets, team_corners_over,
    // and now hockey's three new markets need their own, lower
    // thresholds.
    const threshold =
      MARKET_MIN_TIP_CONFIDENCE[prob.market] ??
      MIN_TIP_CONFIDENCE[match.sport] ??
      DEFAULT_MIN_TIP_CONFIDENCE;
    if (!isFreePathBasketballTotal && prob.trueProbability < threshold) continue;

    const softLines = allOdds.length ? findMatchingSoftLines(prob, allOdds, match) : [];
    const best = softLines.length
      ? softLines.reduce((a, b) => (a.odds > b.odds ? a : b))
      : null;
    const localOdds = best ? { bookmaker: best.bookmaker, odds: best.odds } : null;

    const softBaseline = localOdds ? 1 / localOdds.odds : prob.trueProbability;
    const pinnacle = allOdds.length
      ? getPinnacleSignal(
          prob.market,
          prob.selection,
          prob.trueProbability,
          allOdds,
          softBaseline,
        )
      : { hasPinnacle: false, flagged: false };

    const pinnacleAvailable = pinnacle.hasPinnacle;
    const pinnacleAgrees = pinnacle.hasPinnacle ? !pinnacle.flagged : null;

    // HOCKEY MONEYLINE ONLY: confirm the picked side is ALSO the market
    // favorite, matching the backtested filter exactly
    // (pickedOdds <= opponentOdds in loadAllPicks/hockeyFloorSweep.ts).
    // This is deliberately scoped to hockey moneyline only - it does not
    // touch football/basketball/tennis/baseball/NFL logic at all, and it
    // does NOT apply to hockey's new puck_line/hockey_totals/team_totals
    // markets either — those were calibrated independently via
    // hockeyCalibrationPrep.ts and don't rely on this favorite-
    // confirmation mechanism at all.
    let opponentOdds: number | null = null;
    let isConfirmedFavorite: boolean | null = null;
    if (match.sport === 'hockey' && prob.market === 'moneyline') {
      const opponentSelection = prob.selection === 'Home' ? 'Away' : 'Home';
      const opponentLocal = findLocalOdds(match.id, prob.market, opponentSelection);
      if (localOdds && opponentLocal) {
        opponentOdds = opponentLocal.odds;
        isConfirmedFavorite = localOdds.odds <= opponentOdds;
      } else {
        // No live odds for one or both sides - can't confirm favorite
        // status at all. Tip still fires (see Tip.isConfirmedFavorite
        // comment above) but is NOT the validated strategy until this
        // is resolved with a real odds source.
        opponentOdds = null;
        isConfirmedFavorite = null;
        logger.debug('[TipScanner] Hockey tip fired without odds confirmation - favorite status unknown', {
          matchId: match.id,
          selection: prob.selection,
          hasLocalOdds: !!localOdds,
          hasOpponentOdds: !!opponentLocal,
        });
      }
    }

    tips.push({
      matchId:           match.id,
      homeTeam:          match.homeTeam,
      awayTeam:          match.awayTeam,
      league:            match.league,
      sport:             match.sport,
      startTime:         match.startTime,
      hoursToKickoff:    parseFloat(hoursToKickoff.toFixed(1)),
      targetMarket:      prob.market,
      targetSelection:   prob.selection,
      trueProbability:   parseFloat(prob.trueProbability.toFixed(4)),
      confidence:        parseFloat((prob.trueProbability * 100).toFixed(1)),
      impliedFairOdds:   parseFloat((1 / prob.trueProbability).toFixed(2)),
      localBookmaker:    localOdds ? localOdds.bookmaker : null,
      localOdds:         localOdds ? localOdds.odds : null,
      pinnacleAvailable,
      pinnacleAgrees,
      signal:            buildSignal(prob, pinnacleAvailable, pinnacleAgrees, isFreePathBasketballTotal),
      rawExpectedTotal:  prob.rawExpectedTotal ?? null,
      opponentOdds,
      isConfirmedFavorite,
    });

    // Corners tips get queued for grading here, at creation time. Both
    // corners_totals (Over/Under a line) and corners_winner (Home/Draw/Away
    // on corner count) share the same queue/table — cornersGradingJob.ts
    // dispatches on the shape of targetSelection ("Over X.X"/"Under X.X"
    // vs "Home"/"Draw"/"Away") to grade each correctly, so no separate
    // queue or market column is needed here.
    //
    // team_corners_over is NOT queued here yet — its selection shape is
    // "Home Over X.X" / "Away Over X.X" (a side prefix in front of the
    // "Over X.X" pattern), which cornersGradingJob.ts's current dispatch
    // regex does not recognize. Wire this in once that grading job is
    // updated to parse the side prefix — until then, team_corners_over
    // tips fire correctly but will not get automatically graded.
    //
    // Hockey's puck_line/hockey_totals/team_totals are NOT queued for
    // grading either, same reason — no grading job has been built for
    // them yet. They fire correctly but won't be auto-graded until one
    // exists.
    if (prob.market === 'corners_totals' || prob.market === 'corners_winner') {
      repository.enqueueCornersGrading({
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        startTime: match.startTime,
        targetSelection: prob.selection,
        predictedProbability: prob.trueProbability,
      });
    }

    // Goals totals tips (football only) get queued for grading the same way
    if (match.sport === 'football' && prob.market === 'totals') {
      repository.enqueueGoalsGrading({
        matchId: match.id,
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        league: match.league,
        startTime: match.startTime,
        targetSelection: prob.selection,
        predictedProbability: prob.trueProbability,
      });
    }
  }
}

// ─── MAIN SCANNER ─────────────────────────────────────────────────────────────

export function runTipScanner(hoursWindow: number = 48): Tip[] {
  const tips: Tip[] = [];
  const now           = new Date();
  const kickoffCutoff = new Date(now.getTime() + hoursWindow * 60 * 60 * 1000).toISOString();

  const matches = db.prepare(`
    SELECT id, homeTeam, awayTeam, league, sport, startTime
    FROM matches
    WHERE status = 'upcoming'
    AND startTime <= ?
    AND startTime > ?
    ORDER BY startTime ASC
  `).all(kickoffCutoff, now.toISOString()) as any[];

  if (!matches.length) {
    logger.info('[TipScanner] No matches within time window');
    return [];
  }

  logger.info(`[TipScanner] Scanning ${matches.length} matches within ${hoursWindow}h window (all sports)`);

  for (const match of matches) {
    const hoursToKickoff = (new Date(match.startTime).getTime() - now.getTime()) / (1000 * 60 * 60);
    scanMatch(match, hoursToKickoff, tips);
  }

  const bestPerMatchMarket = new Map<string, Tip>();
  for (const tip of tips) {
    const key = tip.targetMarket === 'team_points_expected'
      ? `${tip.matchId}:${tip.targetMarket}:${tip.targetSelection}`
      : `${tip.matchId}:${tip.targetMarket}`;
    const existing = bestPerMatchMarket.get(key);
    if (!existing || tip.confidence > existing.confidence) {
      bestPerMatchMarket.set(key, tip);
    }
  }

  const deduped = Array.from(bestPerMatchMarket.values());
  deduped.sort((a, b) => a.hoursToKickoff - b.hoursToKickoff);

  logger.info(`[TipScanner] Found ${deduped.length} qualifying tips`);
  return deduped;
}

// ─── ACCUMULATOR SUGGESTER ─────────────────────────────────────────────────

export interface SuggestedAccumulator {
  legs: Tip[];
  combinedOdds: number;
  combinedProbability: number;
  usesLivePricesOnly: boolean;
}

function tipOdds(tip: Tip): number {
  return tip.localOdds ?? tip.impliedFairOdds;
}

export function suggestAccumulators(
  tips: Tip[],
  targetMin: number = 1.80,
  targetMax: number = 2.00,
  maxLegs: number = 3,
  maxSuggestions: number = 5,
): SuggestedAccumulator[] {
  const results: SuggestedAccumulator[] = [];

  function combos(pool: Tip[], size: number): Tip[][] {
    if (size === 0) return [[]];
    if (pool.length < size) return [];
    const [first, ...rest] = pool;
    const withFirst = combos(
      rest.filter(t => t.matchId !== first.matchId),
      size - 1,
    ).map(c => [first, ...c]);
    const withoutFirst = combos(rest, size);
    return [...withFirst, ...withoutFirst];
  }

  for (let legs = 2; legs <= maxLegs; legs++) {
    for (const combo of combos(tips, legs)) {
      const combinedOdds = combo.reduce((acc, t) => acc * tipOdds(t), 1);
      if (combinedOdds < targetMin || combinedOdds > targetMax) continue;

      const combinedProbability = combo.reduce((acc, t) => acc * t.trueProbability, 1);
      const usesLivePricesOnly = combo.every(t => t.localOdds !== null);

      results.push({
        legs: combo,
        combinedOdds: parseFloat(combinedOdds.toFixed(3)),
        combinedProbability: parseFloat(combinedProbability.toFixed(4)),
        usesLivePricesOnly,
      });
    }
  }

  results.sort((a, b) => {
    if (a.usesLivePricesOnly !== b.usesLivePricesOnly) {
      return a.usesLivePricesOnly ? -1 : 1;
    }
    return b.combinedProbability - a.combinedProbability;
  });

  return results.slice(0, maxSuggestions);
}