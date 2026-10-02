// parseOddsPortalAcb.js  (v10 - keeps 3-way odds instead of dropping
// the draw/regulation-tie price. Previous versions (v9 and earlier)
// detected 3-way home/draw/away odds but discarded the middle "draw"
// value, keeping only home/away for 2-way moneyline analysis. This
// version preserves all three so 3-way (Home/Draw/Away) markets can
// be backtested using regulation-time results.
//
// Output changed from:
//   Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Away_Odds
// to:
//   Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Draw_Odds,Away_Odds
//
// For 2-way sports (basketball etc.) where only 2 odds values are
// found, Draw_Odds is left blank - this is expected and fine, those
// rows simply have no draw market.
//
// IMPORTANT: this changes the CSV column count/order. Any downstream
// script reading these CSVs (hockeyRealisticSingleLeagueTest.ts etc.)
// that assumes the old 9-field Home_Odds,Away_Odds-only layout will
// need updating to read the new Draw_Odds column, or to skip it when
// working with old-format files. Don't mix old-format and new-format
// CSVs for the same league without checking which columns a given
// script expects.
//
// v9 added --debug tracing to diagnose the "every row gets the same
// date" bug: pass --debug (or set env PARSE_DEBUG=1) to log every
// line that changes currentDate or currentTournament/currentSeasonKey,
// with the line number and raw text that triggered it.
// Also fixed CLEAN_ROW_RE, which previously only matched
// Finished/After OT rows and silently mis-handled already-clean
// 'After Pen.' rows on re-runs.
//
// v8 added default currentTournament/currentSeasonKey so files with
// no season header line still parse instead of silently recording 0
// games. Also handles "Today, DD Mon" / "Yesterday, DD Mon" date
// formats, which have no year and need CURRENT_YEAR filled in.
//
// v7 fixed status being hardcoded to 'Finished', now correctly
// preserves 'After OT' / 'After Pen.' so downstream backtests can
// exclude OT/shootout games, whose regulation-time 1/2 odds don't
// match the OT-inclusive final score.
//
// Auto-detects 2-way (basketball: home/away) or 3-way (hockey:
// home/draw/away) odds after each game.
//
// Handles ONE file that may contain a mix of already-clean CSV rows
// and raw scattered OddsPortal paste, across any number of
// seasons/leagues.
//
// Output: Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Draw_Odds,Away_Odds
//
// USAGE:
//   node parseOddsPortalAcb.js input.txt output.csv [--debug]
//
// If the input file has NO season header line (e.g. a live log of
// "Today"/"Yesterday" games only), edit DEFAULT_TOURNAMENT and
// DEFAULT_SEASON_KEY below to match the league/season you're pasting,
// before running.

const fs = require('fs');

const DEBUG = process.argv.includes('--debug') || process.env.PARSE_DEBUG === '1';

function getFlagValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const cliTournament = getFlagValue('--tournament');
const cliSeason = getFlagValue('--season');

const positional = process.argv.slice(2).filter((a, idx, arr) => {
  if (a === '--debug') return false;
  if (a === '--tournament' || a === '--season') return false;
  if (arr[idx - 1] === '--tournament' || arr[idx - 1] === '--season') return false;
  return true;
});
const [inputPath, outputPath] = positional;

if (!inputPath || !outputPath) {
  console.error('Usage: node parseOddsPortalAcb.js <input.txt> <output.csv> [--debug] [--tournament "DEL 2025/2026"] [--season "2025/2026"]');
  process.exit(1);
}

// Fallback defaults, only used when a file has NO season header line at
// all (e.g. a live "Today"/"Yesterday"-only log) AND no --tournament /
// --season flag was passed. Prefer passing the flags explicitly per
// league/file instead of relying on these or editing them by hand -
// that's what caused confusion when KHL games without a header line
// silently inherited the wrong season.
const DEFAULT_TOURNAMENT = cliTournament || 'KHL 2026/2027';
const DEFAULT_SEASON_KEY = cliSeason || '2026/2027';

