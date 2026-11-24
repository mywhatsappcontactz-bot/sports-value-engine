// Grades basketball_grading_queue from Proballers current-season schedules (NBA: not wired yet).
// Usage: npx ts-node src/core/engine/basketballGradingJob.ts [--write]
import 'dotenv/config';
import { getDb } from '../database/db';
import { fetchLeagueSchedule } from '../../scrapers/basketball/Proballersscraper';

function evalSel(market: string, sel: string, hs: number, as: number): boolean | null {
  const total = hs + as;
  if (market === 'moneyline') return sel === 'Home' ? hs > as : sel === 'Away' ? as > hs : null;
  if (market === 'totals' || market === 'totals_free') {
    const o = /^Over\s+([\d.]+)$/i.exec(sel), u = /^Under\s+([\d.]+)$/i.exec(sel);
    return o ? total > parseFloat(o[1]) : u ? total < parseFloat(u[1]) : null;
  }
  if (market === 'team_points_over' || market === 'team_points_under') {
    const m = /^(Home|Away)\s+(Over|Under)\s+([\d.]+)$/i.exec(sel);
    if (!m) return null;
    const pts = m[1].toLowerCase() === 'home' ? hs : as;
    return m[2].toLowerCase() === 'over' ? pts > parseFloat(m[3]) : pts < parseFloat(m[3]);
  }
  return null;
}

async function fetchNbaFinals(): Promise<{ date: string; home: string; away: string; hp: number; ap: number }[]> {
  const months = ['october','november','december','january','february','march','april','may','june'];
  const now = new Date();
  const seasonYear = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const cur = ['january','february','march','april','may','june'][now.getMonth()] ?? months[now.getMonth() - 9];
  const out: { date: string; home: string; away: string; hp: number; ap: number }[] = [];
  for (const month of months.slice(0, months.indexOf(cur) + 1)) {
    try {
      const res = await fetch(`https://www.basketball-reference.com/leagues/NBA_${seasonYear}_games-${month}.html`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' } });
      if (!res.ok) continue;
      const html = await res.text();
      const rowRegex = /<tr ><th scope="row" class="left " data-stat="date_game" csk="(\d{8})[^"]*"[\s\S]*?<\/tr>/g;
      let m: RegExpExecArray | null;
      while ((m = rowRegex.exec(html)) !== null) {
        const row = m[0];
        const v = row.match(/data-stat="visitor_team_name"[^>]*><a[^>]*>([^<]+)<\/a>/);
        const h = row.match(/data-stat="home_team_name"[^>]*><a[^>]*>([^<]+)<\/a>/);
        const vp = row.match(/data-stat="visitor_pts"\s*>(\d+)</);
        const hp = row.match(/data-stat="home_pts"\s*>(\d+)</);
        if (!v || !h || !vp || !hp) continue;
        out.push({ date: `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)}`, home: h[1], away: v[1], hp: parseInt(hp[1],10), ap: parseInt(vp[1],10) });
      }
    } catch { /* skip month */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  return out;
}

export async function run(write: boolean): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM basketball_grading_queue WHERE status='pending'`).all() as any[];
  const byLeague = new Map<string, any[]>();
  for (const r of rows) { if (!byLeague.has(r.league)) byLeague.set(r.league, []); byLeague.get(r.league)!.push(r); }
  const upd = db.prepare(`UPDATE basketball_grading_queue SET status='graded', homeScore=?, awayScore=?, hit=?, brierScore=?, gradedAt=datetime('now') WHERE id=?`);
  let graded = 0, pending = 0, nba = 0;
  for (const [league, rs] of byLeague) {
    if (league === 'WNBA') { nba += rs.length; continue; }
    if (league === 'NBA') {
      if (!rs.some(r => new Date(r.startTime).getTime() < Date.now() - 4 * 36e5)) { pending += rs.length; continue; }
      const finals = await fetchNbaFinals();
      for (const r of rs) {
        const day = new Date(r.startTime).toISOString().slice(0, 10);
        const g = finals.find(x => x.home === r.homeTeam && x.away === r.awayTeam && Math.abs(new Date(x.date).getTime() - new Date(day).getTime()) <= 36e5 * 36);
        const won = g ? evalSel(r.market, r.targetSelection, g.hp, g.ap) : null;
        if (g && won !== null) {
          const h = won ? 1 : 0;
          if (write) upd.run(g.hp, g.ap, h, Math.pow(r.predictedProbability - h, 2), r.id);
          graded++;
        } else pending++;
      }
      continue;
    }
    if (!rs.some(r => new Date(r.startTime).getTime() < Date.now() - 4 * 36e5)) { pending += rs.length; continue; }
    let games: any[] = [];
    try { games = await fetchLeagueSchedule(league); } catch (e: any) { console.log('fetch failed', league, e.message); pending += rs.length; continue; }
    await new Promise(r => setTimeout(r, 3000));
    for (const r of rs) {
      const t = new Date(r.startTime).getTime();
      const g = games.find(x => Math.abs(new Date(x.date).getTime() - t) < 36 * 36e5 && x.homeTeam === r.homeTeam && x.awayTeam === r.awayTeam);
      const won = g ? evalSel(r.market, r.targetSelection, g.homeScore, g.awayScore) : null;
      if (g && won !== null) {
        const h = won ? 1 : 0;
        if (write) upd.run(g.homeScore, g.awayScore, h, Math.pow(r.predictedProbability - h, 2), r.id);
        graded++;
      } else pending++;
    }
  }
  console.log(`${write ? 'WROTE' : 'DRY RUN'}: graded=${graded} still_pending=${pending} nba_not_wired=${nba}`);
}
if (require.main === module) run(process.argv.includes('--write')).then(() => process.exit(0)).catch(e => { console.error('Fatal:', e.message); process.exit(1); });
