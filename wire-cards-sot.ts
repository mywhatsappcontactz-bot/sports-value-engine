import * as fs from 'fs';

const filePath = 'src/core/engine/probabilityModel.ts';
let content = fs.readFileSync(filePath, 'utf-8');

function mustReplace(pattern: RegExp, replacement: string, label: string) {
  if (!pattern.test(content)) {
    throw new Error(`Could not find ${label} — aborting, no changes made.`);
  }
  content = content.replace(pattern, replacement);
}

// ─── 1. Narrow CARDS_LINES/SOT_LINES to only the surviving lines ───
mustReplace(
  /const CARDS_LINES = \[3\.5, 4\.5\];/,
  `const CARDS_LINES = [3.5]; // 4.5 never cleared 70% real hit rate in cardsSotBacktest.ts — dropped`,
  'CARDS_LINES declaration'
);
mustReplace(
  /const SOT_LINES = \[8\.5, 9\.5\];/,
  `const SOT_LINES = [7.5]; // 8.5/9.5 never cleared 70% real hit rate in cardsSotBacktest.ts — dropped, 7.5 added (the line that actually survived)`,
  'SOT_LINES declaration'
);

// ─── 2. New shared constant + 8 calibration tables + 4 apply functions ───
// Inserted right before modelFootballCards.
const oldCardsStart = /function modelFootballCards\(stats: Stats\): MarketProbability \| null \{/;
const newCardsBlock = `// ─── CARDS / SOT ISOTONIC CALIBRATION ─────────────────────────────
// Fitted via scripts/cardsSotIsotonicFit.ts on pooled 2016/17-2024/25
// seasons (football-data.co.uk, 5 leagues: EPL, La Liga, Bundesliga,
// Serie A, Eredivisie — the exact leagues with live FBref coverage via
// TEAM_FBREF_IDS), after scripts/cardsSotBacktest.ts confirmed these
// specific market/line/side combos clear a real 70%+ hit rate; every
// combo that didn't clear 70% (cards 4.5/5.5/6.5, SOT 8.5/9.5/10.5,
// team cards 2.5/3.5 both sides, team SOT 5.5 both sides) was
// deliberately NOT fit and is not available as a tip at all.
//
// Post-calibration floor: several of these tables still dip below 70%
// at their low-confidence end even though their backtest AVERAGE
// cleared it (e.g. TEAM_SOT_HOME_3.5 ranges 57.6%-84.5% calibrated) —
// same situation team_corners_over's HOME_4.5/HOME_5.5/AWAY_3.5 tables
// were in. CARDS_SOT_MIN_TIP_CONFIDENCE gates every individual tip on
// its OWN calibrated value, not just the table's average, same pattern
// as TEAM_CORNERS_MIN_TIP_CONFIDENCE. Confirmed worth having via
// scripts/sotBaselineCheck.ts: TEAM_SOT_HOME_3.5's uncalibrated low end
// (57.6%) sits BELOW the unconditional base rate of "home clears 3.5 in
// any random match" (67.8%) — without this floor, the weakest tips from
// this table would carry negative real skill, not just low confidence.
const CARDS_SOT_MIN_TIP_CONFIDENCE = 0.70;

const CARDS_TOTALS_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8133, y: 0.6767 },
  { x: 0.8506, y: 0.7127 },
  { x: 0.8752, y: 0.7143 },
  { x: 0.9000, y: 0.7403 },
  { x: 0.9326, y: 0.7576 },
  { x: 0.9422, y: 0.7629 },
  { x: 0.9510, y: 0.7857 },
  { x: 0.9603, y: 0.7979 },
  { x: 0.9706, y: 0.8000 },
  { x: 0.9797, y: 0.8475 },
];

const SOT_TOTALS_7_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8280, y: 0.7155 },
  { x: 0.8539, y: 0.7250 },
  { x: 0.8569, y: 0.7325 },
  { x: 0.8649, y: 0.7679 },
  { x: 0.8801, y: 0.7725 },
  { x: 0.9073, y: 0.7818 },
  { x: 0.9422, y: 0.8344 },
];

const TEAM_CARDS_HOME_1_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8036, y: 0.6418 },
  { x: 0.8079, y: 0.6667 },
  { x: 0.8410, y: 0.7348 },
  { x: 0.8876, y: 0.8000 },
  { x: 0.8887, y: 0.8000 },
  { x: 0.8901, y: 0.8000 },
  { x: 0.9191, y: 0.8125 },
];

const TEAM_CARDS_AWAY_1_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8018, y: 0.6036 },
  { x: 0.8065, y: 0.6626 },
  { x: 0.8093, y: 0.6667 },
  { x: 0.8103, y: 0.6964 },
  { x: 0.8199, y: 0.7187 },
  { x: 0.8540, y: 0.7261 },
  { x: 0.8822, y: 0.7386 },
  { x: 0.8868, y: 0.7455 },
  { x: 0.8969, y: 0.7458 },
  { x: 0.9072, y: 0.7638 },
  { x: 0.9249, y: 0.7791 },
  { x: 0.9544, y: 0.7880 },
  { x: 0.9780, y: 0.7910 },
];

const TEAM_SOT_HOME_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8038, y: 0.5493 },
  { x: 0.8146, y: 0.6930 },
  { x: 0.8311, y: 0.7294 },
  { x: 0.8628, y: 0.7440 },
  { x: 0.8898, y: 0.7551 },
  { x: 0.9040, y: 0.7807 },
  { x: 0.9146, y: 0.7857 },
  { x: 0.9157, y: 0.7969 },
  { x: 0.9183, y: 0.8051 },
  { x: 0.9323, y: 0.8117 },
  { x: 0.9432, y: 0.8333 },
  { x: 0.9523, y: 0.8450 },
];

const TEAM_SOT_AWAY_3_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8017, y: 0.7179 },
  { x: 0.8041, y: 0.7778 },
  { x: 0.8058, y: 0.7778 },
  { x: 0.8249, y: 0.7897 },
  { x: 0.8589, y: 0.8241 },
  { x: 0.8785, y: 0.8571 },
  { x: 0.8859, y: 0.8696 },
  { x: 0.9147, y: 0.8697 },
  { x: 0.9478, y: 0.8889 },
  { x: 0.9547, y: 0.8958 },
];

const TEAM_SOT_HOME_4_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8023, y: 0.5833 },
  { x: 0.8120, y: 0.6221 },
  { x: 0.8217, y: 0.6333 },
  { x: 0.8243, y: 0.6364 },
  { x: 0.8469, y: 0.6545 },
  { x: 0.8648, y: 0.6667 },
  { x: 0.8652, y: 0.6667 },
  { x: 0.8654, y: 0.6667 },
  { x: 0.8713, y: 0.6724 },
  { x: 0.8777, y: 0.7059 },
  { x: 0.8829, y: 0.7069 },
  { x: 0.8987, y: 0.7211 },
  { x: 0.9109, y: 0.7246 },
  { x: 0.9184, y: 0.7387 },
  { x: 0.9235, y: 0.7647 },
  { x: 0.9253, y: 0.7763 },
  { x: 0.9262, y: 0.8125 },
];

const TEAM_SOT_AWAY_4_5_BLOCKS: { x: number; y: number }[] = [
  { x: 0.8244, y: 0.7222 },
  { x: 0.8631, y: 0.7273 },
  { x: 0.8954, y: 0.7857 },
];

function isotonicLookup(blocks: { x: number; y: number }[], rawProb: number): number {
  if (rawProb <= blocks[0].x) return blocks[0].y;
  if (rawProb >= blocks[blocks.length - 1].x) return blocks[blocks.length - 1].y;
  for (let i = 0; i < blocks.length - 1; i++) {
    if (rawProb >= blocks[i].x && rawProb <= blocks[i + 1].x) {
      const t = (rawProb - blocks[i].x) / (blocks[i + 1].x - blocks[i].x || 1);
      return blocks[i].y + t * (blocks[i + 1].y - blocks[i].y);
    }
  }
  return rawProb;
}

function modelFootballCards(stats: Stats): MarketProbability | null {`;

mustReplace(oldCardsStart, newCardsBlock, 'modelFootballCards function start');

// ─── 3. Update modelFootballCards to calibrate + apply 70% floor ───
// FIX: \n changed to \r?\n throughout, to match Windows CRLF line endings.
const oldCardsBody =
  /(function modelFootballCards\(stats: Stats\): MarketProbability \| null \{[\s\S]*?)const best = clearingFloor\.reduce\(\(a, b\) => \(b\.line > a\.line \? b : a\)\);\r?\n  return \{\r?\n    market: 'cards_totals',\r?\n    selection: `Over \$\{best\.line\}`,\r?\n    trueProbability: best\.prob,\r?\n    method: USE_NB_FOR_CARDS \? 'negative-binomial-cards-uncalibrated' : 'poisson-cards-uncalibrated',\r?\n  \};\r?\n\}/;

const newCardsBody = `$1const best = clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));

  // Only 3.5 survives (see CARDS_LINES) — always calibrate against that table.
  const calibrated = isotonicLookup(CARDS_TOTALS_3_5_BLOCKS, best.prob);
  if (calibrated < CARDS_SOT_MIN_TIP_CONFIDENCE) return null;

  return {
    market: 'cards_totals',
    selection: \`Over \${best.line}\`,
    trueProbability: calibrated,
    method: USE_NB_FOR_CARDS ? 'negative-binomial-cards-isotonic' : 'poisson-cards-isotonic',
  };
}`;

mustReplace(oldCardsBody, newCardsBody, 'modelFootballCards body (cards_totals return block)');

// ─── 4. Update modelFootballShotsOnTarget the same way ───
// FIX: \n changed to \r?\n throughout.
const oldSotBody =
  /(function modelFootballShotsOnTarget\(stats: Stats\): MarketProbability \| null \{[\s\S]*?)const best = clearingFloor\.reduce\(\(a, b\) => \(b\.line > a\.line \? b : a\)\);\r?\n  return \{\r?\n    market: 'sot_totals',\r?\n    selection: `Over \$\{best\.line\}`,\r?\n    trueProbability: best\.prob,\r?\n    method: USE_NB_FOR_SOT \? 'negative-binomial-sot-uncalibrated' : 'poisson-sot-uncalibrated',\r?\n  \};\r?\n\}/;

const newSotBody = `$1const best = clearingFloor.reduce((a, b) => (b.line > a.line ? b : a));

  // Only 7.5 survives (see SOT_LINES) — always calibrate against that table.
  const calibrated = isotonicLookup(SOT_TOTALS_7_5_BLOCKS, best.prob);
  if (calibrated < CARDS_SOT_MIN_TIP_CONFIDENCE) return null;

  return {
    market: 'sot_totals',
    selection: \`Over \${best.line}\`,
    trueProbability: calibrated,
    method: USE_NB_FOR_SOT ? 'negative-binomial-sot-isotonic' : 'poisson-sot-isotonic',
  };
}

// ─── TEAM CARDS OVER ────────────────────────────────────────────
// Only Home Over 1.5 / Away Over 1.5 survived cardsSotBacktest.ts's 70%
// bar (2.5/3.5 both sides did not). Mirrors modelFootballTeamCornersOver's
// structure exactly.
const TEAM_CARDS_LINE = 1.5;

function modelFootballTeamCardsOver(stats: Stats): MarketProbability[] | null {
  const lambdaHome = stats.homeCardsAvg;
  const lambdaAway = stats.awayCardsAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const results: MarketProbability[] = [];
  const method = USE_NB_FOR_CARDS ? 'negative-binomial-team-cards-over-isotonic' : 'poisson-team-cards-over-isotonic';

  const homeRawProb = USE_NB_FOR_CARDS
    ? singleOverProbabilityNB(lambdaHome, TEAM_CARDS_LINE, CARDS_NB_DISPERSION_K, 15)
    : singleOverProbabilityPoisson(lambdaHome, TEAM_CARDS_LINE, 15);
  if (homeRawProb >= CARDS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(TEAM_CARDS_HOME_1_5_BLOCKS, homeRawProb);
    if (calibrated >= CARDS_SOT_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'team_cards_over', selection: \`Home Over \${TEAM_CARDS_LINE}\`, trueProbability: calibrated, method });
    }
  }

  const awayRawProb = USE_NB_FOR_CARDS
    ? singleOverProbabilityNB(lambdaAway, TEAM_CARDS_LINE, CARDS_NB_DISPERSION_K, 15)
    : singleOverProbabilityPoisson(lambdaAway, TEAM_CARDS_LINE, 15);
  if (awayRawProb >= CARDS_MIN_CONFIDENCE) {
    const calibrated = isotonicLookup(TEAM_CARDS_AWAY_1_5_BLOCKS, awayRawProb);
    if (calibrated >= CARDS_SOT_MIN_TIP_CONFIDENCE) {
      results.push({ market: 'team_cards_over', selection: \`Away Over \${TEAM_CARDS_LINE}\`, trueProbability: calibrated, method });
    }
  }

  return results.length ? results : null;
}

// ─── TEAM SOT OVER ────────────────────────────────────────────
// Home Over 3.5, Home Over 4.5, Away Over 3.5, Away Over 4.5 all
// survived cardsSotBacktest.ts's 70% bar (5.5 both sides did not).
// Tests both lines per side, picks the highest clearing the raw floor —
// same "pick highest qualifying line" pattern as team_corners_over.
const TEAM_SOT_LINES_LIVE = [3.5, 4.5];

function bestTeamSotOverLine(
  mean: number,
  blocksFor: (line: number) => { x: number; y: number }[]
): { line: number; rawProb: number; calibrated: number } | null {
  const candidates = TEAM_SOT_LINES_LIVE.map((line) => {
    const rawProb = USE_NB_FOR_SOT
      ? singleOverProbabilityNB(mean, line, SOT_NB_DISPERSION_K, 20)
      : singleOverProbabilityPoisson(mean, line, 20);
    return { line, rawProb, calibrated: rawProb >= SOT_MIN_CONFIDENCE ? isotonicLookup(blocksFor(line), rawProb) : -1 };
  });

  const clearingBoth = candidates.filter((c) => c.rawProb >= SOT_MIN_CONFIDENCE && c.calibrated >= CARDS_SOT_MIN_TIP_CONFIDENCE);
  if (!clearingBoth.length) return null;

  return clearingBoth.reduce((a, b) => (b.line > a.line ? b : a));
}

function modelFootballTeamSotOver(stats: Stats): MarketProbability[] | null {
  const lambdaHome = stats.homeSotAvg;
  const lambdaAway = stats.awaySotAvg;

  if (lambdaHome == null || lambdaAway == null) return null;

  const results: MarketProbability[] = [];
  const method = USE_NB_FOR_SOT ? 'negative-binomial-team-sot-over-isotonic' : 'poisson-team-sot-over-isotonic';

  const homeBest = bestTeamSotOverLine(lambdaHome, (line) => (line === 3.5 ? TEAM_SOT_HOME_3_5_BLOCKS : TEAM_SOT_HOME_4_5_BLOCKS));
  if (homeBest) {
    results.push({ market: 'team_sot_over', selection: \`Home Over \${homeBest.line}\`, trueProbability: homeBest.calibrated, method });
  }

  const awayBest = bestTeamSotOverLine(lambdaAway, (line) => (line === 3.5 ? TEAM_SOT_AWAY_3_5_BLOCKS : TEAM_SOT_AWAY_4_5_BLOCKS));
  if (awayBest) {
    results.push({ market: 'team_sot_over', selection: \`Away Over \${awayBest.line}\`, trueProbability: awayBest.calibrated, method });
  }

  return results.length ? results : null;
}`;

mustReplace(oldSotBody, newSotBody, 'modelFootballShotsOnTarget body (sot_totals return block)');

// ─── 5. Push the two new tips into modelFootball's results array ───
// FIX: \n changed to \r?\n here too — this one would have failed next.
mustReplace(
  /const sotTip = modelFootballShotsOnTarget\(stats\);\r?\n  if \(sotTip\) results\.push\(sotTip\);/,
  `const sotTip = modelFootballShotsOnTarget(stats);
  if (sotTip) results.push(sotTip);

  const teamCardsOverTip = modelFootballTeamCardsOver(stats);
  if (teamCardsOverTip) results.push(...teamCardsOverTip);

  const teamSotOverTip = modelFootballTeamSotOver(stats);
  if (teamSotOverTip) results.push(...teamSotOverTip);`,
  'sotTip push site'
);

fs.writeFileSync(filePath, content, 'utf-8');
console.log('Done — cards/SOT calibration + team-split markets wired in.');