// src/data-bridge/mockClient.ts
import { ApiResponse } from './baseClient';
import { logger } from '../core/utils/logger';

export interface RawMatch {
  externalId: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  source: string;
}

export interface RawOdds {
  externalMatchId: string;
  bookmaker: string;
  market: string;
  selection: string;
  odds: number;
  timestamp: string;
}

export interface RawStats {
  externalMatchId: string;
  sport: string;
  homeGoalsAvg?: number;
  awayGoalsAvg?: number;
  confidenceFactors: { dataCompleteness: number };
  h2h: {
    date: string;
    homeTeam: string;
    awayTeam: string;
    homeScore: number;
    awayScore: number;
  }[];
  homeForm: {
    date: string;
    opponent: string;
    result: 'W' | 'L' | 'D';
    goalsFor?: number;
    goalsAgainst?: number;
    venue: 'home' | 'away';
  }[];
  awayForm: {
    date: string;
    opponent: string;
    result: 'W' | 'L' | 'D';
    goalsFor?: number;
    goalsAgainst?: number;
    venue: 'home' | 'away';
  }[];
  referee: {
    name: string;
    avgYellowCards: number;
    avgRedCards: number;
    avgFouls: number;
  };
  situational: {
    weather: string;
    temperature: number;
    fatigueDays: number;
    pitchSize?: string;
    surfaceType?: string;
  };
  additionalContext?: Record<string, unknown>;
}

// ─── MOCK CLIENT ─────────────────────────────────────────

export class MockClient {
  private ids = {
    football:   ['football-t1',   'football-t2',   'football-t3'],
    tennis:     ['tennis-t1',     'tennis-t2',     'tennis-t3'],
    basketball: ['basketball-t1', 'basketball-t2', 'basketball-t3'],
    hockey:     ['hockey-t1',     'hockey-t2',     'hockey-t3'],
  };

