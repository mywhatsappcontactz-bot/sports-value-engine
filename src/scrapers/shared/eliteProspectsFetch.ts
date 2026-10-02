import 'dotenv/config';
// src/scrapers/shared/eliteProspectsFetch.ts
//
// EliteProspects.com client — mirrors flareFetch.ts's manual-cookie-
// session approach exactly, same reasoning: a human solves the
// Cloudflare/Turnstile challenge once in a real browser, this file
// reuses that session's cf_clearance cookie + User-Agent for plain HTTP
// requests. Confirmed 2026-08-30: eliteprospects.com shows the identical
// challenge-page wall as soccerstats.com/proballers.com — same fix
// applies.
//
// PRACTICAL IMPLICATION (same as flareFetch.ts): cf_clearance typically
// lasts ~30-45 minutes and is tied to the exact IP + User-Agent that
// solved it. Solve-once-batch-everything, not set-and-forget — grab a
// fresh cookie right before a bulk sync, expect to redo it periodically.
//
// Kept as a SEPARATE file/queue from flareFetch.ts rather than
// generalizing that file to take a site parameter — avoids any risk of
// breaking the existing, working soccerstats.com callers while adding
// this.

import { logger } from '../../core/utils/logger';

const COOKIE = process.env.ELITEPROSPECTS_COOKIE;
const USER_AGENT = process.env.ELITEPROSPECTS_UA;

if (!COOKIE || !USER_AGENT) {
  logger.warn(
    '[eliteProspectsFetch] ELITEPROSPECTS_COOKIE and/or ELITEPROSPECTS_UA not set in .env — ' +
      'every request will fail. Solve the Cloudflare challenge manually and ' +
      'set both before running a sync.'
  );
}

// Same throttle value as flareFetch.ts — no reason to be more aggressive
// here, same "look like normal traffic" reasoning applies.
const MIN_REQUEST_GAP_MS = 1200;

// Independent queue/throttle state from flareFetch.ts — these are two
// different sites with two different cookie sessions, no reason for one
// site's request pacing to block the other's.
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

// UNVERIFIED against real eliteprospects.com challenge-page markup — the
// exact title/element ids may differ from soccerstats.com's Cloudflare
// setup. Using the same detection logic as flareFetch.ts as a starting
// point (title check + short-response-length fallback), but if this
// scraper starts silently accepting challenge pages as real content (or
// silently rejecting real short pages), this function is the first place
// to check and correct against real captured HTML.
function looksLikeChallengePage(html: string): boolean {
  const hasChallengeTitle =
    html.includes('<title>Just a moment...</title>') ||
    html.includes('id="challenge-running"') ||
    html.includes('id="challenge-error-title"') ||
    html.includes('id="challenge-error-text"'); // seen directly in this session's own blocked response

  return hasChallengeTitle || html.length < 2000;
}

/**
 * Fetch an eliteprospects.com URL using a manually-obtained cf_clearance
 * session. Throws immediately with a clear message if the cookie has
 * expired or was never set — expected failure mode of this approach, not
 * a bug to chase (same as flareFetch.ts).
 */
export async function fetchViaEliteProspects(url: string, _timeoutMs = 60000): Promise<string> {
  if (!COOKIE || !USER_AGENT) {
    throw new Error(
      '[eliteProspectsFetch] ELITEPROSPECTS_COOKIE / ELITEPROSPECTS_UA missing from .env. ' +
        'Solve the Cloudflare challenge manually and set both before retrying.'
    );
  }

  await waitForTurn();

  logger.info('[eliteProspectsFetch] Requesting with manual cookie session', { url });

  const res = await fetch(url, {
    headers: {
      Cookie: `cf_clearance=${COOKIE}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!res.ok) {
    throw new Error(`[eliteProspectsFetch] HTTP error ${res.status} for ${url}`);
  }

  const html = await res.text();

  if (looksLikeChallengePage(html)) {
    logger.warn('[eliteProspectsFetch] Got a challenge page — cookie likely expired or IP mismatch', {
      url,
      htmlLength: html.length,
    });
    throw new Error(
      `[eliteProspectsFetch] Challenge page for ${url} — cookie has expired (they last ~30-45 min) or your IP ` +
        `changed since solving it. Grab a fresh cf_clearance cookie and re-run.`
    );
  }

  logger.info('[eliteProspectsFetch] Success', { url, htmlLength: html.length });

  return html;
}