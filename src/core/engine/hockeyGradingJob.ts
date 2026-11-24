// Grades hockey_grading_queue from EliteProspects season scores. Usage: npx ts-node src/core/engine/hockeyGradingJob.ts [--write]
import 'dotenv/config';
import { getDb } from '../database/db';
import { fetchLeagueScores, EPGame } from '../../scrapers/hockey/eliteProspectsScraper';

function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function same(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}
function evalSel(market: string, sel: string, hg: number, ag: number): boolean | null {
  const total = hg + ag;
  if (market === 'hockey_totals') {
    const o = /^Over\s+([\d.]+)$/i.exec(sel), u = /^Under\s+([\d.]+)$/i.exec(sel);
    if (o) return total > parseFloat(o[1]);
    if (u) return total < parseFloat(u[1]);
    return null;
  }
  if (market === 'team_totals') {
    const m = /^(Home|Away)\s+(Over|Under)\s+([\d.]+)$/i.exec(sel);
    if (!m) return null;
    const g = m[1].toLowerCase() === 'home' ? hg : ag;
    return m[2].toLowerCase() === 'over' ? g > parseFloat(m[3]) : g < parseFloat(m[3]);
  }
  return null;
}

export async function run(write: boolean): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM hockey_grading_queue WHERE status='pending'`).all() as any[];
  const byLeague = new Map<string, any[]>();
  for (const r of rows) { if (!byLeague.has(r.league)) byLeague.set(r.league, []); byLeague.get(r.league)!.push(r); }
  const upd = db.prepare(`UPDATE hockey_grading_queue SET status='graded', homeGoals=?, awayGoals=?, hit=?, brierScore=?, gradedAt=datetime('now') WHERE id=?`);
  let graded = 0, pending = 0;
  for (const [league, rs] of byLeague) {
    const now = Date.now();
    if (!rs.some(r => new Date(r.startTime).getTime() < now - 3 * 36e5)) { pending += rs.length; continue; }
    let games: EPGame[] = [];
    try { games = (await fetchLeagueScores(league, '2026-2027')).filter(g => g.isCompleted); }
    catch (e: any) { console.log('fetch failed', league, e.message); pending += rs.length; continue; }
    for (const r of rs) {
      const t = new Date(r.startTime).getTime();
      const g = games.find(x => Math.abs(new Date(x.dateTime).getTime() - t) < 24 * 36e5 && same(x.homeTeam, r.homeTeam) && same(x.awayTeam, r.awayTeam));
      const won = g ? evalSel(r.market, r.targetSelection, g.homeScore!, g.awayScore!) : null;
      if (g && won !== null) {
        const h = won ? 1 : 0;
        if (write) upd.run(g.homeScore, g.awayScore, h, Math.pow(r.predictedProbability - h, 2), r.id);
        graded++;
      } else pending++;
    }
  }
  console.log(`${write ? 'WROTE' : 'DRY RUN'}: graded=${graded} still_pending=${pending}`);
}
if (require.main === module) run(process.argv.includes('--write')).then(() => process.exit(0)).catch(e => { console.error('Fatal:', e.message); process.exit(1); });
