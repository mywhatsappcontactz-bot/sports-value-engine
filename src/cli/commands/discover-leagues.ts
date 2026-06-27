// src/cli/commands/discover-leagues.ts
process.env.CLI_SILENT = 'true';

import { getDb } from '../../core/database/db';
import { v4 as uuidv4 } from 'uuid';

const BASE_URL = 'https://api.oddspapi.io/v4';

// OddsPapi sport IDs

const SPORTS = [
  { name: 'football',   sportId: 10 },
  { name: 'basketball', sportId: 11 },
  { name: 'tennis',     sportId: 12 },
  { name: 'hockey',     sportId: 15 },
];
// ─── HELPERS ──────────────────────────────────────────────────────────────────

async function apiFetch<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  const apiKey = process.env.ODDSPAPI_KEY;
  if (!apiKey) throw new Error('ODDSPAPI_KEY not set in .env');

  const url = new URL(`${BASE_URL}${endpoint}`);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('language', 'en');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`OddsPapi ${endpoint} failed: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function normalize(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function discoverLeagues() {
  const db = getDb();

  console.log('\n\x1b[1m\x1b[34m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[1m\x1b[34m   🔍 LEAGUE DISCOVERY\x1b[0m');
  console.log('\x1b[1m\x1b[34m' + '═'.repeat(60) + '\x1b[0m\n');

  const stmt = db.prepare(`
    INSERT INTO league_mappings (id, sport, oddspapiTournamentId, oddspapiTournamentName, oddspapiCategoryName, active)
    VALUES (?, ?, ?, ?, ?, 1)
    ON CONFLICT(oddspapiTournamentId) DO UPDATE SET
      oddspapiTournamentName = excluded.oddspapiTournamentName,
      oddspapiCategoryName   = excluded.oddspapiCategoryName,
      active                 = 1
  `);

  let totalNew = 0;
  let totalUpdated = 0;

  for (const sport of SPORTS) {
    process.stdout.write(`  Fetching ${sport.name} leagues... `);

    try {
      const tournaments = await apiFetch<any[]>('/tournaments', {
        sportId: String(sport.sportId),
      });

      // Only keep tournaments with upcoming or future fixtures
      const active = (tournaments || []).filter(
        t => (t.upcomingFixtures > 0 || t.futureFixtures > 0)
      );

      let sportNew = 0;
      let sportUpdated = 0;

      const upsert = db.transaction((items: any[]) => {
        for (const t of items) {
          const existing = db.prepare(
            'SELECT id FROM league_mappings WHERE oddspapiTournamentId = ?'
          ).get(t.tournamentId);

          if (existing) {
            sportUpdated++;
          } else {
            stmt.run(
              uuidv4(),
              sport.name,
              t.tournamentId,
              t.tournamentName,
              t.categoryName || '',
            );
            sportNew++;
          }
        }
      });

      upsert(active);
      totalNew += sportNew;
      totalUpdated += sportUpdated;

      console.log(`\x1b[32m✔\x1b[0m  ${active.length} leagues (${sportNew} new, ${sportUpdated} existing)`);

    } catch (err: any) {
      console.log(`\x1b[31m✗\x1b[0m  Failed: ${err.message}`);
    }

    // Rate limit — 1 second between requests
    await new Promise(r => setTimeout(r, 1100));
  }

  // Summary
  console.log('\n  ' + '─'.repeat(44));
  console.log(`  New leagues added : \x1b[32m${totalNew}\x1b[0m`);
  console.log(`  Already tracked   : ${totalUpdated}`);

  // Show breakdown by sport
  console.log('\n  \x1b[1mLeagues per sport:\x1b[0m\n');
  for (const sport of SPORTS) {
    const count = (db.prepare(
      'SELECT COUNT(*) as n FROM league_mappings WHERE sport = ? AND active = 1'
    ).get(sport.name) as any).n;

    // Show sample countries
    const samples = db.prepare(
      'SELECT oddspapiCategoryName FROM league_mappings WHERE sport = ? AND active = 1 ORDER BY oddspapiCategoryName LIMIT 8'
    ).all(sport.name) as any[];

    const countries = samples.map((s: any) => s.oddspapiCategoryName).join(', ');
    console.log(`  \x1b[36m${sport.name.padEnd(12)}\x1b[0m ${count} leagues`);
    if (countries) console.log(`  \x1b[90m             ${countries}...\x1b[0m`);
  }

  console.log('\n\x1b[34m' + '═'.repeat(60) + '\x1b[0m');
  console.log('\x1b[32m✅ League discovery complete. Run scan to use real data.\x1b[0m\n');
}

discoverLeagues().catch(err => {
  console.error('\x1b[31m[discover-leagues] Failed:', err.message, '\x1b[0m');
  process.exit(1);
});