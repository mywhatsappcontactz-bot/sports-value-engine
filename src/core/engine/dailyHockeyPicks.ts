// src/core/engine/dailyHockeyPicks.ts
//
// Live daily picks: syncs upcoming fixtures for your verified strong
// leagues, runs the real prediction pipeline, filters to confidence
// >=55%, and flags same-day parlay candidates among your split-tested
// pairs. NO LIVE ODDS SOURCE EXISTS YET — this shows the model's fair
// odds only. Before staking anything, manually check your bookmaker's
// real price for each flagged game:
//   1. Confirm your side is priced as the FAVORITE (its odds <= the
//      opponent's odds) — this script cannot verify that without a
//      live odds feed.
//   2. Confirm the real odds clear the minimum-odds table:
//      minOdds ~= 1 / (confidence - 0.05)
// Only bet if both checks pass.
//
// Run with: npx ts-node src/core/engine/dailyHockeyPicks.ts

import { getDb } from '../database/db';
import { Repository } from '../database/repository';
import { getProbabilities, ModelInput } from './probabilityModel';
import { syncAllEliteProspectsFixtures } from '../../data-bridge/eliteProspectsFixturesSync';

const CONFIDENCE_FLOOR = 0.55;

// Split-tested strong leagues from today's work. Adjust the exact string
// values to match whatever ELITEPROSPECTS_LEAGUE_MAP actually uses —
// these are placeholders based on the league names seen in your CSVs.
// IMPORTANT: check the "RAW LEAGUE STRINGS SEEN TODAY" printout below
// every time you run this, at least until you've confirmed these strings
// are correct - a mismatch here silently skips that league forever.
const STRONG_LEAGUES = new Set([
  'nhl', 'khl', 'del', 'del2', 'icehl', 'ahl', 'eihl', 'liiga', 'hockeyallsvenskan',
].map(s => s.toLowerCase()));

// Split-tested cross-league parlay pairs, in priority order.
// Top group: proven across 4 seasons, both halves positive.
// Second group: promising, but KHL only has 2 seasons of data so far —
// treat with smaller size until more history accumulates.
const PROVEN_PAIRS: [string, string][] = [
  ['ahl', 'nhl'],
  ['eihl', 'nhl'],
  ['hockeyallsvenskan', 'nhl'],
  ['del', 'hockeyallsvenskan'],
];
const PROMISING_PAIRS: [string, string][] = [
  ['ahl', 'khl'],
  ['del', 'khl'],
  ['eihl', 'khl'],
  ['hockeyallsvenskan', 'khl'],
  ['icehl', 'khl'],
  ['khl', 'liiga'],
  ['khl', 'nhl'],
];

function minAcceptableOdds(confidence: number): number {
  return 1 / (confidence - 0.05);
}

interface Pick {
  matchId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  modelSide: 'Home' | 'Away';
  confidence: number;
  fairOdds: number;
  minAcceptableOdds: number;
}

