// src/core/engine/mergeGoalieGSAx.ts
//
// Joins MoneyPuck goalie game-by-game data onto an SBRO puck-line file
// and prints a rolling-GSAx feature check — the first step toward
// actually using goalie data in the model, not yet wired into a
// backtest.
//
// WHY THIS EXISTS: every backtest run tonight found no edge using the
// model's existing signal set. The agreed next step is real new
// features — goalie performance first, since MoneyPuck makes it a free
// CSV download with no scraping needed.
//
// ⚠ COLUMN NAMES ARE UNVERIFIED FOR GAME-BY-GAME FILES.
// I could only confirm the SEASON-SUMMARY column layout (one row per
// goalie per season):
//   playerId,season,name,team,position,situation,games_played,icetime,
//   xGoals,goals,unblocked_shot_attempts,xRebounds,rebounds,...
// The GAME-BY-GAME download (season, goalies -> the link under "Game By
// Game Level Data" on moneypuck.com/data.htm) almost certainly adds a
// game identifier, date, opponent, and home/away column, but I have not
// seen its actual header row. This script reads the header dynamically
// and looks for several plausible names per field (see COLUMN_CANDIDATES
// below). If it can't find a required column, it prints every header it
// DID find and stops — paste that back to me and I'll fix the mapping
// in under a minute, rather than guessing wrong and joining garbage.
//
// DOWNLOAD FIRST (not done by this script — no scraping, per MoneyPuck's
// own terms; these are direct CSV links, not scraped):
//   https://peter-tanner.com/moneypuck/downloads/seasonPlayersSummary/goalies/<year>.zip
//   e.g. goalies/2016.zip for the 2016-2017 season. Unzip it, you'll get
//   one or more CSVs — point this script at the goalie CSV.
//
// USAGE:
//   npx ts-node src/core/engine/mergeGoalieGSAx.ts <moneypuck-goalies.csv> <sbro-file.txt> <season-start-year>
//   npx ts-node src/core/engine/mergeGoalieGSAx.ts "C:\...\goalies2016.csv" "C:\Users\USER\Documents\nhl 2016 2017.txt" 2016
//
// season-start-year = the calendar year the season STARTS in (2016 for
// the 2016-2017 season). Needed because SBRO date labels have no year,
// and NHL seasons cross a calendar-year boundary (Oct Year -> Apr Year+1).

import * as fs from 'fs';

// ─── CONFIG ─────────────────────────────────────────────────────────────

const ROLLING_WINDOW = 10; // last N starts, same "prior games only" discipline as form/H2H elsewhere
const MIN_PRIOR_STARTS = 3;

// MoneyPuck 3-letter code -> full name as it appears in your SBRO files.
// Extend this if a team is missing and the script reports it.
const TEAM_CODE_TO_NAME: Record<string, string> = {
  ANA: 'Anaheim Ducks', ARI: 'Arizona Coyotes', UTA: 'Utah Hockey Club',
  BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche',
  CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars', DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings',
  MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils', NYI: 'New York Islanders', NYR: 'New York Rangers',
  OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins',
  SJS: 'San Jose Sharks', SEA: 'Seattle Kraken', STL: 'St. Louis Blues',
  TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', VAN: 'Vancouver Canucks',
  VGK: 'Vegas Golden Knights', WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
};
const NAME_TO_TEAM_CODE: Record<string, string> = Object.fromEntries(
  Object.entries(TEAM_CODE_TO_NAME).map(([code, name]) => [name, code])
);

// SBRO's own team-field format, confirmed from an actual run: short,
// concatenated city/nickname strings, NOT the full names above.
// e.g. "Toronto", "St.Louis", "LosAngeles", "SanJose", "NYIslanders".
// This is a 30-team map (2016-17 season, pre-VGK/SEA expansion) — add
// VGK/SEA entries if you run this against a season that includes them.
const SBRO_TEAM_TO_CODE: Record<string, string> = {
  Toronto: 'TOR', Ottawa: 'OTT', 'St.Louis': 'STL', Chicago: 'CHI',
  Calgary: 'CGY', Edmonton: 'EDM', LosAngeles: 'LAK', SanJose: 'SJS',
  Boston: 'BOS', Columbus: 'CBJ', Montreal: 'MTL', Buffalo: 'BUF',
  NYIslanders: 'NYI', NYRangers: 'NYR', Detroit: 'DET', TampaBay: 'TBL',
  NewJersey: 'NJD', Florida: 'FLA', Carolina: 'CAR', Winnipeg: 'WPG',
  Washington: 'WSH', Pittsburgh: 'PIT', Minnesota: 'MIN', Anaheim: 'ANA',
  Dallas: 'DAL', Nashville: 'NSH', Philadelphia: 'PHI', Colorado: 'COL',
  Arizona: 'ARI', Vancouver: 'VAN',
  // Later-season additions — uncomment/add if needed:
  // VegasGoldenKnights: 'VGK', Seattle: 'SEA', Utah: 'UTA',
};