const raw = fs.readFileSync(inputPath, 'utf-8');
const rawLines = raw.split(/\r?\n/);
// lines[k] is the k-th non-blank trimmed line; lineNumbers[k] is that
// line's 1-based line number in the ORIGINAL file (matching what
// Get-Content / Select-String report), since blank lines are stripped
// out here and would otherwise make index-based debug output point at
// the wrong place in the source file.
const lines = [];
const lineNumbers = [];
rawLines.forEach((l, idx) => {
  const trimmed = l.trim();
  if (trimmed.length > 0) {
    lines.push(trimmed);
    lineNumbers.push(idx + 1);
  }
});

const SEASON_RE = /^(.+?)\s+(\d{4}\/\d{4})$/;
const DATE_RE = /^-*(\d{1,2}\s+[A-Za-z]{3}\s+\d{4})(\s*-\s*(.+))?$/;
const TODAY_RE = /^Today,\s*(\d{1,2}\s+[A-Za-z]{3})$/;
const YESTERDAY_RE = /^Yesterday,\s*(\d{1,2}\s+[A-Za-z]{3})$/;
const CURRENT_YEAR = 2026; // update each year you run this on fresh data
const STATUS_RE = /^(Finished|After OT|After Pen\.?)$/;
const SMALL_NUM_RE = /^\d{1,2}$/;
const NOISE_RE = /^Basketball$|^Hockey$|^Spain$|^Germany$|^Turkey$|^Norway$|^Italy$|^USA$|^Sweden$|^Switzerland$|^Finland$|^Russia$|^\/$|^n$|^X$/;
const ODDS_RE = /^\d+\.\d+$/;
// Clean-row regex now accepts EITHER the old 9-field format (no draw
// column) OR the new 10-field format (with draw column), so files
// already re-parsed under v10 can be safely re-run without breaking.
const CLEAN_ROW_RE_NEW = /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4},[^,]+\d{4}\/\d{4},[^,]+,(Finished|After OT|After Pen\.?),[^,]+,\d+,[^,]+,\d+,[\d.]*,[\d.]*,[\d.]*$/i;
const CLEAN_ROW_RE_OLD = /^\d{1,2}\s+[A-Za-z]{3}\s+\d{4},[^,]+\d{4}\/\d{4},[^,]+,(Finished|After OT|After Pen\.?),[^,]+,\d+,[^,]+,\d+,[\d.]+,[\d.]+$/i;
const CLEAN_HEADER_RE_NEW = /^Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Draw_Odds,Away_Odds$/i;
const CLEAN_HEADER_RE_OLD = /^Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Away_Odds$/i;

// FIXED (v8): seeded with defaults instead of null, so files with no
// season header line still get a valid tournament/season and are not
// silently dropped by recordRow's implicit requirement that
// currentTournament be non-null.
let currentTournament = DEFAULT_TOURNAMENT;
let currentSeasonKey = DEFAULT_SEASON_KEY;
let currentDate = null;
let currentStage = 'Regular Season';
const rows = [];
const seasonCounts = {};

function dbg(lineNo, label, oldVal, newVal, lineText) {
  if (!DEBUG) return;
  console.error(`[line ${lineNo}] ${label}: "${oldVal}" -> "${newVal}"  (from: "${lineText}")`);
}

