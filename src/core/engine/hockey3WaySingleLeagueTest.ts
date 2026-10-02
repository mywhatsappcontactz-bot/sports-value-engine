// src/core/engine/hockey3WaySingleLeagueTest.ts
//
// 3-WAY MARKET TEST (Home / Draw / Away, regulation time).
//
// Unlike hockeyRealisticSingleLeagueTest.ts, this does NOT use
// probabilityModel.ts - there is no 3-way model yet. Instead it uses
// the bookmaker's own posted odds, devigged into fair probabilities,
// as the "confidence" signal, and backs whichever of the three
// outcomes has the highest devigged probability (i.e. the market's
// own favorite). This answers a narrower but useful question first:
// is there ANY profitable strategy in the 3-way market using the
// market's own prices, before spending time building a real 3-way
// probability model + calibration?
//
// Settlement is simple and exact, using the Status column - no need
// for regulation-time-only scores:
//   - Status === 'After OT' or 'After Pen.'  -> actual result is DRAW
//     (the game was tied after regulation, full stop, regardless of
//     who won in OT/shootout)
//   - Status === 'Finished'                  -> actual result is
//     whichever of Home/Away has the higher score (a Finished game
//     cannot be a regulation draw, since it didn't need OT)
//
// Devigging: for each game, rawProb(outcome) = 1/odds(outcome).
// These three raw probabilities sum to > 1 (the bookmaker's overround
// / vig). We divide each by the sum to get a fair probability that
// sums to 1. The "confidence" floor is applied to this fair
// probability of whichever outcome we're picking (the max of the
// three).
//
// Usage (same env vars as hockeyRealisticSingleLeagueTest.ts):
//   $env:LEAGUE_CSV="C:\...\nhl_3way.csv"
//   $env:LEAGUE_LABEL="NHL"
//   npx ts-node src/core/engine/hockey3WaySingleLeagueTest.ts
import * as fs from 'fs';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const MIN_ODDS = 1.25;
const INITIAL_CAPITAL = 1_000_000;
const FIXED_STAKE = 10_000;

const LEAGUE_CSV = process.env.LEAGUE_CSV;
const LEAGUE_LABEL = process.env.LEAGUE_LABEL || 'League';

if (!LEAGUE_CSV) {
  console.error('Set $env:LEAGUE_CSV to the CSV path, and optionally $env:LEAGUE_LABEL to a display name.');
  process.exit(1);
}

type Outcome = 'Home' | 'Draw' | 'Away';

interface Leg {
  date: string;
  pick: Outcome;
  actual: Outcome;
  won: boolean;
  odds: number;
  confidence: number; // devigged fair probability of the picked outcome
}

function parseCsvGeneric(text: string): string[][] {
  return text.trim().split(/\r?\n/).map(l => l.split(',').map(c => c.trim()));
}
function parseFlexibleDate(s: string): Date {
  const trimmed = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return new Date(trimmed);
  const months: Record<string,string> = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const m = trimmed.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return new Date(NaN);
  const [, day, mon, year] = m;
  return new Date(`${year}-${months[mon]}-${day.padStart(2,'0')}`);
}
function getSeasonLabel(dateStr: string): string {
  const d = new Date(dateStr);
  const y = d.getFullYear(), m = d.getMonth() + 1;
  return m >= 7 ? `${y}/${y+1}` : `${y-1}/${y}`;
}

function loadAllLegs(csvPath: string): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = {
    date: col('Date'), status: col('Status'),
    hs: col('Home_Score'), as: col('Away_Score'),
    ho: col('Home_Odds'), draw: col('Draw_Odds'), ao: col('Away_Odds'),
  };

  if (idx.draw === -1) {
    console.error('This CSV has no Draw_Odds column - it was not parsed with the v10 3-way parser. Re-run parseOddsPortalAcb.js (v10) on the raw .txt first.');
    process.exit(1);
  }

  const legs: Leg[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    const status = r[idx.status]?.trim();
    if (status !== 'Finished' && status !== 'After OT' && status !== 'After Pen.') continue;

    const date = parseFlexibleDate(r[idx.date]);
    if (isNaN(date.getTime())) continue;

    const hs = parseInt(r[idx.hs]), as = parseInt(r[idx.as]);
    if (isNaN(hs) || isNaN(as)) continue;

    const ho = parseFloat(r[idx.ho]), drawOdds = parseFloat(r[idx.draw]), ao = parseFloat(r[idx.ao]);
    // Skip games missing any of the 3 prices - can't devig or settle fairly without all three.
    if (isNaN(ho) || isNaN(drawOdds) || isNaN(ao)) continue;

    const wentToOt = status === 'After OT' || status === 'After Pen.';
    const actual: Outcome = wentToOt ? 'Draw' : (hs > as ? 'Home' : 'Away');

    // Devig: raw implied probs sum to > 1 (bookmaker overround); normalize to sum to 1.
    const rawHome = 1 / ho, rawDraw = 1 / drawOdds, rawAway = 1 / ao;
    const overround = rawHome + rawDraw + rawAway;
    const fairHome = rawHome / overround, fairDraw = rawDraw / overround, fairAway = rawAway / overround;

    // Pick whichever outcome the market rates most likely.
    let pick: Outcome, confidence: number, odds: number;
    if (fairHome >= fairDraw && fairHome >= fairAway) { pick = 'Home'; confidence = fairHome; odds = ho; }
    else if (fairDraw >= fairHome && fairDraw >= fairAway) { pick = 'Draw'; confidence = fairDraw; odds = drawOdds; }
    else { pick = 'Away'; confidence = fairAway; odds = ao; }

    legs.push({
      date: date.toISOString().slice(0, 10),
      pick, actual, won: pick === actual,
      odds, confidence,
    });
  }
  legs.sort((a, b) => a.date.localeCompare(b.date));
  return legs;
}