// ─── CLI ────────────────────────────────────────────────────────────────

const [goalieCsvPath, sbroPath, seasonStartYearStr] = process.argv.slice(2);
if (!goalieCsvPath || !sbroPath || !seasonStartYearStr) {
  console.error('Usage: npx ts-node src/core/engine/mergeGoalieGSAx.ts <moneypuck-goalies.csv> <sbro-file.txt> <season-start-year>');
  console.error('Example: ... goalies2016.csv "nhl 2016 2017.txt" 2016');
  process.exit(1);
}
const seasonStartYear = parseInt(seasonStartYearStr, 10);
if (isNaN(seasonStartYear)) {
  console.error(`season-start-year must be a number, got "${seasonStartYearStr}"`);
  process.exit(1);
}
for (const p of [goalieCsvPath, sbroPath]) {
  if (!fs.existsSync(p)) { console.error(`File not found: ${p}`); process.exit(1); }
}

// ─── FLEXIBLE CSV HEADER MATCHING ──────────────────────────────────────

const COLUMN_CANDIDATES: Record<string, string[]> = {
  playerId: ['playerId', 'player_id'],
  name: ['name', 'playerName', 'player_name'],
  team: ['team', 'playerTeam', 'team_code'],
  position: ['position', 'pos'],
  situation: ['situation'],
  gameId: ['gameId', 'game_id', 'gameID'],
  gameDate: ['gameDate', 'game_date', 'date'],
  homeOrAway: ['home_or_away', 'homeOrAway', 'home_away'],
  opposingTeam: ['opposingTeam', 'opposing_team', 'opponent'],
  icetime: ['icetime', 'iceTime', 'ice_time'],
  xGoals: ['xGoals', 'xgoals'],
  goals: ['goals'],
};

function parseCsvLine(line: string): string[] {
  // MoneyPuck's numeric/categorical columns don't contain embedded
  // commas in the sample seen so far, so a plain split is sufficient.
  // If this ever misparses (a quoted field), row counts will look wrong
  // fast because every row will be the wrong length — that's the signal
  // to swap in a real CSV parser (papaparse is already available).
  return line.split(',');
}

function buildColumnMap(header: string[]): { map: Record<string, number>; missing: string[] } {
  const map: Record<string, number> = {};
  const missing: string[] = [];
  for (const [field, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    const idx = header.findIndex(h => candidates.includes(h.trim()));
    if (idx === -1) {
      missing.push(field);
    } else {
      map[field] = idx;
    }
  }
  return { map, missing };
}

// ─── LOAD GOALIE DATA ───────────────────────────────────────────────────

interface GoalieGameRow {
  playerId: string; name: string; team: string; gameId: string;
  gameDate: string; icetime: number; xGoals: number; goals: number;
}

function loadGoalieRows(path: string): GoalieGameRow[] {
  const text = fs.readFileSync(path, 'utf-8');
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const { map, missing } = buildColumnMap(header);

  // gameId / gameDate are the two fields most likely to have a different
  // name in the real file — everything else is confirmed from the
  // season-summary schema. Fail loudly and specifically rather than
  // silently joining on garbage.
  const hardRequired = ['playerId', 'name', 'team', 'icetime', 'xGoals', 'goals'];
  const hardMissing = hardRequired.filter(f => missing.includes(f));
  if (hardMissing.length) {
    console.error(`Could not find required column(s): ${hardMissing.join(', ')}`);
    console.error(`Actual headers in this file:\n  ${header.join(', ')}`);
    console.error(`\nPaste that header line back and I'll fix COLUMN_CANDIDATES.`);
    process.exit(1);
  }
  if (missing.includes('gameId') && missing.includes('gameDate')) {
    console.error(`Found no game-identifying column (need one of: ${[...COLUMN_CANDIDATES.gameId, ...COLUMN_CANDIDATES.gameDate].join(', ')}).`);
    console.error(`Actual headers in this file:\n  ${header.join(', ')}`);
    console.error(`\nWithout a per-game identifier this file may be season-summary`);
    console.error(`data (one row per goalie per SEASON), not game-by-game. Re-check`);
    console.error(`you downloaded from the "Game By Game Level Data" table, not the`);
    console.error(`"Season Level Data" table, on moneypuck.com/data.htm.`);
    process.exit(1);
  }
  if (missing.includes('situation')) {
    console.warn(`No "situation" column found — proceeding without filtering to "all".`);
    console.warn(`If this file mixes 5on5/PP/PK rows per game without a situation`);
    console.warn(`column, icetime/xGoals/goals below may be double-counted.`);
  }

  const rows: GoalieGameRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    if (f.length < header.length) continue;
    if (map.situation !== undefined && f[map.situation].trim() !== 'all') continue; // one row per goalie-game, full game
    const icetime = parseFloat(f[map.icetime]);
    const xGoals = parseFloat(f[map.xGoals]);
    const goals = parseFloat(f[map.goals]);
    if (isNaN(icetime) || isNaN(xGoals) || isNaN(goals) || icetime <= 0) continue;
    rows.push({
      playerId: f[map.playerId],
      name: f[map.name],
      team: f[map.team].trim(),
      gameId: map.gameId !== undefined ? f[map.gameId] : f[map.gameDate],
      gameDate: map.gameDate !== undefined ? f[map.gameDate] : f[map.gameId],
      icetime, xGoals, goals,
    });
  }
  return rows;
}

