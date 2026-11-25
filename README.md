# Sports Value Engine

A multi-sport betting value detection engine built with TypeScript and Node.js.

Pinnacle sharp benchmark, Kelly sizing, Poisson+Elo models.

## Stack
TypeScript · Node.js · SQLite (better-sqlite3) · Playwright · Express

## Commands
```bash
npx ts-node src/cli/commands/scan.ts football
npx ts-node src/cli/commands/Tips.ts 24
npx ts-node scripts/syncSport.ts <proballers|hockey|basketball|soccerstats|fallback>
npx ts-node src/cli/commands/scrape.ts football
npx ts-node scripts/scanOnly.ts <sport> <hours>
```

## Setup
```bash
npm install
npx ts-node src/core/database/migrate.ts
```

## Environment Variables
```
ODDS_API_KEY=
API_SPORTS_KEY=
```

## Known issues and setup notes

This project scrapes third-party sites, which change often. Expect breakage.

**Cookies (Cloudflare)**
- Several sources (SoccerStats, EliteProspects, Proballers, FBref) need a `cf_clearance` cookie and the matching User-Agent in `.env`.
- The cookie value must be the `cf_clearance` value ONLY. Do not include the `cf_clearance=` prefix or other cookies.
- Cookies expire within hours (FBref: ~30-45 min). Solve the challenge in the same browser and network as the one running the code.
- Never commit `.env`.

**Data sources**
- Proballers: past-season schedules are now behind a login, so older head-to-head history is not scraped. The sync reuses H2H already stored in the local database; a fresh clone starts with none, so many fixtures will be rejected until history builds up.
- FBref cards/SOT/shots cover only some leagues.
- NBA fixtures come from basketball-reference (rate-limited).

**Tip output is not validated**
- Confidences come from calibration tables fitted on a different formula from the live one. Several tips cluster at a few repeated values.
- Football goals picks and hockey picks have little or no live grading yet. Do not treat any output as betting advice.
- NBA totals/team-points tips use fixed thresholds with no live price.

**Other**
- Match times for some sources are approximate (placeholder times, timezone offsets).
- Many old matches stay marked `upcoming` in the database (harmless).
- Scripts under `scripts/` are mostly git-ignored.
