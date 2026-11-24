// Grades goals_grading_queue rows from SoccerStats league pages (no API).
// Usage: npx ts-node src/core/engine/goalsGradingJob.ts [--write]
import 'dotenv/config';
import * as cheerio from 'cheerio';
import { getDb } from '../database/db';
import { logger } from '../utils/logger';
import { fetchViaFlare } from '../../scrapers/shared/flareFetch';

const LEAGUE_CODES: Record<string, string> = {
  'La Liga - Spain': 'spain', 'La Liga 2 - Spain': 'spain2',
  'Bundesliga - Germany': 'germany', '2. Bundesliga - Germany': 'germany2',
  'Turkey': 'turkey', 'Netherlands - Eredivisie': 'netherlands',
  'England League 1': 'england3', 'League 1': 'england3',
  'England League 2': 'england4', 'League 2': 'england4',
  'Championship': 'england2', 'England Championship': 'england2',
  'EPL': 'england', 'Serie A - Italy': 'italy',
  'K League 1': 'southkorea', 'Allsvenskan - Sweden': 'sweden',
  'Superettan - Sweden': 'sweden2', 'Czech Republic Liga': 'czechrepublic',
  'Ukraine Premier League': 'ukraine', 'MLS': 'usa', 'China Super League': 'china',
  'Russia Premier League': 'russia', 'Premier League - Russia': 'russia',
  'Scotland Premiership': 'scotland', 'Brazil Série A': 'brazil', 'Brazil Serie A': 'brazil',
  'Brazil Série B': 'brazil2', 'Brazil Serie B': 'brazil2',
  'Eliteserien - Norway': 'norway', 'Ligue 1 - France': 'france',
  'Croatia 1.HNL': 'croatia', 'Saudi Pro League': 'saudiarabia',
  'League of Ireland': 'ireland', 'Switzerland Super League': 'switzerland', 'Swiss Superleague': 'switzerland',
  'Veikkausliiga - Finland': 'finland', 'Ekstraklasa - Poland': 'poland', 'Poland Ekstraklasa': 'poland',
  'Denmark Superliga': 'denmark', 'Superliga - Denmark': 'denmark',
  'Belgium First Division': 'belgium', 'Bulgaria Professional League': 'bulgaria',
  'Austrian Football Bundesliga': 'austria', 'Austria Bundesliga': 'austria',
  'Portugal - Liga Portugal': 'portugal',
};

const ABBREV: Record<string, string> = { utd: 'united', wed: 'wednesday', nottm: 'nottingham', qp: 'queens park' };
function norm(s: string): string {
  const t = s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
  return t.split(' ').map(w => ABBREV[w] ?? w).join(' ');
}
function sameTeam(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

interface Played { kickoff: number; home: string; away: string; hg: number; ag: number }

function parsePlayed(html: string): Played[] {
  const $ = cheerio.load(html);
  const out: Played[] = [];
  $('tr.played-row').each((_i, tr) => {
    const $tr = $(tr);
    const ko = ($tr.find('td.js-local-time').attr('data-kickoff') || '').trim();
    const t = new Date(ko.replace(' ', 'T') + 'Z').getTime();
    const tds = $tr.children('td');
    const home = tds.eq(1).text().replace(/\s+/g, ' ').trim();
    const away = tds.eq(3).text().replace(/\s+/g, ' ').trim();
    const m = /(\d+)\s*:\s*(\d+)/.exec($tr.find('span.score-badge').first().text());
    if (isNaN(t) || !home || !away || !m) return;
    out.push({ kickoff: t, home, away, hg: parseInt(m[1], 10), ag: parseInt(m[2], 10) });
  });
  return out;
}

function evalSel(sel: string, total: number): boolean | null {
  const o = /^Over\s+([\d.]+)$/i.exec(sel.trim());
  if (o) return total > parseFloat(o[1]);
  const u = /^Under\s+([\d.]+)$/i.exec(sel.trim());
  if (u) return total < parseFloat(u[1]);
  return null;
}

export async function runGoalsGradingJob(write: boolean): Promise<void> {
  const db = getDb();
  const now = Date.now();
  const pending = db.prepare(`
    SELECT id, matchId, homeTeam, awayTeam, league, startTime, targetSelection, predictedProbability
    FROM goals_grading_queue
    WHERE status='pending' AND datetime(startTime) < datetime('now','-3 hours')
  `).all() as any[];

  const byLeague = new Map<string, any[]>();
  let noCode = 0;
  for (const r of pending) {
    if (!LEAGUE_CODES[r.league]) { noCode++; continue; }
    const code = LEAGUE_CODES[r.league];
    if (!byLeague.has(code)) byLeague.set(code, []);
    byLeague.get(code)!.push(r);
  }

  let graded = 0, stillPending = 0, expired = 0;
  const upd = db.prepare(`UPDATE goals_grading_queue SET status='graded', actualGoals=?, hit=?, brierScore=?, gradedAt=datetime('now') WHERE id=?`);
  const exp = db.prepare(`UPDATE goals_grading_queue SET status='unresolvable' WHERE id=?`);

  for (const [code, rows] of byLeague) {
    // Skip fetching if nothing is recent enough to still be on the page.
    const recent = rows.filter(r => now - new Date(r.startTime).getTime() < 30 * 864e5);
    let played: Played[] = [];
    if (recent.length) {
      try {
        played = parsePlayed(await fetchViaFlare(`https://www.soccerstats.com/latest.asp?league=${code}`));
      } catch (e: any) {
        logger.warn('[GoalsGrading] fetch failed', { code, error: e.message });
      }
      await new Promise(r => setTimeout(r, 3000));
    }
    for (const r of rows) {
      const t = new Date(r.startTime).getTime();
      const hit = played.find(p => Math.abs(p.kickoff - t) < 36 * 36e5 && sameTeam(p.home, r.homeTeam) && sameTeam(p.away, r.awayTeam));
      if (hit) {
        const total = hit.hg + hit.ag;
        const won = evalSel(r.targetSelection, total);
        if (won !== null) {
          const h = won ? 1 : 0;
          if (write) upd.run(total, h, Math.pow(r.predictedProbability - h, 2), r.id);
          graded++;
          continue;
        }
      }
      if (now - t > 30 * 864e5) { if (write) exp.run(r.id); expired++; } else stillPending++;
    }
  }
  console.log(`${write ? 'WROTE' : 'DRY RUN'}: graded=${graded} still_pending=${stillPending} marked_unresolvable=${expired} league_not_mapped=${noCode}`);
}

if (require.main === module) {
  runGoalsGradingJob(process.argv.includes('--write'))
    .then(() => process.exit(0))
    .catch(e => { console.error('Fatal:', e.message); process.exit(1); });
}
