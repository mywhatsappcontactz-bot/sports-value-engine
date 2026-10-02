// src/core/engine/hockeyFloorSweep.ts
// Per-season breakdown + win/loss streaks + bankroll simulation comparing
// FIXED stake (non-compounding) vs PERCENT-OF-BALANCE stake (compounding),
// including max drawdown - the real "could I survive this" number.
//
// Also tracks how often the model picked the UNDERDOG (picked side had
// longer/higher odds than the opponent) vs the FAVORITE, and reports the
// real hit rate for each group separately - the same adverse-selection
// check that revealed a real problem in the basketball backtests, run
// here to see if hockey shows the same pattern or not.
//
// FAVORITES-ONLY MODE (new): pass --favorites-only (or set env
// FAVORITES_ONLY=1) to exclude every underdog pick BEFORE streaks,
// bankroll simulation, and the day-by-day histogram are computed - not
// just report it after the fact. This lets you directly compare "all
// qualifying picks" vs "favorites only" bankroll curves and drawdowns,
// since the underdog/favorite breakdown showed underdog picks losing
// money (below breakeven) at every floor except 55%, while favorites
// held an 11-14pp edge over breakeven at EVERY floor.
//
// USAGE:
//   npx ts-node src/core/engine/hockeyFloorSweep.ts
//   npx ts-node src/core/engine/hockeyFloorSweep.ts --favorites-only
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const FLOORS_TO_TEST = [0.55, 0.60, 0.65, 0.70];
const INITIAL_CAPITAL = 1_000_000; // your stated real capital
const FIXED_STAKE = 10_000;        // non-compounding: same stake every bet
const PERCENT_STAKE = 0.01;        // compounding: 1% of CURRENT balance every bet
const FAVORITES_ONLY = process.argv.includes('--favorites-only') || process.env.FAVORITES_ONLY === '1';

const NHL_CSV = process.env.NHL_ODDS_CSV ?? path.join(process.cwd(), 'nhl_all.csv');

interface Leg { date: string; won: boolean; odds: number; opponentOdds: number; confidence: number; }

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

function loadAllHockeyPicks(csvPath: string): Leg[] {
  const rows = parseCsvGeneric(fs.readFileSync(csvPath, 'utf-8'));
  const header = rows[0];
  const col = (n: string) => header.indexOf(n);
  const idx = { date: col('Date'), status: col('Status'), home: col('Home_Team'), away: col('Away_Team'), hs: col('Home_Score'), as: col('Away_Score'), ho: col('Home_Odds'), ao: col('Away_Odds') };

  type G = { date: Date; home: string; away: string; hs: number; as: number; ho: number; ao: number };
  const games: G[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < header.length) continue;
    if (r[idx.status]?.trim() !== 'Finished') continue;
    const date = parseFlexibleDate(r[idx.date]);
    if (isNaN(date.getTime())) continue;
    const hs = parseInt(r[idx.hs]), as = parseInt(r[idx.as]);
    if (isNaN(hs) || isNaN(as) || hs === as) continue;
    const ho = parseFloat(r[idx.ho]), ao = parseFloat(r[idx.ao]);
    if (isNaN(ho) || isNaN(ao)) continue;
    games.push({ date, home: r[idx.home].trim(), away: r[idx.away].trim(), hs, as, ho, ao });
  }
  games.sort((a,b) => a.date.getTime() - b.date.getTime());

  const hist = new Map<string, {date:Date;opp:string;res:'W'|'L';home:boolean;pf:number;pa:number}[]>();
  const push = (t:string,r:any) => { if(!hist.has(t)) hist.set(t,[]); hist.get(t)!.push(r); };

  const legs: Leg[] = [];
  for (const g of games) {
    const homeH = hist.get(g.home) ?? [], awayH = hist.get(g.away) ?? [];
    if (homeH.length >= 5 && awayH.length >= 5) {
      const h2h: H2HRecord[] = games.filter(x => x.date < g.date && ((x.home===g.home&&x.away===g.away)||(x.home===g.away&&x.away===g.home)))
       .map(x => { const flip = x.home !== g.home; const hs=flip?x.as:x.hs, as=flip?x.hs:x.as; return {date:x.date.toISOString(),homeTeam:g.home,awayTeam:g.away,homeScore:hs,awayScore:as,winner:(hs>as?'home':'away') as 'home' | 'away'}; });
      const toForm = (recs:any[]):FormRecord[] => recs.slice(-10).map(r=>({date:r.date.toISOString(),opponent:r.opp,result:r.res,goalsFor:r.pf,goalsAgainst:r.pa,venue:r.home?'home':'away'}));
      const matchId = `nhl-${g.home}-${g.away}-${g.date.toISOString()}`;
      const stats: Stats = { id:`s-${matchId}`, matchId, sport:'hockey', h2h, homeForm:toForm(homeH), awayForm:toForm(awayH), referee:{}, situational:{}, additionalContext:{league:'nhl'}, confidenceFactors:{dataCompleteness:1,h2hSampleSize:h2h.length,formSampleSize:10} };
      const input: ModelInput = { match:{id:matchId,sport:'hockey',homeTeam:g.home,awayTeam:g.away,startTime:g.date.toISOString(),league:'nhl'}, stats, odds:[] };
      const probs = getProbabilities(input);
      const homeProb = probs.find(p=>p.market==='moneyline'&&p.selection==='Home')?.trueProbability;
      if (homeProb !== undefined) {
        const favHome = homeProb >= 0.5;
        const confidence = Math.max(homeProb, 1-homeProb);
        const odds = favHome ? g.ho : g.ao;
        const opponentOdds = favHome ? g.ao : g.ho;
        const won = favHome ? g.hs > g.as : g.as > g.hs;
        legs.push({ date: g.date.toISOString().slice(0,10), won, odds, opponentOdds, confidence });
      }
    }
    push(g.home, {date:g.date,opp:g.away,res:g.hs>g.as?'W':'L',home:true,pf:g.hs,pa:g.as});
    push(g.away, {date:g.date,opp:g.home,res:g.as>g.hs?'W':'L',home:false,pf:g.as,pa:g.hs});
  }
  return legs;
}

