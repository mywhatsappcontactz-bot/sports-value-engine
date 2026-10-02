// src/core/engine/hockeyOddsBacktestNHL.ts
//
// Real ROI backtest, now pooling MULTIPLE confirmed-complete NHL
// seasons — a single season (2018-19) only produced 5 qualifying tips
// at MIN_TIP_CONFIDENCE=0.75, confirmed 2026-09-04: NHL is a parity
// league (32 closely-matched teams), so the model rarely reaches high
// confidence on any one game. Pooling seasons is the honest way to get
// a real sample size, not a way to cherry-pick a favorable result —
// all games from all pooled seasons are merged into one continuous
// chronological timeline and evaluated the same way, same as
// hockeyBacktest1.ts's existing multi-season design for other leagues
// (a team's "prior form" carries across season boundaries there too).
//
// SEASONS DELIBERATELY EXCLUDED, and why (not just skipped silently):
//   - 2022-23: CONFIRMED broken — sportsbookreviewsonline.com's archive
//     page for this season stops at Nov 27, missing the rest of the
//     season entirely (confirmed by checking the raw file's date
//     range directly, cross-referenced against the site's own "archive
//     will not be updated" notice).
//   - 2019-20: real-world COVID pause/bubble restart — irregular
//     schedule and date range not independently verified here, excluded
//     rather than guessed at.
//   - "2021" (SBR's own odd naming, not "2020-21"): the real 56-game
//     COVID-shortened season played entirely in calendar 2021 — season
//     string convention on both sides not verified, excluded rather
//     than guessed at.
// Everything else in the 2007-08 through 2021-22 range is a normal
// 82-game season (except 2012-13, the real lockout-shortened 48-game
// season — a known historical fact, not a data-quality concern, still
// included).
//
// SINGLES ONLY — see prior header version / conversation for why
// parlays are deliberately out of scope for this validation step.

import {
  fetchLeagueScores,
  EPGame,
} from '../../scrapers/hockey/eliteProspectsScraper';
import {
  buildHistory,
  h2hHomeWinRate,
  predictMoneyline,
  MIN_TIP_CONFIDENCE,
  MIN_PRIOR_GAMES,
} from './hockeyBacktest1';
import { fetchNhlSeasonOdds, sbrTeamMatches, SbrGame } from '../../scrapers/hockey/sbrOddsScraper';

interface SeasonSpec {
  sbr: string;       // SBR's own format, e.g. "2018-19"
  startYear: number; // for SBR's year-less date field
  ep: string;         // EliteProspects' own format, e.g. "2018-2019"
}

const SEASONS: SeasonSpec[] = [
  { sbr: '2007-08', startYear: 2007, ep: '2007-2008' },
  { sbr: '2008-09', startYear: 2008, ep: '2008-2009' },
  { sbr: '2009-10', startYear: 2009, ep: '2009-2010' },
  { sbr: '2010-11', startYear: 2010, ep: '2010-2011' },
  { sbr: '2011-12', startYear: 2011, ep: '2011-2012' },
  { sbr: '2012-13', startYear: 2012, ep: '2012-2013' }, // real lockout-shortened 48-game season
  { sbr: '2013-14', startYear: 2013, ep: '2013-2014' },
  { sbr: '2014-15', startYear: 2014, ep: '2014-2015' },
  { sbr: '2015-16', startYear: 2015, ep: '2015-2016' },
  { sbr: '2016-17', startYear: 2016, ep: '2016-2017' },
  { sbr: '2017-18', startYear: 2017, ep: '2017-2018' },
  { sbr: '2018-19', startYear: 2018, ep: '2018-2019' }, // confirmed complete directly (Oct 3 - Jun 12)
  { sbr: '2021-22', startYear: 2021, ep: '2021-2022' },
];

const STAKE_PER_BET = 100; // arbitrary flat unit stake — ROI% is what matters, not the absolute number

interface MatchedTip {
  date: string;
  homeTeam: string;
  awayTeam: string;
  selection: 'Home' | 'Away';
  confidence: number;
  hit: boolean;
  odds: number;
}

function americanOddsProfit(odds: number, stake: number): number {
  return odds > 0 ? stake * (odds / 100) : stake * (100 / Math.abs(odds));
}

function findMatchingSbrGame(epGame: EPGame, sbrGamesByDate: Map<string, SbrGame[]>): SbrGame | null {
  const candidates = sbrGamesByDate.get(epGame.date);
  if (!candidates) return null;
  for (const sbr of candidates) {
    if (sbrTeamMatches(sbr.homeTeamSbr, epGame.homeTeam) && sbrTeamMatches(sbr.awayTeamSbr, epGame.awayTeam)) {
      return sbr;
    }
  }
  return null;
}

