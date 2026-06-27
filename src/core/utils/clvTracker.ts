import { Repository } from '../database/repository';
import { logger } from '../utils/logger';

export async function recordClosingLines(repo: Repository) {
  try {
    const pendingBets = repo.getPendingBetsNearKickoff(2);
    
    if (pendingBets.length === 0) {
      logger.info('[CLVTracker] No pending bets near kickoff to process.');
      return;
    }

    logger.info(`[CLVTracker] Checking closing lines for ${pendingBets.length} bets.`);

    for (const bet of pendingBets) {
      // Optimized: Fetch only the specific Pinnacle line needed
      const pinnacleClosing = repo.getClosingOdds(bet.matchId, 'Pinnacle', bet.market, bet.selection);

      if (!pinnacleClosing) {
        logger.debug(`[CLVTracker] No Pinnacle closing line found for bet ${bet.id}`);
        continue;
      }

      const clvValue = (bet.bookmakerOdds / pinnacleClosing.odds) - 1;
      const clvPercentage = clvValue * 100;

      repo.saveCLVRecord({
        valueBetId: bet.id,
        matchId: bet.matchId,
        openingOdds: bet.bookmakerOdds,
        closingOdds: pinnacleClosing.odds,
        ourOdds: bet.bookmakerOdds,
        clvValue: parseFloat(clvValue.toFixed(4)),
        clvPercentage: parseFloat(clvPercentage.toFixed(2))
      });

      repo.updateValueBetStatus(bet.id, 'closed', pinnacleClosing.odds);
      logger.info(`[CLVTracker] Recorded CLV for bet ${bet.id}: ${(clvPercentage).toFixed(2)}%`);
    }
  } catch (err: any) {
    logger.error(`[CLVTracker] Error processing closing lines: ${err.message}`);
  }
}