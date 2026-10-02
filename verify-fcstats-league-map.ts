import * as fs from 'fs';

const PROPOSED_MAP: Record<string, string> = {
  'Veikkausliiga - Finland': 'finland',
  'League of Ireland': 'ireland',
  'Superettan - Sweden': 'sweden2',
  'Brazil Série B': 'brazil2',
  'Eliteserien - Norway': 'norway',
  'Allsvenskan - Sweden': 'sweden',
  'Serie A - Italy': 'italy',
  'Super League - China': 'china',
  'Brazil Série A': 'brazil',
  'K League 1': 'southkorea',
  'Denmark Superliga': 'denmark',
  'Austrian Football Bundesliga': 'austria',
  'Premiership - Scotland': 'scotland',
  'Swiss Superleague': 'switzerland',
  'EPL': 'england',
  'Championship': 'england2',
  'League 1': 'england3',
  'League 2': 'england4',
  'La Liga - Spain': 'spain',
  'La Liga 2 - Spain': 'spain2',
  'Ligue 1 - France': 'france',
  'Bundesliga - Germany': 'germany',
  'Dutch Eredivisie': 'netherlands',
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
};

async function checkLeague(leagueName: string, code: string): Promise<{ leagueName: string; code: string; status: string; teamCount: number }> {
  try {
    const res = await fetch(`https://www.soccerstats.com/latest.asp?league=${code}`, { headers: HEADERS });
    if (!res.ok) {
      return { leagueName, code, status: `HTTP ${res.status}`, teamCount: 0 };
    }
    const html = await res.text();

    // Confirm the page actually corresponds to the league we asked for,
    // not a generic "not found" page that still returns 200 — check the
    // canonical URL echoes the same code back.
    const canonicalMatch = new RegExp(`canonical" href="https://www\\.soccerstats\\.com/latest\\.asp\\?league=${code}"`).test(html);

    // Count real team links on the page as a proxy for "does this league
    // actually have data" — reuses the same slug-link pattern confirmed
    // working elsewhere this session, now including the period fix.
    const teamLinkRegex = /href='teamstats\.asp\?league=\w+&stats=[\w.-]+'>([^<]+)<\/a>/g;
    const teams = new Set<string>();
    let m;
    while ((m = teamLinkRegex.exec(html)) !== null) {
      teams.add(m[1]);
    }

    const status = canonicalMatch ? 'OK' : 'OK (canonical mismatch — verify manually)';
    return { leagueName, code, status, teamCount: teams.size };
  } catch (err: any) {
    return { leagueName, code, status: `ERROR: ${err.message}`, teamCount: 0 };
  }
}

async function main() {
  const results = [];
  for (const [leagueName, code] of Object.entries(PROPOSED_MAP)) {
    process.stdout.write(`${leagueName.padEnd(32)} (${code.padEnd(14)}) ... `);
    const result = await checkLeague(leagueName, code);
    console.log(`${result.status} — ${result.teamCount} team links found`);
    results.push(result);
    await new Promise((r) => setTimeout(r, 1000)); // gentle pacing, avoid hammering the site
  }

  const failed = results.filter((r) => !r.status.startsWith('OK') || r.teamCount === 0);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Working: ${results.length - failed.length}/${results.length}`);
  if (failed.length > 0) {
    console.log(`\nNeed attention:`);
    for (const f of failed) {
      console.log(`  ${f.leagueName} (${f.code}): ${f.status}, ${f.teamCount} teams`);
    }
  }
}

main();