// ─── STARTER IDENTIFICATION + ROLLING GSAx ─────────────────────────────
//
// A goalie-game row exists for every goalie who saw ANY ice time,
// including relief appearances. The "starter" for a team in a game is
// the goalie with the most icetime in that (team, gameId) pair.

interface StarterAppearance {
  gameId: string; gameDate: string; team: string;
  playerId: string; name: string; gsaxPer60: number;
}

function identifyStarters(rows: GoalieGameRow[]): StarterAppearance[] {
  const byTeamGame = new Map<string, GoalieGameRow[]>();
  for (const r of rows) {
    const key = `${r.team}__${r.gameId}`;
    if (!byTeamGame.has(key)) byTeamGame.set(key, []);
    byTeamGame.get(key)!.push(r);
  }
  const starters: StarterAppearance[] = [];
  for (const group of byTeamGame.values()) {
    const starter = group.reduce((a, b) => (b.icetime > a.icetime ? b : a));
    const gsaxPer60 = ((starter.xGoals - starter.goals) / starter.icetime) * 3600;
    starters.push({
      gameId: starter.gameId, gameDate: starter.gameDate, team: starter.team,
      playerId: starter.playerId, name: starter.name, gsaxPer60,
    });
  }
  return starters;
}

// Rolling GSAx/60 over the goalie's PRIOR N starts only — same
// no-lookahead discipline as buildHistory() elsewhere in this codebase.
function computeRollingGSAx(starters: StarterAppearance[]): Map<string, { date: string; rollingGsax: number | null }[]> {
  const byPlayer = new Map<string, StarterAppearance[]>();
  for (const s of starters) {
    if (!byPlayer.has(s.playerId)) byPlayer.set(s.playerId, []);
    byPlayer.get(s.playerId)!.push(s);
  }
  const result = new Map<string, { date: string; rollingGsax: number | null }[]>();
  for (const [playerId, apps] of byPlayer) {
    const sorted = [...apps].sort((a, b) => a.gameDate.localeCompare(b.gameDate));
    const series: { date: string; rollingGsax: number | null }[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const prior = sorted.slice(Math.max(0, i - ROLLING_WINDOW), i);
      const rollingGsax = prior.length >= MIN_PRIOR_STARTS
        ? prior.reduce((s, a) => s + a.gsaxPer60, 0) / prior.length
        : null;
      series.push({ date: sorted[i].gameDate, rollingGsax });
    }
    result.set(playerId, series);
  }
  return result;
}

// ─── SBRO SIDE (date-label parsing, matches existing scripts) ─────────

function parseMonthDay(dateLabel: string): { month: number; day: number } {
  const s = dateLabel.trim();
  if (s.length === 3) return { month: parseInt(s[0], 10), day: parseInt(s.slice(1), 10) };
  return { month: parseInt(s.slice(0, 2), 10), day: parseInt(s.slice(2), 10) };
}
// NHL seasons run roughly Oct(year) -> Jun(year+1). Aug/Sep are preseason
// (already excluded elsewhere) but included here in case this script
// runs on unfiltered input.
function inferIsoDate(dateLabel: string, seasonStartYear: number): string {
  const { month, day } = parseMonthDay(dateLabel);
  const year = month >= 7 ? seasonStartYear : seasonStartYear + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

interface SbroRow { date: string; vh: string; team: string; }
function parseSbroTeams(text: string): SbroRow[] {
  const lines = text.trim().split(/\r?\n/);
  const rows: SbroRow[] = [];
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 16) continue;
    if (!/^\d+$/.test(fields[0])) continue;
    const vh = fields[2];
    if (vh !== 'V' && vh !== 'H' && vh !== 'N') continue;
    rows.push({ date: fields[0], vh, team: fields[3] });
  }
  return rows;
}