  private simulateDelay(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 50) + 10));
  }

  // ─── MATCHES ───────────────────────────────────────────

  async fetchMatches(sport: string): Promise<ApiResponse<RawMatch[]>> {
    await this.simulateDelay();

    const configs: Record<string, { league: string; teams: [string, string][] }> = {
      football: {
        league: 'Premier League',
        teams: [['Arsenal', 'Burnley'], ['Chelsea', 'Wolves'], ['Liverpool', 'Brentford']],
      },
      tennis: {
        league: 'ATP Tour',
        teams: [['Alcaraz C.', 'Rune H.'], ['Medvedev D.', 'Paul T.'], ['Zverev A.', 'Norrie C.']],
      },
      basketball: {
        league: 'NBA',
        teams: [['Boston Celtics', 'Miami Heat'], ['LA Lakers', 'Phoenix Suns'], ['Denver Nuggets', 'Dallas Mavericks']],
      },
      hockey: {
        league: 'NHL',
        teams: [['Tampa Bay Lightning', 'Boston Bruins'], ['Colorado Avalanche', 'Vegas Golden Knights'], ['Toronto Maple Leafs', 'Montreal Canadiens']],
      },
    };

    const cfg = configs[sport];
    if (!cfg) return { data: null, success: false, error: `Unknown sport: ${sport}`, correlationId: `mock_${Date.now()}` };

    const matchIds = this.ids[sport as keyof typeof this.ids];
    const matches: RawMatch[] = cfg.teams.map(([home, away], i) => ({
      externalId: matchIds[i],
      sport,
      league: cfg.league,
      homeTeam: home,
      awayTeam: away,
      startTime: new Date(Date.now() + 86400000 + i * 3600000).toISOString(),
      source: 'mock',
    }));

    logger.info(`[MockClient] Fetched ${matches.length} ${sport} matches`);
    return { data: matches, success: true, statusCode: 200, correlationId: `mock_${Date.now()}` };
  }

  // ─── ODDS ──────────────────────────────────────────────

  async fetchOdds(externalMatchId: string): Promise<ApiResponse<RawOdds[]>> {
    await this.simulateDelay();
    const ts = new Date().toISOString();
    const odds = this.buildOdds(externalMatchId, ts);
    if (!odds.length) return { data: null, success: false, error: 'Unknown match ID', correlationId: `mock_${Date.now()}` };
    return { data: odds, success: true, statusCode: 200, correlationId: `mock_${Date.now()}` };
  }

  private buildOdds(id: string, ts: string): RawOdds[] {
    const o = (bookmaker: string, market: string, selection: string, odds: number): RawOdds =>
      ({ externalMatchId: id, bookmaker, market, selection, odds, timestamp: ts });

    // ── FOOTBALL ─────────────────────────────────────────
    if (id === 'football-t1') return [
      o('Pinnacle',     '1x2', 'Home', 1.56), o('Pinnacle',     '1x2', 'Draw', 4.60), o('Pinnacle',     '1x2', 'Away', 7.20),
      o('Bet365',       '1x2', 'Home', 1.80), o('Bet365',       '1x2', 'Draw', 4.20), o('Bet365',       '1x2', 'Away', 6.50),
      o('William Hill', '1x2', 'Home', 1.75), o('William Hill', '1x2', 'Draw', 4.00), o('William Hill', '1x2', 'Away', 6.00),
    ];
    if (id === 'football-t2') return [
      o('Pinnacle',     '1x2', 'Home', 2.04), o('Pinnacle',     '1x2', 'Draw', 3.40), o('Pinnacle',     '1x2', 'Away', 3.90),
      o('Bet365',       '1x2', 'Home', 2.30), o('Bet365',       '1x2', 'Draw', 3.20), o('Bet365',       '1x2', 'Away', 3.60),
      o('William Hill', '1x2', 'Home', 2.25), o('William Hill', '1x2', 'Draw', 3.30), o('William Hill', '1x2', 'Away', 3.50),
    ];
    if (id === 'football-t3') return [
      o('Pinnacle',     '1x2', 'Home', 2.50), o('Pinnacle',     '1x2', 'Draw', 3.20), o('Pinnacle',     '1x2', 'Away', 3.10),
      o('Bet365',       '1x2', 'Home', 2.90), o('Bet365',       '1x2', 'Draw', 3.10), o('Bet365',       '1x2', 'Away', 2.95),
      o('William Hill', '1x2', 'Home', 2.80), o('William Hill', '1x2', 'Draw', 3.00), o('William Hill', '1x2', 'Away', 2.90),
    ];

    // ── TENNIS ───────────────────────────────────────────
    if (id === 'tennis-t1') return [
      o('Pinnacle',     'match_winner', 'home', 1.41), o('Pinnacle',     'match_winner', 'away', 3.10),
      o('Bet365',       'match_winner', 'home', 1.55), o('Bet365',       'match_winner', 'away', 2.75),
      o('William Hill', 'match_winner', 'home', 1.50), o('William Hill', 'match_winner', 'away', 2.80),
    ];
    if (id === 'tennis-t2') return [
      o('Pinnacle',     'match_winner', 'home', 1.75), o('Pinnacle',     'match_winner', 'away', 2.25),
      o('Bet365',       'match_winner', 'home', 1.92), o('Bet365',       'match_winner', 'away', 2.00),
      o('William Hill', 'match_winner', 'home', 1.88), o('William Hill', 'match_winner', 'away', 2.05),
    ];
    if (id === 'tennis-t3') return [
      o('Pinnacle',     'match_winner', 'home', 1.96), o('Pinnacle',     'match_winner', 'away', 2.00),
      o('Bet365',       'match_winner', 'home', 2.15), o('Bet365',       'match_winner', 'away', 1.85),
      o('William Hill', 'match_winner', 'home', 2.10), o('William Hill', 'match_winner', 'away', 1.80),
    ];

    // ── BASKETBALL ───────────────────────────────────────
    if (id === 'basketball-t1') return [
      o('Pinnacle',     'moneyline', 'Home', 1.49), o('Pinnacle',     'moneyline', 'Away', 2.75),
      o('Bet365',       'moneyline', 'Home', 1.67), o('Bet365',       'moneyline', 'Away', 2.40),
      o('William Hill', 'moneyline', 'Home', 1.62), o('William Hill', 'moneyline', 'Away', 2.45),
      o('Pinnacle',     'totals', 'Over 215.5',  1.92), o('Pinnacle',     'totals', 'Under 215.5', 1.95),
      o('Bet365',       'totals', 'Over 215.5',  2.05), o('Bet365',       'totals', 'Under 215.5', 1.85),
    ];
    if (id === 'basketball-t2') return [
      o('Pinnacle',     'moneyline', 'Home', 2.00), o('Pinnacle',     'moneyline', 'Away', 1.95),
      o('Bet365',       'moneyline', 'Home', 2.20), o('Bet365',       'moneyline', 'Away', 1.78),
      o('William Hill', 'moneyline', 'Home', 2.15), o('William Hill', 'moneyline', 'Away', 1.80),
      o('Pinnacle',     'totals', 'Over 220.5',  1.90), o('Pinnacle',     'totals', 'Under 220.5', 1.97),
      o('Bet365',       'totals', 'Over 220.5',  2.00), o('Bet365',       'totals', 'Under 220.5', 1.88),
    ];
    if (id === 'basketball-t3') return [
      o('Pinnacle',     'moneyline', 'Home', 1.85), o('Pinnacle',     'moneyline', 'Away', 2.10),
      o('Bet365',       'moneyline', 'Home', 2.00), o('Bet365',       'moneyline', 'Away', 1.95),
      o('William Hill', 'moneyline', 'Home', 1.95), o('William Hill', 'moneyline', 'Away', 2.00),
      o('Pinnacle',     'totals', 'Over 218.5',  1.93), o('Pinnacle',     'totals', 'Under 218.5', 1.94),
      o('Bet365',       'totals', 'Over 218.5',  2.05), o('Bet365',       'totals', 'Under 218.5', 1.85),
    ];

    // ── HOCKEY ───────────────────────────────────────────
    if (id === 'hockey-t1') return [
      o('Pinnacle',     'moneyline', 'home', 1.59), o('Pinnacle',     'moneyline', 'away', 2.55),
      o('Bet365',       'moneyline', 'home', 1.75), o('Bet365',       'moneyline', 'away', 2.25),
      o('William Hill', 'moneyline', 'home', 1.70), o('William Hill', 'moneyline', 'away', 2.30),
      o('Pinnacle',     'under_5.5', 'Over 5.5',  1.88), o('Pinnacle',     'under_5.5', 'Under 5.5', 1.99),
      o('Bet365',       'under_5.5', 'Over 5.5',  2.05), o('Bet365',       'under_5.5', 'Under 5.5', 1.85),
    ];
    if (id === 'hockey-t2') return [
      o('Pinnacle',     'moneyline', 'home', 1.96), o('Pinnacle',     'moneyline', 'away', 2.00),
      o('Bet365',       'moneyline', 'home', 2.15), o('Bet365',       'moneyline', 'away', 1.85),
      o('William Hill', 'moneyline', 'home', 2.10), o('William Hill', 'moneyline', 'away', 1.88),
      o('Pinnacle',     'under_5.5', 'Over 5.5',  1.90), o('Pinnacle',     'under_5.5', 'Under 5.5', 1.97),
      o('Bet365',       'under_5.5', 'Over 5.5',  2.00), o('Bet365',       'under_5.5', 'Under 5.5', 1.88),
    ];
    if (id === 'hockey-t3') return [
      o('Pinnacle',     'moneyline', 'home', 1.85), o('Pinnacle',     'moneyline', 'away', 2.10),
      o('Bet365',       'moneyline', 'home', 2.00), o('Bet365',       'moneyline', 'away', 1.95),
      o('William Hill', 'moneyline', 'home', 1.95), o('William Hill', 'moneyline', 'away', 2.00),
      o('Pinnacle',     'under_5.5', 'Over 5.5',  1.92), o('Pinnacle',     'under_5.5', 'Under 5.5', 1.95),
      o('Bet365',       'under_5.5', 'Over 5.5',  2.05), o('Bet365',       'under_5.5', 'Under 5.5', 1.83),
    ];

    return [];
  }

  // ─── STATS ─────────────────────────────────────────────

  async fetchStats(externalMatchId: string): Promise<ApiResponse<RawStats>> {
    await this.simulateDelay();
    const stats = this.buildStats(externalMatchId);
    if (!stats) return { data: null, success: false, error: 'Unknown match ID', correlationId: `mock_${Date.now()}` };
    logger.info(`[MockClient] Fetched stats for ${externalMatchId}`);
    return { data: stats, success: true, statusCode: 200, correlationId: `mock_${Date.now()}` };
  }

  private buildStats(id: string): RawStats | null {

    // ── FOOTBALL ─────────────────────────────────────────
    // Validator rules: goalsFor/Against required, home/away venue split min 2 each,
    // referee name, weather, surfaceType, min 5 form records, min 3 H2H

    if (id === 'football-t1') return {
      externalMatchId: id, sport: 'football',
      confidenceFactors: { dataCompleteness: 0.92 },
      h2h: [
        { date: '2025-11-10', homeTeam: 'Arsenal',  awayTeam: 'Burnley', homeScore: 3, awayScore: 0 },
        { date: '2025-04-20', homeTeam: 'Burnley',  awayTeam: 'Arsenal', homeScore: 1, awayScore: 2 },
        { date: '2024-11-05', homeTeam: 'Arsenal',  awayTeam: 'Burnley', homeScore: 2, awayScore: 1 },
        { date: '2024-03-15', homeTeam: 'Burnley',  awayTeam: 'Arsenal', homeScore: 0, awayScore: 1 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Man City',  result: 'W', goalsFor: 3, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-25', opponent: 'Chelsea',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-18', opponent: 'Liverpool', result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-11', opponent: 'Tottenham', result: 'W', goalsFor: 1, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-04', opponent: 'Newcastle', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-04-27', opponent: 'Everton',   result: 'W', goalsFor: 4, goalsAgainst: 1, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Man City',  result: 'L', goalsFor: 0, goalsAgainst: 3, venue: 'away' },
        { date: '2026-05-25', opponent: 'Chelsea',   result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-18', opponent: 'Liverpool', result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-11', opponent: 'Tottenham', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-04', opponent: 'Newcastle', result: 'L', goalsFor: 0, goalsAgainst: 1, venue: 'home' },
        { date: '2026-04-27', opponent: 'Everton',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
      ],
      referee: { name: 'M. Oliver', avgYellowCards: 3.8, avgRedCards: 0.1, avgFouls: 24.2 },
      situational: { weather: 'clear', temperature: 17, fatigueDays: 7, surfaceType: 'grass' },
    };

    if (id === 'football-t2') return {
      externalMatchId: id, sport: 'football',
      confidenceFactors: { dataCompleteness: 0.85 },
      h2h: [
        { date: '2025-10-15', homeTeam: 'Chelsea', awayTeam: 'Wolves', homeScore: 2, awayScore: 1 },
        { date: '2025-03-20', homeTeam: 'Wolves',  awayTeam: 'Chelsea', homeScore: 1, awayScore: 1 },
        { date: '2024-10-10', homeTeam: 'Chelsea', awayTeam: 'Wolves', homeScore: 1, awayScore: 2 },
        { date: '2024-02-28', homeTeam: 'Wolves',  awayTeam: 'Chelsea', homeScore: 0, awayScore: 1 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Arsenal',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-25', opponent: 'Man City',  result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-18', opponent: 'Liverpool', result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-11', opponent: 'Tottenham', result: 'L', goalsFor: 0, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-04', opponent: 'Newcastle', result: 'W', goalsFor: 1, goalsAgainst: 0, venue: 'away' },
        { date: '2026-04-27', opponent: 'Everton',   result: 'D', goalsFor: 2, goalsAgainst: 2, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Arsenal',   result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'away' },
        { date: '2026-05-25', opponent: 'Man City',  result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-18', opponent: 'Liverpool', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-11', opponent: 'Tottenham', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-04', opponent: 'Newcastle', result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'home' },
        { date: '2026-04-27', opponent: 'Everton',   result: 'L', goalsFor: 0, goalsAgainst: 1, venue: 'away' },
      ],
      referee: { name: 'A. Taylor', avgYellowCards: 4.1, avgRedCards: 0.2, avgFouls: 26.5 },
      situational: { weather: 'cloudy', temperature: 14, fatigueDays: 6, surfaceType: 'grass' },
    };

    if (id === 'football-t3') return {
      externalMatchId: id, sport: 'football',
      confidenceFactors: { dataCompleteness: 0.78 },
      h2h: [
        { date: '2025-09-20', homeTeam: 'Liverpool',  awayTeam: 'Brentford', homeScore: 1, awayScore: 1 },
        { date: '2025-02-14', homeTeam: 'Brentford', awayTeam: 'Liverpool',  homeScore: 2, awayScore: 1 },
        { date: '2024-09-15', homeTeam: 'Liverpool',  awayTeam: 'Brentford', homeScore: 3, awayScore: 2 },
        { date: '2024-01-20', homeTeam: 'Brentford', awayTeam: 'Liverpool',  homeScore: 1, awayScore: 0 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Arsenal',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-25', opponent: 'Man City',  result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-18', opponent: 'Chelsea',   result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-11', opponent: 'Tottenham', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-04', opponent: 'Newcastle', result: 'L', goalsFor: 0, goalsAgainst: 1, venue: 'away' },
        { date: '2026-04-27', opponent: 'Everton',   result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Arsenal',   result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-25', opponent: 'Man City',  result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-18', opponent: 'Chelsea',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-11', opponent: 'Tottenham', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-04', opponent: 'Newcastle', result: 'W', goalsFor: 1, goalsAgainst: 0, venue: 'home' },
        { date: '2026-04-27', opponent: 'Everton',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
      ],
      referee: { name: 'C. Pawson', avgYellowCards: 3.5, avgRedCards: 0.1, avgFouls: 23.8 },
      situational: { weather: 'clear', temperature: 16, fatigueDays: 5, surfaceType: 'grass' },
    };

    // ── TENNIS ───────────────────────────────────────────
    // Validator rules: surfaceType REQUIRED in additionalContext (hard reject if missing)
    // NO referee penalty, NO venue split penalty, NO goals data required
    // Fatigue: fatigueDays < 2 = back-to-back warning
    // Min 5 form records, min 3 H2H

    if (id === 'tennis-t1') return {
      externalMatchId: id, sport: 'tennis',
      confidenceFactors: { dataCompleteness: 0.90 },
      h2h: [
        { date: '2025-10-15', homeTeam: 'Alcaraz C.', awayTeam: 'Rune H.',    homeScore: 2, awayScore: 0 },
        { date: '2025-05-20', homeTeam: 'Rune H.',    awayTeam: 'Alcaraz C.', homeScore: 0, awayScore: 2 },
        { date: '2024-11-10', homeTeam: 'Alcaraz C.', awayTeam: 'Rune H.',    homeScore: 2, awayScore: 1 },
        { date: '2024-06-05', homeTeam: 'Rune H.',    awayTeam: 'Alcaraz C.', homeScore: 1, awayScore: 2 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Sinner J.',   result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-28', opponent: 'Djokovic N.', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-25', opponent: 'Medvedev D.', result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-22', opponent: 'Zverev A.',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-19', opponent: 'Paul T.',     result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-15', opponent: 'Norrie C.',   result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Sinner J.',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-28', opponent: 'Djokovic N.', result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-25', opponent: 'Medvedev D.', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-22', opponent: 'Zverev A.',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-19', opponent: 'Paul T.',     result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-15', opponent: 'Norrie C.',   result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'away' },
      ],
      referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
      situational: { weather: 'clear', temperature: 22, fatigueDays: 3, surfaceType: 'clay' },
      additionalContext: {
        surfaceType: 'clay',
        homeSurfaceSpecialist: 'clay',
        awaySurfaceSpecialist: 'hard',
        homeServeDominant: false,
        awayServeDominant: false,
      },
    };

    if (id === 'tennis-t2') return {
      externalMatchId: id, sport: 'tennis',
      confidenceFactors: { dataCompleteness: 0.83 },
      h2h: [
        { date: '2025-09-10', homeTeam: 'Medvedev D.', awayTeam: 'Paul T.',     homeScore: 2, awayScore: 1 },
        { date: '2025-03-05', homeTeam: 'Paul T.',     awayTeam: 'Medvedev D.', homeScore: 0, awayScore: 2 },
        { date: '2024-08-20', homeTeam: 'Medvedev D.', awayTeam: 'Paul T.',     homeScore: 2, awayScore: 0 },
        { date: '2024-01-15', homeTeam: 'Paul T.',     awayTeam: 'Medvedev D.', homeScore: 1, awayScore: 2 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Sinner J.',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-28', opponent: 'Zverev A.',   result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-25', opponent: 'Alcaraz C.',  result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-22', opponent: 'Djokovic N.', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-19', opponent: 'Norrie C.',   result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-15', opponent: 'Paul T.',     result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Sinner J.',   result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-28', opponent: 'Zverev A.',   result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'away' },
        { date: '2026-05-25', opponent: 'Alcaraz C.',  result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-22', opponent: 'Djokovic N.', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-19', opponent: 'Norrie C.',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-15', opponent: 'Paul T.',     result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
      ],
      referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
      situational: { weather: 'clear', temperature: 24, fatigueDays: 4, surfaceType: 'hard' },
      additionalContext: {
        surfaceType: 'hard',
        homeSurfaceSpecialist: 'hard',
        awaySurfaceSpecialist: 'hard',
        homeServeDominant: true,
        awayServeDominant: false,
      },
    };

    if (id === 'tennis-t3') return {
      externalMatchId: id, sport: 'tennis',
      confidenceFactors: { dataCompleteness: 0.76 },
      h2h: [
        { date: '2025-07-05', homeTeam: 'Zverev A.', awayTeam: 'Norrie C.', homeScore: 2, awayScore: 1 },
        { date: '2025-01-20', homeTeam: 'Norrie C.', awayTeam: 'Zverev A.', homeScore: 1, awayScore: 2 },
        { date: '2024-07-03', homeTeam: 'Zverev A.', awayTeam: 'Norrie C.', homeScore: 1, awayScore: 2 },
        { date: '2023-11-10', homeTeam: 'Norrie C.', awayTeam: 'Zverev A.', homeScore: 0, awayScore: 2 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Alcaraz C.',  result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-28', opponent: 'Sinner J.',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-25', opponent: 'Medvedev D.', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-22', opponent: 'Paul T.',     result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-19', opponent: 'Djokovic N.', result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-15', opponent: 'Norrie C.',   result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Alcaraz C.',  result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-28', opponent: 'Sinner J.',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-25', opponent: 'Medvedev D.', result: 'D', goalsFor: 1, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-22', opponent: 'Paul T.',     result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-19', opponent: 'Djokovic N.', result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-15', opponent: 'Zverev A.',   result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'away' },
      ],
      referee: { name: '', avgYellowCards: 0, avgRedCards: 0, avgFouls: 0 },
      situational: { weather: 'windy', temperature: 19, fatigueDays: 5, surfaceType: 'grass' },
      additionalContext: {
        surfaceType: 'grass',
        homeSurfaceSpecialist: 'clay',
        awaySurfaceSpecialist: 'grass',
        homeServeDominant: true,
        awayServeDominant: false,
      },
    };

    // ── BASKETBALL ───────────────────────────────────────
    // Validator rules: pace REQUIRED in additionalContext (hard reject if missing)
    // goalsFor = points scored, referee foul rate affects totals
    // Fatigue: fatigueDays < 2 = back-to-back warning
    // Min 5 form records, min 3 H2H

    if (id === 'basketball-t1') return {
      externalMatchId: id, sport: 'basketball',
      confidenceFactors: { dataCompleteness: 0.91 },
      h2h: [
        { date: '2026-03-15', homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat',     homeScore: 118, awayScore: 104 },
        { date: '2026-01-22', homeTeam: 'Miami Heat',     awayTeam: 'Boston Celtics', homeScore: 109, awayScore: 115 },
        { date: '2025-11-10', homeTeam: 'Boston Celtics', awayTeam: 'Miami Heat',     homeScore: 122, awayScore: 108 },
        { date: '2025-04-05', homeTeam: 'Miami Heat',     awayTeam: 'Boston Celtics', homeScore: 101, awayScore: 110 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Milwaukee', result: 'W', goalsFor: 124, goalsAgainst: 108, venue: 'home' },
        { date: '2026-05-29', opponent: 'Cleveland', result: 'W', goalsFor: 118, goalsAgainst: 112, venue: 'away' },
        { date: '2026-05-26', opponent: 'Philly',    result: 'W', goalsFor: 121, goalsAgainst: 105, venue: 'home' },
        { date: '2026-05-23', opponent: 'Toronto',   result: 'W', goalsFor: 115, goalsAgainst: 109, venue: 'home' },
        { date: '2026-05-20', opponent: 'Brooklyn',  result: 'D', goalsFor: 110, goalsAgainst: 110, venue: 'away' },
        { date: '2026-05-17', opponent: 'Charlotte', result: 'W', goalsFor: 130, goalsAgainst: 115, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Milwaukee', result: 'L', goalsFor: 98,  goalsAgainst: 112, venue: 'away' },
        { date: '2026-05-29', opponent: 'Cleveland', result: 'L', goalsFor: 105, goalsAgainst: 118, venue: 'home' },
        { date: '2026-05-26', opponent: 'Philly',    result: 'L', goalsFor: 102, goalsAgainst: 115, venue: 'away' },
        { date: '2026-05-23', opponent: 'Toronto',   result: 'D', goalsFor: 108, goalsAgainst: 108, venue: 'away' },
        { date: '2026-05-20', opponent: 'Brooklyn',  result: 'L', goalsFor: 99,  goalsAgainst: 110, venue: 'home' },
        { date: '2026-05-17', opponent: 'Charlotte', result: 'L', goalsFor: 104, goalsAgainst: 115, venue: 'away' },
      ],
      referee: { name: 'S. Foster', avgYellowCards: 0, avgRedCards: 0, avgFouls: 44.2 },
      situational: { weather: 'indoor', temperature: 20, fatigueDays: 3 },
      additionalContext: { pace: 102.4 },
    };

    if (id === 'basketball-t2') return {
      externalMatchId: id, sport: 'basketball',
      confidenceFactors: { dataCompleteness: 0.84 },
      h2h: [
        { date: '2026-02-10', homeTeam: 'LA Lakers',    awayTeam: 'Phoenix Suns', homeScore: 112, awayScore: 108 },
        { date: '2025-12-05', homeTeam: 'Phoenix Suns', awayTeam: 'LA Lakers',    homeScore: 115, awayScore: 109 },
        { date: '2025-10-20', homeTeam: 'LA Lakers',    awayTeam: 'Phoenix Suns', homeScore: 105, awayScore: 118 },
        { date: '2025-03-15', homeTeam: 'Phoenix Suns', awayTeam: 'LA Lakers',    homeScore: 108, awayScore: 105 },
      ],
      homeForm: [
        { date: '2026-06-01', opponent: 'Golden State', result: 'W', goalsFor: 115, goalsAgainst: 110, venue: 'home' },
        { date: '2026-05-29', opponent: 'Sacramento',   result: 'L', goalsFor: 108, goalsAgainst: 112, venue: 'away' },
        { date: '2026-05-26', opponent: 'Portland',     result: 'W', goalsFor: 120, goalsAgainst: 105, venue: 'home' },
        { date: '2026-05-23', opponent: 'Utah',         result: 'D', goalsFor: 110, goalsAgainst: 110, venue: 'home' },
        { date: '2026-05-20', opponent: 'Minnesota',    result: 'L', goalsFor: 102, goalsAgainst: 115, venue: 'away' },
        { date: '2026-05-17', opponent: 'Oklahoma',     result: 'W', goalsFor: 118, goalsAgainst: 108, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'Golden State', result: 'W', goalsFor: 118, goalsAgainst: 112, venue: 'away' },
        { date: '2026-05-29', opponent: 'Sacramento',   result: 'L', goalsFor: 105, goalsAgainst: 115, venue: 'home' },
        { date: '2026-05-26', opponent: 'Portland',     result: 'D', goalsFor: 108, goalsAgainst: 108, venue: 'away' },
        { date: '2026-05-23', opponent: 'Utah',         result: 'W', goalsFor: 115, goalsAgainst: 108, venue: 'away' },
        { date: '2026-05-20', opponent: 'Minnesota',    result: 'L', goalsFor: 99,  goalsAgainst: 112, venue: 'home' },
        { date: '2026-05-17', opponent: 'Oklahoma',     result: 'W', goalsFor: 112, goalsAgainst: 105, venue: 'away' },
      ],
      referee: { name: 'T. Brothers', avgYellowCards: 0, avgRedCards: 0, avgFouls: 41.8 },
      situational: { weather: 'indoor', temperature: 21, fatigueDays: 2 },
      additionalContext: { pace: 99.5 },
    };

    if (id === 'basketball-t3') return {
      externalMatchId: id, sport: 'basketball',
      confidenceFactors: { dataCompleteness: 0.88 },
      h2h: [
        { date: '2026-03-01', homeTeam: 'Denver Nuggets',   awayTeam: 'Dallas Mavericks', homeScore: 120, awayScore: 115 },
        { date: '2026-01-15', homeTeam: 'Dallas Mavericks', awayTeam: 'Denver Nuggets',   homeScore: 111, awayScore: 118 },
        { date: '2025-11-20', homeTeam: 'Denver Nuggets',   awayTeam: 'Dallas Mavericks', homeScore: 108, awayScore: 110 },
        { date: '2025-04-02', homeTeam: 'Dallas Mavericks', awayTeam: 'Denver Nuggets',   homeScore: 122, awayScore: 115 },
      ],
      homeForm: [
        { date: '2026-06-02', opponent: 'LA Clippers', result: 'W', goalsFor: 118, goalsAgainst: 111, venue: 'home' },
        { date: '2026-05-28', opponent: 'Memphis',     result: 'W', goalsFor: 125, goalsAgainst: 104, venue: 'home' },
        { date: '2026-05-24', opponent: 'GS Warriors', result: 'L', goalsFor: 102, goalsAgainst: 115, venue: 'away' },
        { date: '2026-05-21', opponent: 'Houston',     result: 'W', goalsFor: 112, goalsAgainst: 109, venue: 'home' },
        { date: '2026-05-16', opponent: 'New Orleans', result: 'W', goalsFor: 121, goalsAgainst: 118, venue: 'away' },
        { date: '2026-05-12', opponent: 'San Antonio', result: 'W', goalsFor: 115, goalsAgainst: 108, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'OKC Thunder',  result: 'W', goalsFor: 114, goalsAgainst: 112, venue: 'away' },
        { date: '2026-05-29', opponent: 'San Antonio',  result: 'W', goalsFor: 120, goalsAgainst: 101, venue: 'home' },
        { date: '2026-05-25', opponent: 'Phoenix Suns', result: 'L', goalsFor: 105, goalsAgainst: 110, venue: 'away' },
        { date: '2026-05-22', opponent: 'Sacramento',   result: 'W', goalsFor: 116, goalsAgainst: 111, venue: 'away' },
        { date: '2026-05-18', opponent: 'LA Lakers',    result: 'L', goalsFor: 101, goalsAgainst: 108, venue: 'home' },
        { date: '2026-05-14', opponent: 'Portland',     result: 'W', goalsFor: 119, goalsAgainst: 112, venue: 'away' },
      ],
      referee: { name: 'Z. Zarba', avgYellowCards: 0, avgRedCards: 0, avgFouls: 39.5 },
      situational: { weather: 'indoor', temperature: 20, fatigueDays: 4 },
      additionalContext: { pace: 100.2 },
    };

    // ── HOCKEY ───────────────────────────────────────────
    // Validator rules: goalsFor/Against required, home/away venue split min 2 each
    // avgYellowCards = penalty minutes per game (NOT avgFouls)
    // Fatigue: fatigueDays < 2 = 3rd game in 4 nights warning
    // Min 5 form records, min 3 H2H

    if (id === 'hockey-t1') return {
      externalMatchId: id, sport: 'hockey',
      confidenceFactors: { dataCompleteness: 0.94 },
      h2h: [
        { date: '2026-02-18', homeTeam: 'Tampa Bay Lightning', awayTeam: 'Boston Bruins',       homeScore: 4, awayScore: 2 },
        { date: '2025-12-12', homeTeam: 'Boston Bruins',       awayTeam: 'Tampa Bay Lightning', homeScore: 3, awayScore: 1 },
        { date: '2025-10-05', homeTeam: 'Tampa Bay Lightning', awayTeam: 'Boston Bruins',       homeScore: 3, awayScore: 3 },
        { date: '2025-03-20', homeTeam: 'Boston Bruins',       awayTeam: 'Tampa Bay Lightning', homeScore: 2, awayScore: 4 },
      ],
      homeForm: [
        { date: '2026-06-03', opponent: 'Florida',    result: 'W', goalsFor: 5, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-30', opponent: 'Toronto',    result: 'W', goalsFor: 3, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-27', opponent: 'NY Rangers', result: 'L', goalsFor: 2, goalsAgainst: 4, venue: 'away' },
        { date: '2026-05-23', opponent: 'Carolina',   result: 'W', goalsFor: 4, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-19', opponent: 'Detroit',    result: 'W', goalsFor: 2, goalsAgainst: 0, venue: 'away' },
        { date: '2026-05-15', opponent: 'Ottawa',     result: 'W', goalsFor: 3, goalsAgainst: 2, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-02', opponent: 'Montreal',   result: 'W', goalsFor: 3, goalsAgainst: 1, venue: 'away' },
        { date: '2026-05-29', opponent: 'Ottawa',     result: 'L', goalsFor: 2, goalsAgainst: 4, venue: 'away' },
        { date: '2026-05-25', opponent: 'Buffalo',    result: 'W', goalsFor: 4, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-21', opponent: 'Florida',    result: 'L', goalsFor: 1, goalsAgainst: 3, venue: 'away' },
        { date: '2026-05-17', opponent: 'Toronto',    result: 'W', goalsFor: 3, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-13', opponent: 'Carolina',   result: 'L', goalsFor: 1, goalsAgainst: 2, venue: 'away' },
      ],
      referee: { name: 'K. Sutherland', avgYellowCards: 12.4, avgRedCards: 0, avgFouls: 0 },
      situational: { weather: 'indoor', temperature: 18, fatigueDays: 4 },
    };

    if (id === 'hockey-t2') return {
      externalMatchId: id, sport: 'hockey',
      confidenceFactors: { dataCompleteness: 0.89 },
      h2h: [
        { date: '2026-03-05', homeTeam: 'Colorado Avalanche',   awayTeam: 'Vegas Golden Knights', homeScore: 3, awayScore: 4 },
        { date: '2026-01-20', homeTeam: 'Vegas Golden Knights', awayTeam: 'Colorado Avalanche',   homeScore: 2, awayScore: 5 },
        { date: '2025-11-14', homeTeam: 'Colorado Avalanche',   awayTeam: 'Vegas Golden Knights', homeScore: 4, awayScore: 1 },
        { date: '2025-02-08', homeTeam: 'Vegas Golden Knights', awayTeam: 'Colorado Avalanche',   homeScore: 3, awayScore: 2 },
      ],
      homeForm: [
        { date: '2026-06-02', opponent: 'Dallas Stars', result: 'W', goalsFor: 4, goalsAgainst: 3, venue: 'home' },
        { date: '2026-05-29', opponent: 'Edmonton',     result: 'L', goalsFor: 2, goalsAgainst: 5, venue: 'away' },
        { date: '2026-05-26', opponent: 'Vancouver',    result: 'W', goalsFor: 3, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-21', opponent: 'St. Louis',    result: 'W', goalsFor: 5, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-17', opponent: 'Winnipeg',     result: 'L', goalsFor: 3, goalsAgainst: 4, venue: 'away' },
        { date: '2026-05-13', opponent: 'Minnesota',    result: 'W', goalsFor: 4, goalsAgainst: 2, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-01', opponent: 'LA Kings',  result: 'W', goalsFor: 3, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-28', opponent: 'San Jose',  result: 'W', goalsFor: 6, goalsAgainst: 1, venue: 'home' },
        { date: '2026-05-24', opponent: 'Seattle',   result: 'L', goalsFor: 2, goalsAgainst: 3, venue: 'away' },
        { date: '2026-05-20', opponent: 'Anaheim',   result: 'W', goalsFor: 4, goalsAgainst: 0, venue: 'away' },
        { date: '2026-05-16', opponent: 'Calgary',   result: 'W', goalsFor: 3, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-12', opponent: 'Edmonton',  result: 'L', goalsFor: 1, goalsAgainst: 4, venue: 'away' },
      ],
      referee: { name: 'W. McCauley', avgYellowCards: 18.2, avgRedCards: 0, avgFouls: 0 },
      situational: { weather: 'indoor', temperature: 19, fatigueDays: 3 },
    };

    if (id === 'hockey-t3') return {
      externalMatchId: id, sport: 'hockey',
      confidenceFactors: { dataCompleteness: 0.85 },
      h2h: [
        { date: '2026-02-22', homeTeam: 'Toronto Maple Leafs', awayTeam: 'Montreal Canadiens', homeScore: 5, awayScore: 2 },
        { date: '2025-12-18', homeTeam: 'Montreal Canadiens',  awayTeam: 'Toronto Maple Leafs', homeScore: 1, awayScore: 4 },
        { date: '2025-10-29', homeTeam: 'Toronto Maple Leafs', awayTeam: 'Montreal Canadiens', homeScore: 3, awayScore: 2 },
        { date: '2025-01-14', homeTeam: 'Montreal Canadiens',  awayTeam: 'Toronto Maple Leafs', homeScore: 2, awayScore: 3 },
      ],
      homeForm: [
        { date: '2026-06-03', opponent: 'Ottawa',       result: 'W', goalsFor: 4, goalsAgainst: 2, venue: 'home' },
        { date: '2026-05-30', opponent: 'Boston',       result: 'L', goalsFor: 1, goalsAgainst: 3, venue: 'away' },
        { date: '2026-05-26', opponent: 'Buffalo',      result: 'W', goalsFor: 3, goalsAgainst: 0, venue: 'home' },
        { date: '2026-05-22', opponent: 'NY Islanders', result: 'W', goalsFor: 5, goalsAgainst: 4, venue: 'home' },
        { date: '2026-05-18', opponent: 'Detroit',      result: 'L', goalsFor: 2, goalsAgainst: 3, venue: 'away' },
        { date: '2026-05-14', opponent: 'Florida',      result: 'W', goalsFor: 3, goalsAgainst: 1, venue: 'home' },
      ],
      awayForm: [
        { date: '2026-06-02', opponent: 'Boston',   result: 'L', goalsFor: 2, goalsAgainst: 4, venue: 'away' },
        { date: '2026-05-29', opponent: 'Buffalo',  result: 'L', goalsFor: 1, goalsAgainst: 3, venue: 'home' },
        { date: '2026-05-25', opponent: 'Detroit',  result: 'W', goalsFor: 3, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-21', opponent: 'Ottawa',   result: 'L', goalsFor: 0, goalsAgainst: 2, venue: 'away' },
        { date: '2026-05-17', opponent: 'Tampa Bay', result: 'L', goalsFor: 1, goalsAgainst: 3, venue: 'home' },
        { date: '2026-05-13', opponent: 'Carolina', result: 'W', goalsFor: 2, goalsAgainst: 1, venue: 'away' },
      ],
      referee: { name: 'E. Furlatt', avgYellowCards: 14.8, avgRedCards: 0, avgFouls: 0 },
      situational: { weather: 'indoor', temperature: 18, fatigueDays: 6 },
    };

    return null;
  }
}