function computeStreaks(legs: Leg[]): { win: number; loss: number } {
  let win = 0, loss = 0, cw = 0, cl = 0;
  for (const l of legs) {
    if (l.won) { cw++; win = Math.max(win, cw); cl = 0; }
    else { cl++; loss = Math.max(loss, cl); cw = 0; }
  }
  return { win, loss };
}

function computeMaxDrawdown(legs: Leg[]): { maxAbs: number; maxPct: number } {
  let balance = INITIAL_CAPITAL, peak = INITIAL_CAPITAL, maxAbs = 0, maxPct = 0;
  for (const l of legs) {
    balance += l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxAbs) { maxAbs = dd; maxPct = peak > 0 ? (dd / peak) * 100 : 0; }
  }
  return { maxAbs, maxPct };
}

function fmtNaira(n: number): string { return `₦${Math.round(n).toLocaleString()}`; }

async function main() {
  const allLegs = loadAllLegs(LEAGUE_CSV!);
  const pickBreakdown = { Home: 0, Draw: 0, Away: 0 };
  for (const l of allLegs) pickBreakdown[l.pick]++;
  console.log(`${LEAGUE_LABEL}: ${allLegs.length} total games loaded with full 3-way odds`);
  console.log(`  Market-favorite pick breakdown: Home ${pickBreakdown.Home}, Draw ${pickBreakdown.Draw}, Away ${pickBreakdown.Away}\n`);

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n========== FLOOR ${(floor * 100).toFixed(0)}%, MIN ODDS ${MIN_ODDS} ==========`);
    const qualifying = allLegs.filter(l => l.confidence >= floor && l.odds >= MIN_ODDS);

    if (!qualifying.length) { console.log('  0 qualifying bets.'); continue; }

    const wins = qualifying.filter(l => l.won).length;
    const drawPicks = qualifying.filter(l => l.pick === 'Draw').length;
    const avgOdds = qualifying.reduce((s, l) => s + l.odds, 0) / qualifying.length;
    const breakeven = 100 / avgOdds;
    const staked = qualifying.length * FIXED_STAKE;
    const profit = qualifying.reduce((s, l) => s + (l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE), 0);
    const roi = (profit / staked) * 100;

    console.log(`  ${qualifying.length} bets | wins: ${wins} (${(wins / qualifying.length * 100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | ROI: ${roi.toFixed(2)}%`);
    console.log(`  Of these, ${drawPicks} (${(drawPicks / qualifying.length * 100).toFixed(1)}%) were Draw picks.`);

    const { win, loss } = computeStreaks(qualifying);
    const dd = computeMaxDrawdown(qualifying);
    console.log(`  Longest win streak: ${win} | Longest loss streak: ${loss} | Max drawdown: ${fmtNaira(dd.maxAbs)} (${dd.maxPct.toFixed(1)}%)`);

    const seasons = [...new Set(qualifying.map(l => getSeasonLabel(l.date)))].sort();
    for (const season of seasons) {
      const sl = qualifying.filter(l => getSeasonLabel(l.date) === season);
      const sw = sl.filter(l => l.won).length;
      const sst = sl.length * FIXED_STAKE;
      const spl = sl.reduce((s, l) => s + (l.won ? FIXED_STAKE * (l.odds - 1) : -FIXED_STAKE), 0);
      console.log(`    ${season}: ${sl.length} bets | ${sw} wins (${(sw / sl.length * 100).toFixed(1)}%) | ROI: ${(spl / sst * 100).toFixed(2)}%`);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });