// src/core/engine/dailyParlaySelector.ts
//
// Does NOT scrape or predict anything itself. Reads todays_picks.csv (one
// row per qualifying pick you already have from your live tip scanner -
// League, HomeTeam, AwayTeam, Selection, Odds, Confidence) and tells you
// which VALIDATED 2-leg pairs are actually complete today, per floor
// book, with the combined odds and stake.
//
// This exists because backtested pair edge (AHL+NHL, DEL+HockeyAllsvenskan,
// etc.) only means something if BOTH legs of that specific pair have a
// qualifying pick on the SAME day. Most days, most pairs won't - this
// tool tells you which ones do, so you're not manually cross-checking a
// list of pairs against a list of picks by eye every day.
//
// USAGE:
//   1. Fill in todays_picks.csv with today's qualifying picks (one row
//      per pick, across whichever leagues had games).
//   2. npx ts-node src/core/engine/dailyParlaySelector.ts
//
// FLOOR_BOOKS below must match your real book split. Each floor is
// checked independently - a pick only counts for a floor if its
// Confidence clears that floor's threshold. If you're running 3 books
// (55/60/65, per the earlier decision to drop 70%), leave this as-is.
//
// VALIDATED_PAIRS is the pair list that passed BOTH the original
// (single-leg) backtest AND the split-half consistency check - not
// every profitable-looking pair, only the ones shown stable across
// independent time periods. Edit this list as more leagues get more
// seasons of history and pass the same check.

import * as fs from 'fs';
import * as path from 'path';

const FLOOR_BOOKS = [0.55, 0.60, 0.65]; // floor 70% dropped - see earlier decision
const STAKE = 10000;
const EXCLUDED_LEAGUES = new Set(['SHL']); // dropped - see earlier decision

// Pairs confirmed profitable in BOTH halves of history (split-test passed),
// per the walkthrough of the original single-leg deep test results.
// KHL-involving pairs are deliberately excluded here - KHL's odds file
// only has 2 seasons, not enough for a real split-test yet. Re-add them
// once KHL has 3+ seasons of history.
const VALIDATED_PAIRS = new Set([
  'AHL+NHL',
  'EIHL+NHL',
  'HockeyAllsvenskan+NHL',
  'DEL+HockeyAllsvenskan',
  'DEL+NHL',
  'ICEHL+NHL',
  'DEL2+NHL',
  'DEL2+HockeyAllsvenskan',
]);

interface Pick { league: string; home: string; away: string; selection: string; odds: number; confidence: number; }

function parseCsv(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
}

function loadTodaysPicks(csvPath: string): Pick[] {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { league: col('League'), home: col('HomeTeam'), away: col('AwayTeam'), sel: col('Selection'), odds: col('Odds'), conf: col('Confidence') };
  const picks: Pick[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const league = r[idx.league]?.trim();
    const odds = parseFloat(r[idx.odds]);
    const confidence = parseFloat(r[idx.conf]);
    if (!league || isNaN(odds) || isNaN(confidence)) continue;
    if (EXCLUDED_LEAGUES.has(league.toUpperCase())) continue;
    picks.push({ league, home: r[idx.home], away: r[idx.away], selection: r[idx.sel], odds, confidence });
  }
  return picks;
}

function main() {
  const csvPath = path.join(process.cwd(), 'todays_picks.csv');
  if (!fs.existsSync(csvPath)) {
    console.error(`todays_picks.csv not found at ${csvPath}. Fill in the template first.`);
    process.exit(1);
  }
  const allPicks = loadTodaysPicks(csvPath);
  if (!allPicks.length) {
    console.log('No picks found in todays_picks.csv (or all rows were dropped/excluded).');
    return;
  }

  console.log(`Loaded ${allPicks.length} pick(s) across ${new Set(allPicks.map(p=>p.league)).size} league(s) for today.\n`);

  for (const floor of FLOOR_BOOKS) {
    console.log(`\n========== FLOOR ${(floor*100).toFixed(0)}% BOOK ==========`);

    // One qualifying pick per league at this floor - highest confidence
    // if a league somehow has more than one row (shouldn't normally
    // happen for a single day's qualifying picks, but guards against it).
    const qualifying = allPicks.filter(p => p.confidence >= floor);
    const byLeague = new Map<string, Pick>();
    for (const p of qualifying) {
      const existing = byLeague.get(p.league);
      if (!existing || p.confidence > existing.confidence) byLeague.set(p.league, p);
    }

    if (!byLeague.size) {
      console.log('  No qualifying picks at this floor today.');
      continue;
    }

    console.log(`  Qualifying leagues today: ${[...byLeague.keys()].join(', ')}`);

    const leagueNames = [...byLeague.keys()];
    const liveParlays: { pairKey: string; legA: Pick; legB: Pick; combinedOdds: number }[] = [];
    for (let i = 0; i < leagueNames.length; i++) {
      for (let j = i + 1; j < leagueNames.length; j++) {
        const pairKey = [leagueNames[i], leagueNames[j]].sort().join('+');
        if (!VALIDATED_PAIRS.has(pairKey)) continue;
        const legA = byLeague.get(leagueNames[i])!, legB = byLeague.get(leagueNames[j])!;
        liveParlays.push({ pairKey, legA, legB, combinedOdds: legA.odds * legB.odds });
      }
    }

    if (!liveParlays.length) {
      console.log('  No VALIDATED pairs are complete today at this floor (one or both legs missing).');
      continue;
    }

    console.log(`  ${liveParlays.length} validated parlay(s) available:\n`);
    for (const p of liveParlays) {
      const potentialProfit = STAKE * (p.combinedOdds - 1);
      console.log(`  [${p.pairKey}]`);
      console.log(`    Leg A (${p.legA.league}): ${p.legA.home} vs ${p.legA.away} -> ${p.legA.selection} @ ${p.legA.odds.toFixed(3)}`);
      console.log(`    Leg B (${p.legB.league}): ${p.legB.home} vs ${p.legB.away} -> ${p.legB.selection} @ ${p.legB.odds.toFixed(3)}`);
      console.log(`    Combined odds: ${p.combinedOdds.toFixed(3)} | Stake: ₦${STAKE.toLocaleString()} | Potential profit if both win: ₦${potentialProfit.toLocaleString(undefined,{maximumFractionDigits:0})}\n`);
    }
  }
}

main();