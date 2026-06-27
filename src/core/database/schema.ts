// src/core/database/schema.ts
import Database from 'better-sqlite3';

// ─── INTERFACES ──────────────────────────────────────────────────────────────

export interface Match {
  id: string;
  sport: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  status?: 'upcoming' | 'live' | 'completed' | 'cancelled';
  externalId?: string;
  source?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface Odds {
  id: string;
  matchId: string;
  bookmaker: string;
  market: string;
  selection: string;
  odds: number;
  impliedProbability: number;
  timestamp: string;
  source?: string;
}

export interface H2HRecord {
  date: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  winner: 'home' | 'away' | 'draw';
}

export interface FormRecord {
  date: string;
  opponent: string;
  result: 'W' | 'L' | 'D';
  goalsFor?: number;
  goalsAgainst?: number;
  venue: 'home' | 'away';
}

export interface RefereeStats {
  name?: string;
  avgYellowCards?: number;
  avgRedCards?: number;
  avgFouls?: number;
  homeWinRate?: number;
  penaltyRate?: number;
}

export interface SituationalStats {
  weather?: string;
  temperature?: number;
  fatigueDays?: number;
  travelDistance?: number;
  isNeutralVenue?: boolean;
}

export interface ConfidenceFactors {
  dataCompleteness: number;
  h2hSampleSize: number;
  formSampleSize: number;
  oddsMovement?: number;
  sharpMoneyIndicator?: number;
}

export interface Stats {
  id: string;
  matchId: string;
  sport: string;
  h2h: H2HRecord[];
  homeForm: FormRecord[];
  awayForm: FormRecord[];
  referee: RefereeStats;
  situational: SituationalStats;
  homeGoalsAvg?: number;
  awayGoalsAvg?: number;
  additionalContext: Record<string, unknown>;
  confidenceFactors: ConfidenceFactors;
  lastUpdated?: string;
}

export interface ValueBet {
  id: string;
  matchId: string;
  market: string;
  selection: string;
  bookmaker: string;
  bookmakerOdds: number;
  trueProbability: number;
  impliedProbability: number;
  edge: number;
  kellyStake: number;
  confidence: number;
  status: 'pending' | 'won' | 'lost' | 'void' | 'cancelled' | 'closed';
  closingOdds?: number;
  clvValue?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CLVRecord {
  id: string;
  valueBetId: string;
  matchId: string;
  openingOdds: number;
  closingOdds: number;
  ourOdds: number;
  clvValue: number;
  clvPercentage: number;
  recordedAt?: string;
}

export interface LeagueMapping {
  id: string;
  sport: string;
  oddspapiTournamentId: number;
  oddspapiTournamentName: string;
  oddspapiCategoryName: string;
  apiSportsLeagueId?: number;
  apiSportsLeagueName?: string;
  active: number;
  createdAt?: string;
}

export interface TeamMapping {
  id: string;
  sport: string;
  teamName: string;
  teamNameNormalized: string;
  apiSportsTeamId?: number;
  apiSportsLeagueId?: number;
  oddspapiParticipantId?: number;
  createdAt?: string;
}

// ─── SCHEMA ──────────────────────────────────────────────────────────────────

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      league TEXT NOT NULL,
      homeTeam TEXT NOT NULL,
      awayTeam TEXT NOT NULL,
      startTime TEXT NOT NULL,
      status TEXT DEFAULT 'upcoming' CHECK(status IN ('upcoming','live','completed','cancelled')),
      externalId TEXT,
      source TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS odds (
      id TEXT PRIMARY KEY,
      matchId TEXT NOT NULL,
      bookmaker TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      odds REAL NOT NULL CHECK(odds > 1.0),
      impliedProbability REAL NOT NULL CHECK(impliedProbability > 0 AND impliedProbability < 1),
      timestamp TEXT NOT NULL,
      source TEXT,
      FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE,
      UNIQUE(matchId, bookmaker, market, selection)
    );