async function main() {
  const sbrGamesByDate = new Map<string, SbrGame[]>();
  const allEpGames: EPGame[] = [];

  for (const season of SEASONS) {
    console.log(`\n--- Season ${season.sbr} ---`);
    try {
      const sbrGames = await fetchNhlSeasonOdds(season.sbr, season.startYear);
      console.log(`  SBR: ${sbrGames.length} real games`);
      for (const g of sbrGames) {
        if (!sbrGamesByDate.has(g.dateIso)) sbrGamesByDate.set(g.dateIso, []);
        sbrGamesByDate.get(g.dateIso)!.push(g);
      }
    } catch (err: any) {
      console.log(`  SBR FAILED: ${err.message}`);
    }

    try {
      const epGames = await fetchLeagueScores('NHL', season.ep);
      console.log(`  EliteProspects: ${epGames.length} real games`);
      allEpGames.push(...epGames);
    } catch (err: any) {
      console.log(`  EliteProspects FAILED: ${err.message}`);
    }
  }

  console.log(`\n\nTotal pooled: ${sbrGamesByDate.size} distinct dates with SBR odds, ${allEpGames.length} raw EliteProspects games.`);

  const seen = new Set<number>();
  const deduped = allEpGames.filter(g => (seen.has(g.gameId) ? false : (seen.add(g.gameId), true)));
  const completedOnly = deduped.filter(g => g.isCompleted);
  const sorted = completedOnly.sort((a, b) => a.date.localeCompare(b.date));
  console.log(`After dedup + completed-only: ${sorted.length} EliteProspects games across all pooled seasons.`);

  const matchedTips: MatchedTip[] = [];
  let qualifyingTipsTotal = 0;
  let noOddsMatchCount = 0;

  for (const game of sorted) {
    const priorGames = sorted.filter(g => g.date < game.date);
    const history = buildHistory(priorGames);

    const homeRecordsAll = (history.get(game.homeTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    const awayRecordsAll = (history.get(game.awayTeam) ?? []).sort((a, b) => b.date.localeCompare(a.date));

    if (homeRecordsAll.length < MIN_PRIOR_GAMES || awayRecordsAll.length < MIN_PRIOR_GAMES) continue;

    const h2hHWR = h2hHomeWinRate(priorGames, game.homeTeam, game.awayTeam);
    const homeWinProb = predictMoneyline(homeRecordsAll, awayRecordsAll, h2hHWR);
    const mlSelection: 'Home' | 'Away' = homeWinProb >= 0.5 ? 'Home' : 'Away';
    const mlConfidence = Math.max(homeWinProb, 1 - homeWinProb);

    if (mlConfidence < MIN_TIP_CONFIDENCE) continue;
    qualifyingTipsTotal++;

    const sbrMatch = findMatchingSbrGame(game, sbrGamesByDate);
    if (!sbrMatch) {
      noOddsMatchCount++;
      continue;
    }

    const homeWon = game.homeScore! > game.awayScore!;
    const hit = mlSelection === 'Home' ? homeWon : !homeWon;
    const odds = mlSelection === 'Home' ? sbrMatch.homeCloseMl : sbrMatch.awayCloseMl;

    matchedTips.push({
      date: game.date,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      selection: mlSelection,
      confidence: mlConfidence,
      hit,
      odds,
    });
  }

  console.log(`\n========== POOLED RESULTS: NHL, ${SEASONS.length} seasons ==========`);
  console.log(`Total qualifying tips: ${qualifyingTipsTotal}`);
  console.log(`Matched to a real SBR odds line: ${matchedTips.length}`);
  console.log(`No real odds match found (excluded from ROI, not guessed): ${noOddsMatchCount}`);

  if (matchedTips.length === 0) {
    console.log('\nNo matched tips — cannot compute real ROI.');
    return;
  }

  const hits = matchedTips.filter(t => t.hit).length;
  const hitRate = hits / matchedTips.length;

  let totalStaked = 0;
  let totalProfit = 0;
  for (const t of matchedTips) {
    totalStaked += STAKE_PER_BET;
    totalProfit += t.hit ? americanOddsProfit(t.odds, STAKE_PER_BET) : -STAKE_PER_BET;
  }
  const roi = (totalProfit / totalStaked) * 100;

  console.log(`\nHit rate on matched tips: ${hits}/${matchedTips.length} = ${(hitRate * 100).toFixed(1)}%`);
  console.log(`Total staked: $${totalStaked.toFixed(2)} (${matchedTips.length} bets @ $${STAKE_PER_BET} flat)`);
  console.log(`Total profit/loss: ${totalProfit >= 0 ? '+' : ''}$${totalProfit.toFixed(2)}`);
  console.log(`REAL ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);

  const avgOdds = matchedTips.reduce((s, t) => s + t.odds, 0) / matchedTips.length;
  console.log(`\nAverage odds on selected side: ${avgOdds >= 0 ? '+' : ''}${avgOdds.toFixed(0)}`);

  console.log('\nAll matched tips:');
  matchedTips.forEach(t => {
    console.log(`  ${t.date} | ${t.homeTeam} vs ${t.awayTeam} | picked ${t.selection} @ ${t.odds >= 0 ? '+' : ''}${t.odds} (conf ${(t.confidence * 100).toFixed(0)}%) | ${t.hit ? 'HIT' : 'MISS'}`);
  });

  console.log('\n=== Done ===');
}

main().catch(err => {
  console.error('[HockeyOddsBacktestNHL] Fatal error:', err.message);
  process.exit(1);
});