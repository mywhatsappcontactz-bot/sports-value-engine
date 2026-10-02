// src/core/engine/acbOddsBacktest.ts
import * as fs from 'fs';
import * as path from 'path';
import { getProbabilities, ModelInput } from './probabilityModel';
import { Stats, FormRecord, H2HRecord } from '../database/schema';

const CONFIDENCE_FLOOR = 0.70;
const STAKE = 10000;
const CSV_PATH = process.env.ACB_ODDS_CSV ?? path.join(process.cwd(), 'acb_2016-2017_odds.csv');
const LEAGUE = 'ACB - Spain'; // must match your PROBALLERS_LEAGUE_MAP key exactly

function minAcceptableOdds(confidence: number): number {
  return 1 / (confidence - 0.05);
}

function parseCsv(text: string): string[][] {
  return text.trim().split('\n').map(line => line.split(','));
}

interface OddsGame {
  date: Date;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
  homeOdds: number;
  awayOdds: number;
}

interface TeamGameRecord {
  date: Date; opponent: string; result: 'W' | 'L'; isHome: boolean;
  pointsFor: number; pointsAgainst: number;
}

function loadGames(): OddsGame[] {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8');
  const rows = parseCsv(raw);
  const games: OddsGame[] = [];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length < 8) continue;
    const [status, homeScore, home, awayScore, away, homeOdds, awayOdds, dateInfo] = r;
    if (status !== 'Finished') continue;

    const dateStr = dateInfo.split(' - ')[0].trim(); // strip "- Play Offs" etc.
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) continue;

    games.push({
      date,
      home: home.trim(),
      away: away.trim(),
      homeScore: parseInt(homeScore, 10),
      awayScore: parseInt(awayScore, 10),
      homeOdds: parseFloat(homeOdds),
      awayOdds: parseFloat(awayOdds),
    });
  }

  games.sort((a, b) => a.date.getTime() - b.date.getTime());
  console.log(`Loaded ${games.length} finished games with odds`);
  return games;
}

function buildHistory(games: OddsGame[]): Map<string, TeamGameRecord[]> {
  const map = new Map<string, TeamGameRecord[]>();
  const push = (t: string, r: TeamGameRecord) => { if (!map.has(t)) map.set(t, []); map.get(t)!.push(r); };
  for (const g of games) {
    push(g.home, { date: g.date, opponent: g.away, result: g.homeScore > g.awayScore ? 'W' : 'L', isHome: true, pointsFor: g.homeScore, pointsAgainst: g.awayScore });
    push(g.away, { date: g.date, opponent: g.home, result: g.awayScore > g.homeScore ? 'W' : 'L', isHome: false, pointsFor: g.awayScore, pointsAgainst: g.homeScore });
  }
  return map;
}

function toForm(recs: TeamGameRecord[]): FormRecord[] {
  return recs.map(r => ({ date: r.date.toISOString(), opponent: r.opponent, result: r.result, goalsFor: r.pointsFor, goalsAgainst: r.pointsAgainst, venue: r.isHome ? 'home' : 'away' }));
}

function toH2H(home: string, away: string, prior: OddsGame[]): H2HRecord[] {
  return prior.filter(g => (g.home === home && g.away === away) || (g.home === away && g.away === home))
    .map(g => {
      const flip = g.home !== home;
      const hS = flip ? g.awayScore : g.homeScore, aS = flip ? g.homeScore : g.awayScore;
      return { date: g.date.toISOString(), homeTeam: home, awayTeam: away, homeScore: hS, awayScore: aS, winner: hS > aS ? 'home' : 'away' as const };
    });
}

function runBacktest(games: OddsGame[]) {
  const results: { won: boolean; odds: number; confidence: number; clearedFloor: boolean }[] = [];

  for (const game of games) {
    const prior = games.filter(g => g.date.getTime() < game.date.getTime());
    const hist = buildHistory(prior);
    const homeH = hist.get(game.home) ?? [], awayH = hist.get(game.away) ?? [];
    if (homeH.length < 5 || awayH.length < 5) continue;

    const h2h = toH2H(game.home, game.away, prior);
    const matchId = `acb-${game.home}-${game.away}-${game.date.toISOString()}`;
    const stats: Stats = {
      id: `s-${matchId}`, matchId, sport: 'basketball', h2h,
      homeForm: toForm(homeH.slice(-10)), awayForm: toForm(awayH.slice(-10)),
      referee: {}, situational: {}, additionalContext: { league: LEAGUE },
      confidenceFactors: { dataCompleteness: 1, h2hSampleSize: h2h.length, formSampleSize: 10 },
    };
    const input: ModelInput = { match: { id: matchId, sport: 'basketball', homeTeam: game.home, awayTeam: game.away, startTime: game.date.toISOString(), league: LEAGUE }, stats, odds: [] };

    const probs = getProbabilities(input);
    const homeProb = probs.find(p => p.market === 'moneyline' && p.selection === 'Home')?.trueProbability;
    if (homeProb === undefined) continue;

    const favHome = homeProb >= 0.5;
    const confidence = Math.max(homeProb, 1 - homeProb);
    if (confidence < CONFIDENCE_FLOOR) continue;

    const won = favHome ? game.homeScore > game.awayScore : game.awayScore > game.homeScore;
    const odds = favHome ? game.homeOdds : game.awayOdds;
    const clearedFloor = odds >= minAcceptableOdds(confidence);

    results.push({ won, odds, confidence, clearedFloor });
  }
  return results;
}

async function main() {
  const games = loadGames();
  const results = runBacktest(games);

  const bet = results; // bet all qualifying, no filter — same as NBA test 2
  const wins = bet.filter(r => r.won).length;
  const staked = bet.length * STAKE;
  const profit = bet.reduce((s, r) => s + (r.won ? STAKE * (r.odds - 1) : -STAKE), 0);

  console.log(`\nQualifying tips: ${results.length}`);
  console.log(`Hit rate: ${((wins / bet.length) * 100).toFixed(1)}% (${wins}W)`);
  console.log(`Total staked: ₦${staked.toLocaleString()}`);
  console.log(`Total profit/loss: ₦${profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
  console.log(`REAL ROI: ${((profit / staked) * 100).toFixed(2)}%`);

  const shortOdds = results.filter(r => !r.clearedFloor);
  const longOdds = results.filter(r => r.clearedFloor);
  console.log(`\nShort-odds hit rate: ${shortOdds.length ? ((shortOdds.filter(r=>r.won).length/shortOdds.length)*100).toFixed(1) : 0}% (n=${shortOdds.length})`);
  console.log(`Long-odds hit rate: ${longOdds.length ? ((longOdds.filter(r=>r.won).length/longOdds.length)*100).toFixed(1) : 0}% (n=${longOdds.length})`);
}

main().catch(err => { console.error(err.message); process.exit(1); });