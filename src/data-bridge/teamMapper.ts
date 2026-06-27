  import { getDb } from '../core/database/db';
  import { logger } from '../core/utils/logger';
  import { v4 as uuidv4 } from 'uuid';

  // ─── LEAGUE MAP ─────────────────────────────────────────────────────────────

  export const LEAGUE_ID_MAP: Record<string, number> = {
    'Veikkausliiga - Finland': 244,
    'Superettan - Sweden':     114,
    'Eliteserien - Norway':    103,
    'Allsvenskan - Sweden':    113,
    'A-League - Australia':    188,
    'League of Ireland':       357,
    'La Liga 2 - Spain':       141,
    'Denmark Superliga':       119,
    'Brasileirao Serie A':      71,
    'Brasileirao Serie B':      72,
    'MLS - USA':               253,
  };

  // ─── FUZZY MATCH ────────────────────────────────────────────────────────────

  function normalize(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function similarity(a: string, b: string): number {
    const na = normalize(a);
    const nb = normalize(b);
    if (na === nb) return 1.0;
    if (na.includes(nb) || nb.includes(na)) return 0.9;

    const ta = new Set(na.split(' '));
    const tb = new Set(nb.split(' '));
    const intersection = [...ta].filter(t => tb.has(t)).length;
    const union = new Set([...ta, ...tb]).size;
    return intersection / union;
  }

  // ─── API FETCH ───────────────────────────────────────────────────────────────

  async function searchTeam(name: string): Promise<{ id: number; name: string } | null> {
    const key = process.env.API_SPORTS_KEY!;

    const attempts = [
      name,
      name.split(' ')[0],
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''),
      name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(' ')[0],
    ];

    for (const term of attempts) {
      const url = `https://v3.football.api-sports.io/teams?search=${encodeURIComponent(term)}`;
      const res = await fetch(url, { headers: { 'x-apisports-key': key } });
      const data = await res.json() as any;
      const teams: any[] = data.response || [];

      if (!teams.length) continue;

      let best: { id: number; name: string } | null = null;
      let bestScore = 0;

      for (const t of teams) {
        const score = similarity(term, t.team.name);
        if (score > bestScore) {
          bestScore = score;
          best = { id: t.team.id, name: t.team.name };
        }
      }

      if (best && bestScore >= 0.3) return best;
    }

    return null;
  }
  // ─── MAPPER CLASS ────────────────────────────────────────────────────────────

  export class TeamMapper {
    private db = getDb();

    getCached(teamName: string, leagueName: string): number | null {
      const leagueId = LEAGUE_ID_MAP[leagueName];
      if (!leagueId) return null;

      const normalized = normalize(teamName);
      const row = this.db.prepare(
        'SELECT apiSportsTeamId FROM team_mappings WHERE teamNameNormalized = ? AND apiSportsLeagueId = ?'
      ).get(normalized, leagueId) as { apiSportsTeamId: number } | undefined;

      return row?.apiSportsTeamId ?? null;
    }

    private saveMapping(teamName: string, leagueName: string, apiSportsTeamId: number): void {
      const leagueId = LEAGUE_ID_MAP[leagueName];
      const normalized = normalize(teamName);
      this.db.prepare(`
        INSERT INTO team_mappings (id, sport, teamName, teamNameNormalized, apiSportsTeamId, apiSportsLeagueId)
        VALUES (?, 'football', ?, ?, ?, ?)
        ON CONFLICT(sport, teamNameNormalized) DO UPDATE SET
          apiSportsTeamId = excluded.apiSportsTeamId,
          apiSportsLeagueId = excluded.apiSportsLeagueId
      `).run(uuidv4(), teamName, normalized, apiSportsTeamId, leagueId);
    }

    async resolveTeam(teamName: string, leagueName: string): Promise<number | null> {
      const cached = this.getCached(teamName, leagueName);
      if (cached) {
        logger.debug('[TeamMapper] Cache hit', { teamName, id: cached });
        return cached;
      }

      const leagueId = LEAGUE_ID_MAP[leagueName];
      if (!leagueId) {
        logger.warn('[TeamMapper] No league ID for', { leagueName });
        return null;
      }

      try {
        const result = await searchTeam(teamName);
        if (!result) {
          logger.warn('[TeamMapper] No match found', { teamName, leagueName });
          return null;
        }

        this.saveMapping(teamName, leagueName, result.id);

        logger.info('[TeamMapper] Mapped', {
          from: teamName,
          to: result.name,
          id: result.id,
        });

        return result.id;
      } catch (err: any) {
        logger.error('[TeamMapper] API error', { teamName, error: err.message });
        return null;
      }
    }

    async resolveMatch(homeTeam: string, awayTeam: string, leagueName: string): Promise<{
      homeId: number | null;
      awayId: number | null;
    }> {
      const [homeId, awayId] = await Promise.all([
        this.resolveTeam(homeTeam, leagueName),
        this.resolveTeam(awayTeam, leagueName),
      ]);
      return { homeId, awayId };
    }

    async resolveAllPending(): Promise<{ resolved: number; failed: number }> {
      const matches = this.db.prepare(
        "SELECT DISTINCT homeTeam, awayTeam, league FROM matches WHERE sport = 'football'"
      ).all() as { homeTeam: string; awayTeam: string; league: string }[];

      let resolved = 0;
      let failed = 0;

      for (const match of matches) {
        const teams = [
          { name: match.homeTeam, league: match.league },
          { name: match.awayTeam, league: match.league },
        ];

        for (const team of teams) {
          const cached = this.getCached(team.name, team.league);
          if (cached) { resolved++; continue; }

          const id = await this.resolveTeam(team.name, team.league);
          if (id) resolved++;
          else failed++;

          // 10 req/min on free tier
          await new Promise(r => setTimeout(r, 6500));
        }
      }

      logger.info('[TeamMapper] Bulk resolve complete', { resolved, failed });
      return { resolved, failed };
    }
  }

  export const teamMapper = new TeamMapper();