import { getDb } from "./src/core/database/db";
import { getProbabilities } from "./src/core/engine/probabilityModel";

const db = getDb();
const matches: any[] = db.prepare("SELECT * FROM matches WHERE status = 'upcoming'").all();

let maxProb = 0;
let bestPick = null;

for (const m of matches) {
  const statsRow: any = db.prepare("SELECT * FROM stats WHERE matchId = ?").get(m.id);
  if (!statsRow) continue;

  const stats = {
    id: statsRow.id || "",
    matchId: m.id,
    sport: m.sport || "football",
    h2h: JSON.parse(statsRow.h2h || "[]"),
    homeForm: JSON.parse(statsRow.homeForm || "[]"),
    awayForm: JSON.parse(statsRow.awayForm || "[]"),
    referee: JSON.parse(statsRow.referee || "{}"),
    situational: JSON.parse(statsRow.situational || "{}"),
    additionalContext: JSON.parse(statsRow.additionalContext || "{}"),
    confidenceFactors: JSON.parse(statsRow.confidenceFactors || "{}"),
    homeGoalsAvg: statsRow.homeGoalsAvg,
    awayGoalsAvg: statsRow.awayGoalsAvg,
    homeCornersAvg: statsRow.homeCornersAvg,
    awayCornersAvg: statsRow.awayCornersAvg
  };

  const probs = getProbabilities({ match: m, stats, odds: [] });

  for (const p of probs) {
    if (p.trueProbability > maxProb) {
      maxProb = p.trueProbability;
      bestPick = {
        match: `${m.homeTeam} vs ${m.awayTeam}`,
        market: p.market,
        sel: p.selection,
        prob: (p.trueProbability * 100).toFixed(1) + "%"
      };
    }
  }
}

console.log("Highest Probability Found:", maxProb > 0 ? bestPick : "No stats associated with matches");