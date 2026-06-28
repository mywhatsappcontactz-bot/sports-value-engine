// src/core/utils/clvTracker.ts
import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

// ─── DEVIG HELPERS ───────────────────────────────────────────────────────────

function devigOdds(odds1: number, odds2: number): number {
  const implied1 = 1 / odds1;
  const implied2 = 1 / odds2;
  const total = implied1 + implied2;
  return total; // vig-inclusive total implied probability
}

function getFairOdds(targetOdds: number, oppositeOdds: number): number {
  const totalImplied = (1 / targetOdds) + (1 / oppositeOdds);
  const fairImplied = (1 / targetOdds) / totalImplied;
  return parseFloat((1 / fairImplied).toFixed(4));
}

function getOppositeSelection(selection: string): string | null {
  const overMatch = selection.match(/^Over\s+([\d.]+)$/i);
  if (overMatch) return `Under ${overMatch[1]}`;
  const underMatch = selection.match(/^Under\s+([\d.]+)$/i);
  if (underMatch) return `Over ${underMatch[1]}`;
  if (selection.toLowerCase() === 'home') return 'away';
  if (selection.toLowerCase() === 'away') return 'home';
  if (selection.toLowerCase() === 'draw') return null;
  return null;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

export async function recordClosingLines(repo: Repository) {
  try {
    const pendingBets = repo.getPendingBetsNearKickoff(2);

    if (pendingBets.length === 0) {
      logger.info('[CLVTracker] No pending bets near kickoff to process.');
      return;
    }

    logger.info(`[CLVTracker] Checking closing lines for ${pendingBets.length} bets.`);

    for (const bet of pendingBets) {
      // Fetch Pinnacle closing line for this selection
      const pinnacleClosing = repo.getClosingOdds(bet.matchId, 'Pinnacle', bet.market, bet.selection);

      if (!pinnacleClosing) {
        logger.debug(`[CLVTracker] No Pinnacle closing line found for bet ${bet.id}`);
        continue;
      }

      // Try to get opposite side for devigging
      const oppositeSelection = getOppositeSelection(bet.selection);
      const pinnacleOpposite = oppositeSelection
        ? repo.getClosingOdds(bet.matchId, 'Pinnacle', bet.market, oppositeSelection)
        : null;

      let fairClosingOdds: number;

      if (pinnacleOpposite) {
        // Devigged fair odds — more accurate CLV
        fairClosingOdds = getFairOdds(pinnacleClosing.odds, pinnacleOpposite.odds);
        logger.debug(`[CLVTracker] Devigged closing: raw=${pinnacleClosing.odds} fair=${fairClosingOdds} (opposite=${pinnacleOpposite.odds})`);
      } else {
        // Fallback: use raw Pinnacle odds (slight underestimate of CLV)
        fairClosingOdds = pinnacleClosing.odds;
        logger.debug(`[CLVTracker] No opposite side found — using raw Pinnacle odds for bet ${bet.id}`);
      }

      // CLV = how much better our odds were vs fair closing line
      const clvValue = (bet.bookmakerOdds / fairClosingOdds) - 1;
      const clvPercentage = parseFloat((clvValue * 100).toFixed(2));

      repo.saveCLVRecord({
        valueBetId: bet.id,
        matchId: bet.matchId,
        openingOdds: bet.bookmakerOdds,
        closingOdds: pinnacleClosing.odds,
        ourOdds: bet.bookmakerOdds,
        clvValue: parseFloat(clvValue.toFixed(4)),
        clvPercentage,
      });

      repo.updateValueBetStatus(bet.id, 'closed', pinnacleClosing.odds);

      const clvLabel = clvPercentage > 0
        ? `+${clvPercentage}% ✅ beat closing line`
        : `${clvPercentage}% ❌ missed closing line`;

      logger.info(`[CLVTracker] Bet ${bet.id}: CLV ${clvLabel}`);
    }
  } catch (err: any) {
    logger.error(`[CLVTracker] Error processing closing lines: ${err.message}`);
  }
}