    CREATE TABLE IF NOT EXISTS stats (
      id TEXT PRIMARY KEY,
      matchId TEXT UNIQUE NOT NULL,
      sport TEXT NOT NULL,
      h2h TEXT DEFAULT '[]',
      homeForm TEXT DEFAULT '[]',
      awayForm TEXT DEFAULT '[]',
      referee TEXT DEFAULT '{}',
      situational TEXT DEFAULT '{}',
      homeGoalsAvg REAL,
      awayGoalsAvg REAL,
      additionalContext TEXT DEFAULT '{}',
      confidenceFactors TEXT DEFAULT '{}',
      lastUpdated TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS value_bets (
      id TEXT PRIMARY KEY,
      matchId TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      bookmaker TEXT NOT NULL,
      bookmakerOdds REAL NOT NULL,
      trueProbability REAL NOT NULL CHECK(trueProbability > 0 AND trueProbability <= 1),
      impliedProbability REAL NOT NULL CHECK(impliedProbability > 0 AND impliedProbability < 1),
      edge REAL NOT NULL,
      kellyStake REAL NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','won','lost','void','cancelled','closed')),
      closingOdds REAL,
      clvValue REAL,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      updatedAt TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clv_tracking (
      id TEXT PRIMARY KEY,
      valueBetId TEXT NOT NULL,
      matchId TEXT NOT NULL,
      openingOdds REAL NOT NULL,
      closingOdds REAL NOT NULL,
      ourOdds REAL NOT NULL,
      clvValue REAL NOT NULL,
      clvPercentage REAL NOT NULL,
      recordedAt TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (valueBetId) REFERENCES value_bets(id) ON DELETE CASCADE,
      FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS league_mappings (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      oddspapiTournamentId INTEGER NOT NULL,
      oddspapiTournamentName TEXT NOT NULL,
      oddspapiCategoryName TEXT NOT NULL,
      apiSportsLeagueId INTEGER,
      apiSportsLeagueName TEXT,
      active INTEGER DEFAULT 1,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(oddspapiTournamentId)
    );

    CREATE TABLE IF NOT EXISTS team_mappings (
      id TEXT PRIMARY KEY,
      sport TEXT NOT NULL,
      teamName TEXT NOT NULL,
      teamNameNormalized TEXT NOT NULL,
      apiSportsTeamId INTEGER,
      apiSportsLeagueId INTEGER,
      oddspapiParticipantId INTEGER,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(sport, teamNameNormalized)
    );
CREATE INDEX IF NOT EXISTS idx_matches_sport ON matches(sport);
    CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
    CREATE INDEX IF NOT EXISTS idx_matches_startTime ON matches(startTime);
    CREATE INDEX IF NOT EXISTS idx_odds_matchId ON odds(matchId);
    CREATE INDEX IF NOT EXISTS idx_odds_bookmaker ON odds(bookmaker);
    CREATE INDEX IF NOT EXISTS idx_odds_timestamp ON odds(timestamp);
    CREATE INDEX IF NOT EXISTS idx_stats_matchId ON stats(matchId);
    CREATE INDEX IF NOT EXISTS idx_value_bets_matchId ON value_bets(matchId);
    CREATE INDEX IF NOT EXISTS idx_value_bets_status ON value_bets(status);
    CREATE INDEX IF NOT EXISTS idx_value_bets_edge ON value_bets(edge DESC);
    CREATE INDEX IF NOT EXISTS idx_clv_valueBetId ON clv_tracking(valueBetId);
    CREATE INDEX IF NOT EXISTS idx_league_mappings_sport ON league_mappings(sport);
    CREATE INDEX IF NOT EXISTS idx_league_mappings_tournament ON league_mappings(oddspapiTournamentId);
    CREATE INDEX IF NOT EXISTS idx_team_mappings_sport ON team_mappings(sport);
    CREATE INDEX IF NOT EXISTS idx_team_mappings_name ON team_mappings(teamNameNormalized);

    CREATE TABLE IF NOT EXISTS odds_history (
      id TEXT PRIMARY KEY,
      matchId TEXT NOT NULL,
      bookmaker TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      odds REAL NOT NULL,
      impliedProbability REAL NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (matchId) REFERENCES matches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_odds_history_matchId ON odds_history(matchId);
    CREATE INDEX IF NOT EXISTS idx_odds_history_bookmaker ON odds_history(bookmaker);
    CREATE INDEX IF NOT EXISTS idx_odds_history_timestamp ON odds_history(timestamp);
  `);
}