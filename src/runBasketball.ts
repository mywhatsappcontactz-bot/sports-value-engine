import * as fs from 'fs';
import * as path from 'path';

// Inline simple logger to eliminate any cross-directory import issues
const logger = {
  info: (msg: string, meta?: any) => console.log(`[INFO] ${msg}`, meta ? meta : ''),
  error: (msg: string, meta?: any) => console.error(`[ERROR] ${msg}`, meta ? meta : ''),
  warn: (msg: string, meta?: any) => console.warn(`[WARN] ${msg}`, meta ? meta : '')
};

interface TeamGameStats {
  gameId: string;
  date: string;
  team: string;
  opponent: string;
  pointsFor: number;
  pointsAgainst: number;
  isHome: boolean;
}

class BasketballBacktestEngine {
  private datasetPath: string;

  constructor() {
    this.datasetPath = this.resolveKaggleDatasetPath();
  }

  private resolveKaggleDatasetPath(): string {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    const baseDir = path.join(home, '.cache', 'kagglehub', 'datasets');
    
    if (!fs.existsSync(baseDir)) {
      throw new Error(`[BasketballEngine] Kaggle cache directory not found at: ${baseDir}. Run python kagglehub download first.`);
    }

    const scanDir = (dir: string): string | null => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const found = scanDir(fullPath);
          if (found) return found;
        } else if (entry.name.toLowerCase().includes('team')) {
          return dir;
        }
      }
      return null;
    };

    const targetDir = scanDir(baseDir);
    if (!targetDir) {
      throw new Error('[BasketballEngine] Could not locate the dataset folder inside kagglehub cache.');
    }
    return targetDir;
  }

  private parseCSVLine(line: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current.trim());
    return result;
  }

  public loadTeamStats(): TeamGameStats[] {
    const files = fs.readdirSync(this.datasetPath);
    const teamFile = files.find(f => f.toLowerCase().includes('team') && f.endsWith('.csv'));

    if (!teamFile) {
      throw new Error(`[BasketballEngine] Team statistics CSV not found in ${this.datasetPath}`);
    }

    const filePath = path.join(this.datasetPath, teamFile);
    logger.info('[BasketballEngine] Loading team statistics file...', { filePath });

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    
    if (lines.length <= 1) return [];

    const headers = this.parseCSVLine(lines[0]);
    const gameIdIdx = headers.findIndex(h => h.toLowerCase().includes('gameid') || h.toLowerCase().includes('game_id'));
    const dateIdx = headers.findIndex(h => h.toLowerCase().includes('date'));
    const teamIdx = headers.findIndex(h => h.toLowerCase().includes('team') || h.toLowerCase().includes('franchise'));
    const ptsIdx = headers.findIndex(h => h.toLowerCase().includes('pts') || h.toLowerCase().includes('points'));

    if (gameIdIdx === -1 || teamIdx === -1 || ptsIdx === -1) {
      throw new Error('[BasketballEngine] Required column headers missing in CSV structure.');
    }

    const rawRecords: TeamGameStats[] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = this.parseCSVLine(lines[i]);
      if (cols.length <= Math.max(gameIdIdx, teamIdx, ptsIdx)) continue;

      rawRecords.push({
        gameId: cols[gameIdIdx],
        date: dateIdx !== -1 ? cols[dateIdx] : new Date().toISOString(),
        team: cols[teamIdx],
        opponent: 'UNKNOWN',
        pointsFor: parseFloat(cols[ptsIdx]) || 0,
        pointsAgainst: 0,
        isHome: true
      });
    }

    logger.info(`[BasketballEngine] Parsed ${rawRecords.length} raw team entries.`);
    return rawRecords;
  }

  public runBacktest(targetLine: number = 215.5) {
    const records = this.loadTeamStats();
    
    const gameMap = new Map<string, TeamGameStats[]>();
    for (const record of records) {
      if (!gameMap.has(record.gameId)) {
        gameMap.set(record.gameId, []);
      }
      gameMap.get(record.gameId)!.push(record);
    }

    const teamStates = new Map<string, { games: number; totalScored: number; totalConceded: number }>();
    let totalBets = 0;
    let wins = 0;

    for (const [gameId, matchTeams] of gameMap.entries()) {
      if (matchTeams.length !== 2) continue;

      const [t1, t2] = matchTeams;
      t1.opponent = t2.team;
      t2.opponent = t1.team;
      t2.pointsFor = t1.pointsAgainst;

      for (const t of [t1, t2]) {
        if (!teamStates.has(t.team)) {
          teamStates.set(t.team, { games: 0, totalScored: 0, totalConceded: 0 });
        }
      }

      const state1 = teamStates.get(t1.team)!;
      const state2 = teamStates.get(t2.team)!;

      if (state1.games >= 5 && state2.games >= 5) {
        const proj1 = (state1.totalScored / state1.games + state2.totalConceded / state2.games) / 2;
        const proj2 = (state2.totalScored / state2.games + state1.totalConceded / state1.games) / 2;
        const projectedTotal = proj1 + proj2 + 60;

        if (projectedTotal > targetLine + 4) {
          totalBets++;
          const actualTotal = t1.pointsFor + (t2.pointsFor || 0);
          if (actualTotal > targetLine) {
            wins++;
          }
        }
      }

      state1.games++;
      state1.totalScored += t1.pointsFor;
      state1.totalConceded += t2.pointsFor;

      state2.games++;
      state2.totalScored += t2.pointsFor;
      state2.totalConceded += t1.pointsFor;
    }

    const winRate = totalBets > 0 ? (wins / totalBets) * 100 : 0;
    logger.info('[BasketballEngine] Backtest Execution Finished', {
      totalEvaluatedBets: totalBets,
      successfulHits: wins,
      winRatePercentage: `${winRate.toFixed(2)}%`
    });

    return { totalBets, wins, winRate };
  }
}

// Execute immediately upon running
try {
  const engine = new BasketballBacktestEngine();
  engine.runBacktest(214.5);
} catch (error) {
  logger.error('[ExecutionError]', { error: error instanceof Error ? error.message : error });
}