function computeStreaks(legs: Leg[]): { longestWinStreak: number; longestLoseStreak: number } {
  let longestWinStreak = 0, longestLoseStreak = 0;
  let currentWinStreak = 0, currentLoseStreak = 0;
  for (const l of legs) {
    if (l.won) {
      currentWinStreak++;
      longestWinStreak = Math.max(longestWinStreak, currentWinStreak);
      currentLoseStreak = 0;
    } else {
      currentLoseStreak++;
      longestLoseStreak = Math.max(longestLoseStreak, currentLoseStreak);
      currentWinStreak = 0;
    }
  }
  return { longestWinStreak, longestLoseStreak };
}

function simulateBankroll(legs: Leg[], mode: 'fixed' | 'percent'): { finalBalance: number; maxDrawdownPct: number; maxDrawdownAbs: number; busted: boolean } {
  let balance = INITIAL_CAPITAL;
  let peak = INITIAL_CAPITAL;
  let maxDrawdownAbs = 0, maxDrawdownPct = 0;
  let busted = false;

  for (const l of legs) {
    if (balance <= 0) { busted = true; break; }
    const stake = mode === 'fixed' ? Math.min(FIXED_STAKE, balance) : balance * PERCENT_STAKE;
    const outcome = l.won ? stake * (l.odds - 1) : -stake;
    balance += outcome;
    if (balance > peak) peak = balance;
    const ddAbs = peak - balance;
    const ddPct = peak > 0 ? (ddAbs / peak) * 100 : 0;
    if (ddAbs > maxDrawdownAbs) maxDrawdownAbs = ddAbs;
    if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;
  }

  return { finalBalance: balance, maxDrawdownPct, maxDrawdownAbs, busted };
}

function pickCountHistogram(allLegsAnySeason: Leg[], qualifying: Leg[]): void {
  // "Active days" = any day with at least one game we had a model
  // prediction for at all (regardless of floor) - this tells us the real
  // universe of days you'd be checking the model on.
  const activeDays = new Set(allLegsAnySeason.map(l => l.date));
  const countByDate = new Map<string, number>();
  for (const l of qualifying) countByDate.set(l.date, (countByDate.get(l.date) || 0) + 1);

  const histogram: Record<number, number> = {};
  let zeroPickDays = 0;
  for (const day of activeDays) {
    const count = countByDate.get(day) || 0;
    if (count === 0) zeroPickDays++;
    else histogram[count] = (histogram[count] || 0) + 1;
  }

  console.log(`    Day-by-day distribution (${activeDays.size} total days with any NHL games):`);
  console.log(`      0 qualifying picks: ${zeroPickDays} days (${(zeroPickDays/activeDays.size*100).toFixed(1)}%)`);
  for (const count of Object.keys(histogram).map(Number).sort((a,b)=>a-b)) {
    console.log(`      ${count} qualifying pick(s): ${histogram[count]} days (${(histogram[count]/activeDays.size*100).toFixed(1)}%)`);
  }
  const daysWithAtLeastOne = activeDays.size - zeroPickDays;
  const avgPerActiveDay = qualifying.length / (daysWithAtLeastOne || 1);
  console.log(`      Average picks, on days you had any: ${avgPerActiveDay.toFixed(1)}`);
}