function convertDate(d) {
  const months = { Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12' };
  const m = d.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return d;
  const [, day, mon, year] = m;
  return `${year}-${months[mon]}-${day.padStart(2,'0')}`;
}

// status is a real parameter, no longer hardcoded to 'Finished'.
function recordRow(dateStr, tournament, seasonKey, stage, status, home, homeScore, away, awayScore, homeOdds, drawOdds, awayOdds) {
  rows.push({ date: dateStr, tournament, stage, status, home, homeScore, away, awayScore, homeOdds, drawOdds, awayOdds });
  seasonCounts[seasonKey] = (seasonCounts[seasonKey] || 0) + 1;
}

let i = 0;
let threeWayCount = 0;
let twoWayCount = 0;
while (i < lines.length) {
  const line = lines[i];
  const lineNo = lineNumbers[i];

  if (CLEAN_HEADER_RE_NEW.test(line) || CLEAN_HEADER_RE_OLD.test(line)) { i++; continue; }

  if (CLEAN_ROW_RE_NEW.test(line)) {
    const parts = line.split(',');
    const seasonMatch = parts[1].match(/(\d{4}\/\d{4})$/);
    recordRow(
      convertDate(parts[0]), parts[1], seasonMatch ? seasonMatch[1] : parts[1], parts[2],
      parts[3],
      parts[4], parseInt(parts[5]), parts[6], parseInt(parts[7]),
      parts[8], parts[9], parts[10]
    );
    i++;
    continue;
  }

  if (CLEAN_ROW_RE_OLD.test(line)) {
    // Old-format row with no draw column - carry it through with an
    // empty Draw_Odds rather than losing the row.
    const parts = line.split(',');
    const seasonMatch = parts[1].match(/(\d{4}\/\d{4})$/);
    recordRow(
      convertDate(parts[0]), parts[1], seasonMatch ? seasonMatch[1] : parts[1], parts[2],
      parts[3],
      parts[4], parseInt(parts[5]), parts[6], parseInt(parts[7]),
      parts[8], '', parts[9]
    );
    i++;
    continue;
  }

  const seasonMatch = line.match(SEASON_RE);
  if (seasonMatch && !DATE_RE.test(line)) {
    if (DEBUG && (currentTournament !== line || currentSeasonKey !== seasonMatch[2])) {
      dbg(lineNo, 'tournament/season', `${currentTournament} / ${currentSeasonKey}`, `${line} / ${seasonMatch[2]}`, line);
    }
    currentTournament = line;
    currentSeasonKey = seasonMatch[2];
    i++;
    continue;
  }

  const todayMatch = line.match(TODAY_RE);
  if (todayMatch) {
    const newDate = `${todayMatch[1]} ${CURRENT_YEAR}`;
    dbg(lineNo, 'currentDate (via TODAY_RE)', currentDate, newDate, line);
    currentDate = newDate;
    currentStage = 'Regular Season';
    i++;
    continue;
  }
  const yesterdayMatch = line.match(YESTERDAY_RE);
  if (yesterdayMatch) {
    const newDate = `${yesterdayMatch[1]} ${CURRENT_YEAR}`;
    dbg(lineNo, 'currentDate (via YESTERDAY_RE)', currentDate, newDate, line);
    currentDate = newDate;
    currentStage = 'Regular Season';
    i++;
    continue;
  }

  const dateMatch = line.match(DATE_RE);
  if (dateMatch) {
    dbg(lineNo, 'currentDate (via DATE_RE)', currentDate, dateMatch[1], line);
    currentDate = dateMatch[1];
    currentStage = dateMatch[3] ? dateMatch[3].trim() : 'Regular Season';
    i++;
    continue;
  }

  if (NOISE_RE.test(line)) { i++; continue; }
  if (SMALL_NUM_RE.test(line)) { i++; continue; }

  if (STATUS_RE.test(line) && currentDate && currentTournament) {
    const matchedStatus = line; // 'Finished', 'After OT', or 'After Pen.'
    let j = i + 1;

    const homeScore = lines[j];
    if (isNaN(parseInt(homeScore))) { i++; continue; }
    j++;

    let homeTeam = lines[j]; j++;
    while (lines[j] === homeTeam) j++;

    if (lines[j] !== '-') { i++; continue; }
    j++;

    let awayTeam = lines[j]; j++;
    while (lines[j] === awayTeam) j++;

    const awayScore = lines[j];
    if (isNaN(parseInt(awayScore))) { i++; continue; }
    j++;

    // Collect up to 3 consecutive odds-looking values (handles both
    // 2-way basketball and 3-way hockey home/draw/away formats).
    // Sites use two different placeholders for "no odds posted": '--'
    // and a single '-'. By this point in parsing, the lone '-' used
    // as the home/away separator has already been consumed above, so
    // treating '-' as a no-odds placeholder here is unambiguous.
    const NO_ODDS_TOKEN = /^--?$/;
    const oddsValues = [];
    while (oddsValues.length < 3 && (ODDS_RE.test(lines[j]) || NO_ODDS_TOKEN.test(lines[j]))) {
      oddsValues.push(lines[j]);
      j++;
    }

    // CHANGED (v10): keep all 3 values (home/draw/away) instead of
    // dropping the middle draw price. 2-way games (2 values found)
    // get an empty Draw_Odds.
    let homeOdds = '', drawOdds = '', awayOdds = '';
    if (oddsValues.length === 3) {
      homeOdds = NO_ODDS_TOKEN.test(oddsValues[0]) ? '' : oddsValues[0];
      drawOdds = NO_ODDS_TOKEN.test(oddsValues[1]) ? '' : oddsValues[1];
      awayOdds = NO_ODDS_TOKEN.test(oddsValues[2]) ? '' : oddsValues[2];
      threeWayCount++;
    } else if (oddsValues.length === 2) {
      homeOdds = NO_ODDS_TOKEN.test(oddsValues[0]) ? '' : oddsValues[0];
      awayOdds = NO_ODDS_TOKEN.test(oddsValues[1]) ? '' : oddsValues[1];
      twoWayCount++;
    } else if (oddsValues.length === 1 && NO_ODDS_TOKEN.test(oddsValues[0])) {
      // no odds available for this game
    }

    if (DEBUG && oddsValues.length !== 3) {
      console.error(`[line ${lineNo}] NON-3WAY-ODDS (${oddsValues.length} value(s): [${oddsValues.join(', ')}]) date="${currentDate}" tournament="${currentTournament}": ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`);
    }

    if (DEBUG) {
      console.error(`[line ${lineNo}] RECORD game using currentDate="${currentDate}" currentTournament="${currentTournament}": ${homeTeam} ${homeScore} - ${awayScore} ${awayTeam}`);
    }

    recordRow(
      convertDate(currentDate), currentTournament, currentSeasonKey, currentStage,
      matchedStatus,
      homeTeam, parseInt(homeScore), awayTeam, parseInt(awayScore),
      homeOdds, drawOdds, awayOdds
    );

    i = j;
    continue;
  }

  i++;
}

const header = 'Date,Tournament,Stage,Status,Home_Team,Home_Score,Away_Team,Away_Score,Home_Odds,Draw_Odds,Away_Odds';
const csvLines = rows.map(r =>
  [r.date, r.tournament, r.stage, r.status, r.home, r.homeScore, r.away, r.awayScore, r.homeOdds, r.drawOdds, r.awayOdds].join(',')
);

fs.writeFileSync(outputPath, [header, ...csvLines].join('\n'), 'utf-8');

console.log(`Parsed ${rows.length} total games -> ${outputPath}`);
console.log(`  3-way odds (Home/Draw/Away): ${threeWayCount} games`);
console.log(`  2-way odds (Home/Away only): ${twoWayCount} games`);
console.log('Breakdown by season:');
for (const [season, count] of Object.entries(seasonCounts)) {
  console.log(`  ${season}: ${count} games`);
}

const statusCounts = {};
for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
console.log('Breakdown by status:');
for (const [status, count] of Object.entries(statusCounts)) {
  console.log(`  ${status}: ${count} games`);
}

const uniqueDates = new Set(rows.map(r => r.date));
console.log(`Unique dates in output: ${uniqueDates.size}`);
if (uniqueDates.size <= 1 && rows.length > 1) {
  console.warn('WARNING: all rows have the same date. Re-run with --debug to see which line is overriding currentDate.');
}