// ─── MAIN ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Loading goalie data from ${goalieCsvPath} ...`);
  const goalieRows = loadGoalieRows(goalieCsvPath);
  console.log(`Loaded ${goalieRows.length} goalie-game rows (situation=all, icetime>0).`);

  const starters = identifyStarters(goalieRows);
  console.log(`Identified ${starters.length} starter appearances (max-icetime goalie per team per game).`);

  const rolling = computeRollingGSAx(starters);
  const totalStarts = [...rolling.values()].reduce((s, arr) => s + arr.length, 0);
  const withRolling = [...rolling.values()].reduce((s, arr) => s + arr.filter(x => x.rollingGsax !== null).length, 0);
  console.log(`${withRolling}/${totalStarts} starts have a rolling GSAx/60 (>= ${MIN_PRIOR_STARTS} prior starts).\n`);

  console.log(`Loading SBRO file from ${sbroPath} ...`);
  const sbroText = fs.readFileSync(sbroPath, 'utf-8');
  const sbroRows = parseSbroTeams(sbroText);
  console.log(`Parsed ${sbroRows.length} SBRO team-rows.`);

  // Sanity check: does every SBRO team name resolve to a MoneyPuck code?
  const unknownTeams = new Set<string>();
  for (const r of sbroRows) {
    if (!SBRO_TEAM_TO_CODE[r.team] && !NAME_TO_TEAM_CODE[r.team] && !TEAM_CODE_TO_NAME[r.team]) {
      unknownTeams.add(r.team);
    }
  }
  if (unknownTeams.size) {
    console.warn(`\n${unknownTeams.size} distinct team string(s) in the SBRO file did not resolve:`);
    console.warn(`  ${[...unknownTeams].join(', ')}`);
    console.warn(`Add these to SBRO_TEAM_TO_CODE at the top of this file, mapped to`);
    console.warn(`their MoneyPuck 3-letter code (e.g. if you see an expansion team`);
    console.warn(`like "VegasGoldenKnights" or "Seattle", add VGK/SEA respectively).`);
  }

  // Season-opener rows will always show "(none found)" correctly — no
  // goalie has a PRIOR start on day one. That's not a bug, but it also
  // doesn't validate the join. Sample from partway into the file too,
  // where goalies actually have starts behind them.
  console.log(`\n── Sample join check (first 10 resolvable rows) ──`);
  console.log('SBRO date   Team                  Inferred ISO date   Goalie              RollingGSAx/60');
  printJoinSample(sbroRows.slice(0, 40), 10);

  const midStart = Math.floor(sbroRows.length / 2);
  console.log(`\n── Sample join check (10 rows from mid-file, index ~${midStart}) ──`);
  console.log('SBRO date   Team                  Inferred ISO date   Goalie              RollingGSAx/60');
  printJoinSample(sbroRows.slice(midStart, midStart + 60), 10);

  function printJoinSample(pool: SbroRow[], limit: number) {
    let shown = 0;
    for (const r of pool) {
      if (shown >= limit) break;
      const code = SBRO_TEAM_TO_CODE[r.team] ?? NAME_TO_TEAM_CODE[r.team] ?? (TEAM_CODE_TO_NAME[r.team] ? r.team : null);
      if (!code) continue;
      const isoDate = inferIsoDate(r.date, seasonStartYear);
      let best: { date: string; rollingGsax: number | null; name: string } | null = null;
      for (const [playerId, series] of rolling) {
        const playerName = starters.find(s => s.playerId === playerId)?.name ?? playerId;
        for (const entry of series) {
          const app = starters.find(s => s.playerId === playerId && s.gameDate === entry.date);
          if (!app || app.team !== code) continue;
          if (entry.date >= isoDate) continue;
          if (!best || entry.date > best.date) best = { date: entry.date, rollingGsax: entry.rollingGsax, name: playerName };
        }
      }
      console.log(
        `${r.date.padEnd(11)} ${r.team.padEnd(21)} ${isoDate.padEnd(19)} ` +
        `${(best?.name ?? '(none found)').padEnd(19)} ${best?.rollingGsax !== undefined && best?.rollingGsax !== null ? best.rollingGsax.toFixed(2) : 'n/a'}`
      );
      shown++;
    }
  }

  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`This is a JOIN CHECK, not a backtest. Before wiring GSAx into`);
  console.log(`sbroNhlPuckLineBacktest.ts as a feature:`);
  console.log(`  1. Confirm the sample join above looks right — correct team,`);
  console.log(`     a plausible starting goalie, a date strictly in the past.`);
  console.log(`  2. Fix any "unknown team" or "(none found)" rows first.`);
  console.log(`  3. Only then should rolling GSAx get added to the model as`);
  console.log(`     an input — adding an unvalidated join to a probability`);
  console.log(`     model is how silent bugs like the ones fixed earlier`);
  console.log(`     tonight get created, not caught.`);
  console.log(`────────────────────────────────────────────────────────────`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });