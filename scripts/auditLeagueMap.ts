import 'dotenv/config';
import { PROBALLERS_LEAGUE_MAP } from '../src/scrapers/basketball/Proballersscraper';

const EXCLUDED = new Set([
  'Philippines - PBA', 'Liga A - Argentina', 'BSN - Puerto Rico', 'NBL - Australia',
  'Elite 2 - France', 'Korisliiga - Finland', 'Liga - Uruguay', 'NBL - New Zealand',
  'Superleague - Georgia', 'Serie A2 - Italy',
]);

(async () => {
  const headers = {
    'User-Agent': process.env.PROBALLERS_UA || '',
    'Cookie': `cf_clearance=${process.env.PROBALLERS_COOKIE || ''}`,
  };
  const problems: string[] = [];
  let blocked = 0;
  for (const [name, { id, slug }] of Object.entries(PROBALLERS_LEAGUE_MAP)) {
    const url = `https://www.proballers.com/basketball/league/${id}/${slug}/schedule`;
    const tag = EXCLUDED.has(name) ? ' (excluded)' : '';
    try {
      const res = await fetch(url, { headers });
      const html = await res.text();
      const rows = (html.match(/SportsEvent/g) || []).length;
      const moved = !res.url.includes(`/${slug}/schedule`);
      let verdict = 'ok';
      if (res.status !== 200) verdict = `HTTP ${res.status} <-- CHECK`;
      else if (moved) verdict = `REDIRECT -> ${res.url} <-- CHECK`;
      else if (rows === 0) verdict = 'ZERO ROWS <-- CHECK';
      console.log(`${(name + tag).padEnd(44)} status=${res.status} rows=${String(rows).padEnd(5)} ${verdict}`);
      if (verdict !== 'ok' && !EXCLUDED.has(name)) problems.push(name);
      blocked = res.status === 403 ? blocked + 1 : 0;
      if (blocked >= 3) { console.log('Stopping: 3 blocks in a row. Cookie is not working.'); process.exit(1); }
    } catch (e: any) {
      console.log(`${(name + tag).padEnd(44)} ERROR ${e.message} <-- CHECK`);
      if (!EXCLUDED.has(name)) problems.push(name);
    }
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log(`\n${problems.length} active league(s) need attention: ${problems.join(', ') || 'none'}`);
})();