async function main() {
  console.log('=== SYNCING TODAY\'S HOCKEY FIXTURES (EliteProspects) ===\n');
  const syncResults = await syncAllEliteProspectsFixtures();
  const totalFixtures = syncResults.reduce((s, r) => s + r.fixturesFound, 0);
  console.log(`Synced ${totalFixtures} upcoming fixtures across ${syncResults.length} leagues.\n`);

  const repo = new Repository(getDb());
  const upcoming = repo.getUpcomingMatches('hockey');

  // DIAGNOSTIC: print every distinct raw league string actually returned,
  // so you can visually confirm it matches STRONG_LEAGUES below. If a
  // league you expect (e.g. DEL) doesn't appear here with the exact
  // string you expect, that league will be silently skipped everywhere
  // below - fix the string in STRONG_LEAGUES to match what's printed here.
  const rawLeagueStrings = [...new Set(upcoming.map(m => m.league))].sort();
  console.log('=== RAW LEAGUE STRINGS SEEN TODAY (verify against STRONG_LEAGUES) ===');
  for (const l of rawLeagueStrings) {
    const matches = STRONG_LEAGUES.has((l || '').toLowerCase());
    console.log(`  "${l}" -> ${matches ? 'MATCHED' : 'NOT MATCHED (will be skipped!)'}`);
  }
  console.log('');

  const picks: Pick[] = [];

  for (const match of upcoming) {
    const league = (match.league || '').toLowerCase();
    if (!STRONG_LEAGUES.has(league)) continue; // only your verified strong leagues

    const stats = repo.getStats(match.id);
    if (!stats) continue;

    const input: ModelInput = {
      match: {
        id: match.id,
        sport: 'hockey',
        homeTeam: match.homeTeam,
        awayTeam: match.awayTeam,
        startTime: match.startTime,
        league: match.league,
      },
      stats,
      odds: [],
    };

    let probs;
    try {
      probs = getProbabilities(input);
    } catch {
      continue;
    }

    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const modelSide: 'Home' | 'Away' = homeProb >= 0.5 ? 'Home' : 'Away';
    const confidence = Math.max(homeProb, 1 - homeProb);
    if (confidence < CONFIDENCE_FLOOR) continue;

    picks.push({
      matchId: match.id,
      league: match.league,
      homeTeam: match.homeTeam,
      awayTeam: match.awayTeam,
      startTime: match.startTime,
      modelSide,
      confidence,
      fairOdds: 1 / confidence,
      minAcceptableOdds: minAcceptableOdds(confidence),
    });
  }

  console.log(`=== QUALIFYING SINGLES (confidence >= ${CONFIDENCE_FLOOR * 100}%) ===\n`);
  if (!picks.length) {
    console.log('No qualifying picks today.\n');
  }
  for (const p of picks) {
    const pickedTeam = p.modelSide === 'Home' ? p.homeTeam : p.awayTeam;
    const opponent = p.modelSide === 'Home' ? p.awayTeam : p.homeTeam;
    console.log(`[${p.league}] ${p.homeTeam} vs ${p.awayTeam} (${new Date(p.startTime).toLocaleString()})`);
    console.log(`  Model pick: ${pickedTeam} — ${(p.confidence * 100).toFixed(1)}% confidence`);
    console.log(`  Model fair odds: ${p.fairOdds.toFixed(2)} | Minimum acceptable real odds: ${p.minAcceptableOdds.toFixed(2)}`);
    console.log(`  >>> MANUAL CHECK before betting: confirm ${pickedTeam}'s real bookmaker odds are LOWER than ${opponent}'s (i.e. ${pickedTeam} is the market favorite), AND clear ${p.minAcceptableOdds.toFixed(2)}.\n`);
  }

  // Parlay candidates: same-day pairs from your verified list
  console.log(`\n=== PARLAY CANDIDATES (same-day, verified pairs only) ===\n`);
  const byLeagueToday = new Map<string, Pick>();
  for (const p of picks) {
    if (!byLeagueToday.has(p.league.toLowerCase())) byLeagueToday.set(p.league.toLowerCase(), p);
  }

  function checkPairs(pairs: [string, string][], label: string) {
    console.log(`-- ${label} --`);
    let any = false;
    for (const [a, b] of pairs) {
      const legA = byLeagueToday.get(a);
      const legB = byLeagueToday.get(b);
      if (legA && legB) {
        any = true;
        const combinedFairOdds = legA.fairOdds * legB.fairOdds;
        console.log(`  ${a.toUpperCase()}+${b.toUpperCase()} available:`);
        console.log(`    Leg 1: ${legA.homeTeam} vs ${legA.awayTeam} — ${legA.modelSide === 'Home' ? legA.homeTeam : legA.awayTeam} (${(legA.confidence*100).toFixed(1)}%)`);
        console.log(`    Leg 2: ${legB.homeTeam} vs ${legB.awayTeam} — ${legB.modelSide === 'Home' ? legB.homeTeam : legB.awayTeam} (${(legB.confidence*100).toFixed(1)}%)`);
        console.log(`    Combined model fair odds: ${combinedFairOdds.toFixed(2)} — verify BOTH legs individually clear their own minimum odds before combining.\n`);
      }
    }
    if (!any) console.log('  None available today.\n');
  }

  checkPairs(PROVEN_PAIRS, 'PROVEN PAIRS (4-season split-tested)');
  checkPairs(PROMISING_PAIRS, 'PROMISING PAIRS (KHL — only 2 seasons of history, size smaller)');
}

main().catch(e => { console.error(e.message); process.exit(1); });