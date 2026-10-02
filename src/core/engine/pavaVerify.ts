// src/core/engine/pavaVerify.ts
//
// Real pool-adjacent-violators implementation, run against the raw
// (avgRawConf, realHitRate, n) bins hockeyCalibrationPrep.ts produced
// for puck_line/hockey_totals/team_totals. Verifies the hand-pooled
// isotonic tables currently in probabilityModel.ts.

interface Bin {
  x: number;
  y: number;
  n: number;
}

function pava(bins: Bin[]): Bin[] {
  const stack: Bin[] = [];
  for (const bin of bins) {
    let current = { ...bin };
    while (stack.length > 0 && stack[stack.length - 1].y >= current.y) {
      const prev = stack.pop()!;
      const totalN = prev.n + current.n;
      current = {
        x: current.x,
        y: (prev.y * prev.n + current.y * current.n) / totalN,
        n: totalN,
      };
    }
    stack.push(current);
  }
  return stack;
}

const PUCK_LINE_1_5: Bin[] = [
  { x: 0.547, y: 0.569, n: 3454 },
  { x: 0.609, y: 0.632, n: 3454 },
  { x: 0.646, y: 0.654, n: 3454 },
  { x: 0.673, y: 0.662, n: 3454 },
  { x: 0.694, y: 0.662, n: 3454 },
  { x: 0.713, y: 0.684, n: 3454 },
  { x: 0.729, y: 0.710, n: 3454 },
  { x: 0.745, y: 0.706, n: 3454 },
  { x: 0.761, y: 0.699, n: 3454 },
  { x: 0.788, y: 0.706, n: 3446 },
];

const PUCK_LINE_2_5: Bin[] = [
  { x: 0.705, y: 0.701, n: 3454 },
  { x: 0.774, y: 0.751, n: 3454 },
  { x: 0.803, y: 0.769, n: 3454 },
  { x: 0.824, y: 0.774, n: 3454 },
  { x: 0.839, y: 0.782, n: 3454 },
  { x: 0.852, y: 0.784, n: 3454 },
  { x: 0.864, y: 0.813, n: 3454 },
  { x: 0.875, y: 0.822, n: 3454 },
  { x: 0.888, y: 0.803, n: 3454 },
  { x: 0.911, y: 0.809, n: 3446 },
];

const GAME_TOTAL_OVER_4_5: Bin[] = [
  { x: 0.181, y: 0.663, n: 3454 },
  { x: 0.266, y: 0.699, n: 3454 },
  { x: 0.317, y: 0.717, n: 3454 },
  { x: 0.359, y: 0.736, n: 3454 },
  { x: 0.397, y: 0.732, n: 3454 },
  { x: 0.434, y: 0.754, n: 3454 },
  { x: 0.472, y: 0.759, n: 3454 },
  { x: 0.515, y: 0.764, n: 3454 },
  { x: 0.565, y: 0.775, n: 3454 },
  { x: 0.655, y: 0.773, n: 3446 },
];

const GAME_TOTAL_UNDER_7_5: Bin[] = [
  { x: 0.796, y: 0.744, n: 3454 },
  { x: 0.863, y: 0.766, n: 3454 },
  { x: 0.891, y: 0.776, n: 3454 },
  { x: 0.911, y: 0.772, n: 3454 },
  { x: 0.927, y: 0.777, n: 3454 },
  { x: 0.941, y: 0.792, n: 3454 },
  { x: 0.952, y: 0.804, n: 3454 },
  { x: 0.964, y: 0.814, n: 3454 },
  { x: 0.975, y: 0.809, n: 3454 },
  { x: 0.988, y: 0.838, n: 3446 },
];

const HOME_TEAM_TOTAL_OVER_1_5: Bin[] = [
  { x: 0.375, y: 0.742, n: 3454 },
  { x: 0.487, y: 0.770, n: 3454 },
  { x: 0.540, y: 0.785, n: 3454 },
  { x: 0.582, y: 0.801, n: 3454 },
  { x: 0.619, y: 0.797, n: 3454 },
  { x: 0.651, y: 0.807, n: 3454 },
  { x: 0.683, y: 0.813, n: 3454 },
  { x: 0.717, y: 0.834, n: 3454 },
  { x: 0.755, y: 0.829, n: 3454 },
  { x: 0.818, y: 0.844, n: 3446 },
];

const AWAY_TEAM_TOTAL_OVER_1_5: Bin[] = [
  { x: 0.353, y: 0.682, n: 3454 },
  { x: 0.459, y: 0.722, n: 3454 },
  { x: 0.512, y: 0.724, n: 3454 },
  { x: 0.553, y: 0.726, n: 3454 },
  { x: 0.590, y: 0.751, n: 3454 },
  { x: 0.623, y: 0.771, n: 3454 },
  { x: 0.655, y: 0.761, n: 3454 },
  { x: 0.689, y: 0.782, n: 3454 },
  { x: 0.729, y: 0.786, n: 3454 },
  { x: 0.794, y: 0.814, n: 3446 },
];

const AWAY_TEAM_TOTAL_UNDER_3_5: Bin[] = [
  { x: 0.654, y: 0.592, n: 3454 },
  { x: 0.739, y: 0.633, n: 3454 },
  { x: 0.781, y: 0.648, n: 3454 },
  { x: 0.811, y: 0.660, n: 3454 },
  { x: 0.837, y: 0.669, n: 3454 },
  { x: 0.860, y: 0.674, n: 3454 },
  { x: 0.882, y: 0.698, n: 3454 },
  { x: 0.904, y: 0.708, n: 3454 },
  { x: 0.928, y: 0.730, n: 3454 },
  { x: 0.960, y: 0.759, n: 3446 },
];

const markets: [string, Bin[]][] = [
  ['PUCK_LINE_1_5', PUCK_LINE_1_5],
  ['PUCK_LINE_2_5', PUCK_LINE_2_5],
  ['GAME_TOTAL_OVER_4_5', GAME_TOTAL_OVER_4_5],
  ['GAME_TOTAL_UNDER_7_5', GAME_TOTAL_UNDER_7_5],
  ['HOME_TEAM_TOTAL_OVER_1_5', HOME_TEAM_TOTAL_OVER_1_5],
  ['AWAY_TEAM_TOTAL_OVER_1_5', AWAY_TEAM_TOTAL_OVER_1_5],
  ['AWAY_TEAM_TOTAL_UNDER_3_5', AWAY_TEAM_TOTAL_UNDER_3_5],
];

for (const [name, bins] of markets) {
  console.log('\n' + name + ' pooled:');
  console.log(pava(bins));
}