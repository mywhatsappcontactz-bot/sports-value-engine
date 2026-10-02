import 'dotenv/config';
// src/scrapers/shared/flareFetch.ts
//
// Shared soccerstats.com client. Every scraper imports fetchViaFlare()
// from here — same function signature as every prior version, so no
// other file needs to change.
//
// HISTORY: FlareSolverr (Docker) → couldn't solve Turnstile. Camoufox →
// gets a real trusted browser but still hits an INTERACTIVE Turnstile
// checkbox it can't click without a paid solving service.
//
// CURRENT APPROACH: manual cookie session. A human solves the Turnstile
// checkbox once in a real browser, then this file reuses that session's
// cf_clearance cookie + User-Agent for plain HTTP requests — no browser
// automation needed at all. Free, but the cookie is short-lived:
// Cloudflare's default cf_clearance lifetime is ~30 minutes (recommended
// range 15-45 min per Cloudflare's own docs), and it's cryptographically
// tied to the exact IP + User-Agent that solved it — a mismatch on
// either invalidates it immediately, independent of the time limit.
//
// PRACTICAL IMPLICATION: this is a "solve once, batch everything" tool,
// not a set-and-forget one. Run a fresh cookie grab (see project notes
// for the DevTools steps) right before running a bulk sync, and expect
// to do it again next time — weekly, or whenever SOCCERSTATS_COOKIE
// starts returning challenge pages again.

import { logger } from '../../core/utils/logger';

const COOKIE = process.env.SOCCERSTATS_COOKIE;
const USER_AGENT = process.env.SOCCERSTATS_UA;

if (!COOKIE || !USER_AGENT) {
  logger.warn(
    '[flareFetch] SOCCERSTATS_COOKIE and/or SOCCERSTATS_UA not set in .env — ' +
      'every request will fail. Solve the Turnstile checkbox manually and ' +
      'set both before running a sync.'
  );
}

// Lighter throttle than the browser-automation versions used — plain
// HTTP requests are cheap and the whole point is finishing everything
// inside the cookie's short window, but still spaced out to look like
// normal traffic rather than a burst.
const MIN_REQUEST_GAP_MS = 1200;

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

function looksLikeChallengePage(html: string): boolean {
  // Real challenge/interstitial pages carry this exact title or these
  // element ids. Do NOT match on Cloudflare's normal analytics beacon
  // script (__CF$cv$params etc.) — that appears on legitimate pages too
  // and false-positives (confirmed against real soccerstats.com HTML).
  const hasChallengeTitle =
    html.includes('<title>Just a moment...</title>') ||
    html.includes('id="challenge-running"') ||
    html.includes('id="challenge-error-title"');

  return hasChallengeTitle || html.length < 2000;
}

/**
 * Fetch a soccerstats.com URL using a manually-obtained cf_clearance
 * session. Same signature as every prior version of this function —
 * drop-in replacement, no caller changes needed.
 *
 * Throws immediately with a clear message if the cookie has expired or
 * was never set — that's the expected failure mode of this approach,
 * not a bug to chase.
 */
export async function fetchViaFlare(url: string, _timeoutMs = 60000): Promise<string> {
  if (!COOKIE || !USER_AGENT) {
    throw new Error(
      '[flareFetch] SOCCERSTATS_COOKIE / SOCCERSTATS_UA missing from .env. ' +
        'Solve the Turnstile checkbox manually and set both before retrying.'
    );
  }

  await waitForTurn();

  logger.info('[flareFetch] Requesting with manual cookie session', { url });

  const res = await fetch(url, {
    headers: {
      Cookie: `cf_clearance=${COOKIE}`,
      'User-Agent': USER_AGENT,
    },
  });

  if (!res.ok) {
    throw new Error(`[flareFetch] HTTP error ${res.status} for ${url}`);
  }

  const html = await res.text();

  if (looksLikeChallengePage(html)) {
    logger.warn('[flareFetch] Got a challenge page — cookie likely expired or IP mismatch', {
      url,
      htmlLength: html.length,
    });
    throw new Error(
      `[flareFetch] Challenge page for ${url} — cookie has expired (they last ~30-45 min) or your IP ` +
        `changed since solving it. Grab a fresh cf_clearance cookie and re-run.`
    );
  }

  logger.info('[flareFetch] Success', { url, htmlLength: html.length });

  return html;
}