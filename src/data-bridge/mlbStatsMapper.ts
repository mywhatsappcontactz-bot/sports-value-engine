// src/data-bridge/mlbStatsMapper.ts
//
// Converts mlbScraper.ts's MlbMatchStats into the RawStats shape
// Cleaner.cleanStats() / Validator.validateStats() expect — mirrors
// basketballStatsToRawStats in realFetcher.ts closely, since modelBaseball
// was deliberately built with the same elo+isotonic moneyline structure
// as modelBasketball.
//
// KEPT SEPARATE FROM realFetcher.ts (rather than added inline there) to
// avoid touching a file with working, load-bearing logic for four other
// sports while this is still unverified. Once confirmed working, this
// could be folded into realFetcher.ts to match the existing pattern more
// closely, the same way basketball/tennis/football mappers all live there
// together.
//
// UNVERIFIED — IMPORTANT: this has NOT been confirmed to work with the
// real Cleaner/Validator pipeline. Neither cleaner.ts nor validator.ts
// were available to check during this build. Specifically unconfirmed:
//   1. Whether Validator.validateStats() (or Cleaner.cleanStats()) has
//      any sport-specific whitelist/logic that only recognizes
//      'football' | 'basketball' | 'tennis' | 'hockey' — if so, passing
//      'baseball' may throw, silently reject everything, or need an
//      explicit case added there first.
//   2. Whether Validator's minimum-sample-size rules (seen elsewhere in
//      this pipeline as things like "H2H sample too small: X records
//      (min 3)") are tuned for sports with 82+/162+ game seasons — MLB's
//      162-game season should comfortably clear any such floor, but this
//      is inferred, not confirmed.
// Test against a real fixture before trusting this in production.

import { FormRecord, H2HRecord } from '../core/database/schema';
import { MlbMatchStats } from '../scrapers/baseball/mlbScraper';

// Rolling runs-for/runs-against from a team's recent-form array — same
// role rollingPpg() plays for basketball totals, just renamed for
// clarity since these are runs, not points.
function rollingRuns(form: FormRecord[], key: 'goalsFor' | 'goalsAgainst'): number | undefined {
  if (!form.length) return undefined;
  const sum = form.reduce((s, f) => s + (f[key] ?? 0), 0);
  return parseFloat((sum / form.length).toFixed(2));
}

// Same "days since last game" logic as basketballStatsToRawStats,
// duplicated here rather than imported since realFetcher.ts doesn't
// export it — see file header on why this stays separate for now. Keep
// in sync if the basketball version's logic ever changes.
function daysSinceLastGame(form: { date: string }[]): number | undefined {
  if (!form.length) return undefined;
  // homeForm/awayForm from mlbScraper.ts are ordered OLDEST-to-NEWEST
  // (see getRecentForm's comment) — the opposite convention from
  // wnbaScraper.ts/nbaScraper.ts's most-recent-first ordering that
  // basketballStatsToRawStats relies on. Take the LAST element here, not
  // the first, or this will compute fatigue from the oldest game in the
  // window instead of the most recent one.
  const lastGameDate = new Date(form[form.length - 1].date);
  if (isNaN(lastGameDate.getTime())) return undefined;
  return Math.max(0, Math.floor((Date.now() - lastGameDate.getTime()) / (1000 * 60 * 60 * 24)));
}

export function mlbStatsToRawStats(
  stats: MlbMatchStats | null,
  externalMatchId: string,
): any {
  const hasH2H = !!stats && stats.h2h.length > 0;
  const hasForm = !!stats && (stats.homeForm.length > 0 || stats.awayForm.length > 0);

  const homeForm = stats ? stats.homeForm : [];
  const awayForm = stats ? stats.awayForm : [];
  const h2h = stats ? stats.h2h : [];

  const homeFatigueDays = daysSinceLastGame(homeForm);
  const awayFatigueDays = daysSinceLastGame(awayForm);
  const fatigueDays = homeFatigueDays !== undefined && awayFatigueDays !== undefined
    ? Math.min(homeFatigueDays, awayFatigueDays)
    : (homeFatigueDays ?? awayFatigueDays);

  return {
    externalMatchId,
    sport: 'baseball',
    confidenceFactors: {
      // Same tiering logic as basketball's mapper — MLB's 162-game season
      // means hasForm should be true far more often than in NBA/WNBA
      // (games happen almost daily), so in practice this should usually
      // land at the top tier once real fixtures are flowing.
      dataCompleteness: hasH2H && hasForm ? 0.75 : hasH2H ? 0.55 : 0.4,
    },
    h2h: h2h.map((m: H2HRecord) => ({
      date:      m.date,
      homeTeam:  m.homeTeam,
      awayTeam:  m.awayTeam,
      homeScore: m.homeScore,
      awayScore: m.awayScore,
    })),
    homeForm: homeForm.map((f: FormRecord) => ({
      date:         f.date,
      opponent:     f.opponent,
      result:       f.result,
      goalsFor:     f.goalsFor,     // runs, reusing the goalsFor field name — see modelBaseball comment
      goalsAgainst: f.goalsAgainst,
      venue:        f.venue,
    })),
    awayForm: awayForm.map((f: FormRecord) => ({
      date:         f.date,
      opponent:     f.opponent,
      result:       f.result,
      goalsFor:     f.goalsFor,
      goalsAgainst: f.goalsAgainst,
      venue:        f.venue,
    })),
    referee: {},
    situational: { weather: 'clear', temperature: 20, fatigueDays },
    additionalContext: {
      // Rolling runs-for/against — analogous to basketball's
      // homePpgFor/awayPpgFor, but modelBaseball doesn't currently read
      // these directly (it recomputes lambdas from stats.homeForm/
      // awayForm itself via computeBaseballLambdas). Included anyway for
      // visibility/debugging and in case a future refactor wants them
      // precomputed the way basketball does.
      homeRunsFor:     rollingRuns(homeForm, 'goalsFor'),
      homeRunsAgainst: rollingRuns(homeForm, 'goalsAgainst'),
      awayRunsFor:     rollingRuns(awayForm, 'goalsFor'),
      awayRunsAgainst: rollingRuns(awayForm, 'goalsAgainst'),

      // Structural hooks only — see modelBaseball's own comments.
      // parkFactor/homeBullpenFactor/awayBullpenFactor are intentionally
      // left undefined here; no data source for any of the three exists
      // yet. modelBaseball already defaults each to neutral (1.0) when
      // undefined, so leaving these out is safe, not a bug — just
      // unrealized upside until those sources are built.
      league: 'mlb',
    },
  };
}