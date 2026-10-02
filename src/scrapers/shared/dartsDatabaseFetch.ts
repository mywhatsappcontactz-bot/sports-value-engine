import 'dotenv/config';
// src/scrapers/shared/dartsDatabaseFetch.ts
//
// dartsdatabase.co.uk client — mirrors eliteProspectsFetch.ts's
// manual-cookie-session approach exactly, same reasoning: a human solves
// the Cloudflare/Turnstile challenge once in a real browser, this file
// reuses that session's cf_clearance cookie + User-Agent for plain HTTP
// requests. Confirmed 2026-09-02 (via a real browser session, DevTools
// Network tab): dartsdatabase.co.uk shows the identical challenge-page
// wall as soccerstats.com/eliteprospects.com/proballers.com — same fix
// applies. Confirmed on BOTH player-profile-live.php AND
// display-event.php — this is domain-wide, not endpoint-specific.
//
// PRACTICAL IMPLICATION (same as eliteProspectsFetch.ts): cf_clearance
// typically lasts ~30-45 minutes and is tied to the exact IP + User-Agent
// that solved it. Solve-once-batch-everything, not set-and-forget — grab
// a fresh cookie right before a bulk sync/backtest run, expect to redo it
// periodically.
//
// Kept as a SEPARATE file/queue from flareFetch.ts and
// eliteProspectsFetch.ts, per this project's established convention —
// avoids any risk of breaking those sites' existing working callers
// while adding this.

import { logger } from '../../core/utils/logger';

const COOKIE = process.env.DARTSDATABASE_COOKIE;
const USER_AGENT = process.env.DARTSDATABASE_UA;

if (!COOKIE || !USER_AGENT) {
  logger.warn(
    '[dartsDatabaseFetch] DARTSDATABASE_COOKIE and/or DARTSDATABASE_UA not set in .env — ' +
      'every request will fail. Solve the Cloudflare challenge manually and ' +
      'set both before running a sync or backtest.'
  );
}

// Same throttle value as eliteProspectsFetch.ts/flareFetch.ts — no reason
// to be more aggressive here, same "look like normal traffic" reasoning
// applies. Matters more here than for a live scan: the backtest fetches
// 5 WGP events back-to-back, which is exactly the kind of burst that
// looks non-human without pacing.
const MIN_REQUEST_GAP_MS = 1200;

// Independent queue/throttle state from the other sites' fetch files —
// dartsdatabase.co.uk has its own cookie session, no reason for its
// request pacing to block or be blocked by soccerstats/eliteprospects.
let queue: Promise<void> = Promise.resolve();
let lastRequestAt = 0;

async function waitForTurn(): Promise<void> {
  const myTurn = queue.then(async () => {
    const elapsed = Date.now() - lastRequestAt;
    const wait = Math.max(0, MIN_REQUEST_GAP_MS - elapsed);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }
    lastRequestAt = Date.now();
  });
  queue = myTurn;
  return myTurn;
}

// CONFIRMED against a real captured dartsdatabase.co.uk challenge
// response this session: body starts with
// <title>Just a moment...</title>, and the CSP header references
// challenges.cloudflare.com — same signature family as
// eliteProspectsFetch.ts's checks. Using the identical detection logic
// (title check + short-response-length fallback) for consistency and
// because it's already proven against this exact site, not just
// inherited unverified from another site's assumption.
function looksLikeChallengePage(html: string): boolean {
  const hasChallengeTitle =
    html.includes('<title>Just a moment...</title>') ||
    html.includes('id="challenge-running"') ||
    html.includes('id="challenge-error-title"') ||
    html.includes('id="challenge-error-text"') ||
    html.includes('challenges.cloudflare.com');

  return hasChallengeTitle || html.length < 2000;
}

/**
 * Fetch a dartsdatabase.co.uk URL using a manually-obtained cf_clearance
 * session. Throws immediately with a clear message if the cookie has
 * expired or was never set — expected failure mode of this approach, not
 * a bug to chase (same as eliteProspectsFetch.ts).
 */
export async function fetchViaDartsDatabase(url: string, _timeoutMs = 60000): Promise<string> {
  if (!COOKIE || !USER_AGENT) {
    throw new Error(
      '[dartsDatabaseFetch] DARTSDATABASE_COOKIE / DARTSDATABASE_UA missing from .env. ' +
        'Solve the Cloudflare challenge manually and set both before retrying.'
    );
  }

  await waitForTurn();

  logger.info('[dartsDatabaseFetch] Requesting with manual cookie session', { url });

  const res = await fetch(url, {
    headers: {
      Cookie: `cf_clearance=${COOKIE}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!res.ok) {
    throw new Error(`[dartsDatabaseFetch] HTTP error ${res.status} for ${url}`);
  }

  const html = await res.text();

  if (looksLikeChallengePage(html)) {
    logger.warn('[dartsDatabaseFetch] Got a challenge page — cookie likely expired or IP mismatch', {
      url,
      htmlLength: html.length,
    });
    throw new Error(
      `[dartsDatabaseFetch] Challenge page for ${url} — cookie has expired (they last ~30-45 min) or your IP ` +
        `changed since solving it. Grab a fresh cf_clearance cookie and re-run.`
    );
  }

  logger.info('[dartsDatabaseFetch] Success', { url, htmlLength: html.length });

  return html;
}