function report(label: string, legs: Leg[], allLegsForThisScope: Leg[]) {
  if (!legs.length) { console.log(`  ${label}: 0 bets`); return; }
  const wins = legs.filter(l => l.won).length;
  const avgOdds = legs.reduce((s,l)=>s+l.odds,0) / legs.length;
  const breakeven = 100/avgOdds;
  const staked = legs.length * FIXED_STAKE;
  const profit = legs.reduce((s,l) => s + (l.won ? FIXED_STAKE*(l.odds-1) : -FIXED_STAKE), 0);

  console.log(`  ${label}: ${legs.length} bets | wins: ${wins} (${(wins/legs.length*100).toFixed(1)}%, need ${breakeven.toFixed(1)}%) | avg odds: ${avgOdds.toFixed(3)} | ROI: ${(profit/staked*100).toFixed(2)}%`);

  // Underdog vs favorite split - picked side had HIGHER odds than the
  // opponent means the market considered the picked side LESS likely to
  // win (an underdog pick). This is the same adverse-selection check
  // run on the basketball backtests, applied to hockey. Still reported
  // even in --favorites-only mode (underdogPicks will just be empty)
  // so the header stays consistent between the two modes.
  const underdogPicks = legs.filter(l => l.odds > l.opponentOdds);
  const favoritePicks = legs.filter(l => l.odds <= l.opponentOdds);
  console.log(`    Picked the underdog (higher odds than opponent): ${underdogPicks.length} times (${((underdogPicks.length/legs.length)*100).toFixed(1)}%)`);
  if (underdogPicks.length) {
    const avgUnderdogOdds = underdogPicks.reduce((s,l)=>s+l.odds,0) / underdogPicks.length;
    const underdogWins = underdogPicks.filter(l=>l.won).length;
    const underdogBreakeven = 100 / avgUnderdogOdds;
    console.log(`      Avg odds when picking underdog: ${avgUnderdogOdds.toFixed(3)} | Hit rate: ${((underdogWins/underdogPicks.length)*100).toFixed(1)}% (need ${underdogBreakeven.toFixed(1)}%)`);
  }
  if (favoritePicks.length) {
    const avgFavoriteOdds = favoritePicks.reduce((s,l)=>s+l.odds,0) / favoritePicks.length;
    const favoriteWins = favoritePicks.filter(l=>l.won).length;
    const favoriteBreakeven = 100 / avgFavoriteOdds;
    console.log(`    Picked the favorite (lower/equal odds than opponent): ${favoritePicks.length} times (${((favoritePicks.length/legs.length)*100).toFixed(1)}%)`);
    console.log(`      Avg odds when picking favorite: ${avgFavoriteOdds.toFixed(3)} | Hit rate: ${((favoriteWins/favoritePicks.length)*100).toFixed(1)}% (need ${favoriteBreakeven.toFixed(1)}%)`);
  }

  const { longestWinStreak, longestLoseStreak } = computeStreaks(legs);
  console.log(`    Streaks: longest win ${longestWinStreak}, longest loss ${longestLoseStreak}`);

  const fixedSim = simulateBankroll(legs, 'fixed');
  const percentSim = simulateBankroll(legs, 'percent');
  console.log(`    FIXED stake (₦${FIXED_STAKE.toLocaleString()}/bet, non-compounding): final balance ₦${Math.round(fixedSim.finalBalance).toLocaleString()} | max drawdown ₦${Math.round(fixedSim.maxDrawdownAbs).toLocaleString()} (${fixedSim.maxDrawdownPct.toFixed(1)}%)${fixedSim.busted ? ' | BUSTED' : ''}`);
  console.log(`    PERCENT stake (${(PERCENT_STAKE*100).toFixed(0)}% of balance/bet, compounding): final balance ₦${Math.round(percentSim.finalBalance).toLocaleString()} | max drawdown ${percentSim.maxDrawdownPct.toFixed(1)}%${percentSim.busted ? ' | BUSTED' : ''}`);

  pickCountHistogram(allLegsForThisScope, legs);
}

async function main() {
  console.log(`Running model once across all games, then testing multiple floors${FAVORITES_ONLY ? ' (FAVORITES-ONLY MODE - underdog picks excluded)' : ''}...\n`);
  const allLegs = loadAllHockeyPicks(NHL_CSV);
  console.log(`Total games with a model prediction: ${allLegs.length}\n`);

  const seasons = [...new Set(allLegs.map(l => getSeasonLabel(l.date)))].sort();

  for (const floor of FLOORS_TO_TEST) {
    console.log(`\n========== FLOOR ${(floor*100).toFixed(0)}% ${FAVORITES_ONLY ? '(favorites only)' : ''} ==========`);
    // In favorites-only mode, the underdog filter is applied HERE, before
    // streaks/bankroll/histogram are computed - not just reported after
    // the fact. This is the actual strategy change, not just a display
    // filter: it changes bet sequencing, drawdown, and bankroll growth.
    const qualifying = allLegs
      .filter(l => l.confidence >= floor)
      .filter(l => !FAVORITES_ONLY || l.odds <= l.opponentOdds);

    console.log(`COMBINED (all seasons):`);
    report('Combined', qualifying, allLegs);

    for (const season of seasons) {
      const seasonLegs = qualifying.filter(l => getSeasonLabel(l.date) === season);
      const seasonAllLegs = allLegs.filter(l => getSeasonLabel(l.date) === season);
      if (!seasonLegs.length) continue;
      console.log(`\n${season}:`);
      report(season, seasonLegs, seasonAllLegs);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });