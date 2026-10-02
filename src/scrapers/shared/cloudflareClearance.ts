// src/scrapers/shared/cloudflareClearance.ts
//
// Reads a MANUALLY-obtained Cloudflare clearance cookie from disk (saved
// via scripts/set-clearance-cookie.ts) and returns fetch-ready headers.
//
// The automated approach (Playwright launching a real browser to solve
// the challenge itself) does NOT work — confirmed 2026-08-14: Cloudflare
// detects the Playwright-controlled browser as automation and blocks it
// outright (title stays "Just a moment...", zero cookies set, even after
// waiting), before any human-solvable challenge is even offered. This is
// the same failure mode that made the earlier FCStats Playwright fix
// become unreliable over time.
//
// So: no auto-refresh here. When a request starts 403ing again, that
// means the saved cookie has gone stale — manually grab a fresh one from
// a real browser's DevTools (Network tab -> the site's own document
// request -> Request Headers -> "cookie:" value) and re-run
// set-clearance-cookie.ts. There is currently no way to know the real
// TTL in advance; treat every 403 after a period of success as "time to
// refresh," not as a code bug.

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../core/utils/logger';

export type ClearanceSite = 'soccerstats' | 'proballers';

const CACHE_DIR = path.join(__dirname, '../../../.cache/clearance');

interface ClearanceEntry {
  cookie: string;
  userAgent: string;
  savedAt: number;
}

function cachePath(site: ClearanceSite): string {
  return path.join(CACHE_DIR, `${site}-clearance.json`);
}

// No TTL enforced here — we don't know the real expiry, and the
// consequence of using a slightly-stale cookie is just a normal 403
// (same as having none at all), not a worse failure mode. So this
// simply returns whatever was last saved, however old, and lets the
// actual HTTP response be the source of truth about staleness.
function readEntry(site: ClearanceSite): ClearanceEntry | null {
  try {
    const filePath = cachePath(site);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err: any) {
    logger.warn('[CloudflareClearance] Failed to read clearance file', { site, error: err.message });
    return null;
  }
}

/**
 * Returns fetch-ready headers (User-Agent + Cookie) for the given site,
 * from the manually-saved clearance file. Returns null if no clearance
 * has ever been saved for this site — callers should fall back to their
 * normal headers in that case (better to try without a cookie than to
 * throw, since the site might not always be challenging).
 */
export function getClearanceHeaders(site: ClearanceSite): Record<string, string> | null {
  const entry = readEntry(site);
  if (!entry) {
    logger.warn('[CloudflareClearance] No saved clearance — run scripts/set-clearance-cookie.ts first', { site });
    return null;
  }

  const ageHours = ((Date.now() - entry.savedAt) / (1000 * 60 * 60)).toFixed(1);
  logger.info('[CloudflareClearance] Using saved clearance', { site, ageHours });

  return {
    'User-Agent': entry.userAgent,
    'Cookie': entry.cookie,
  };
}

/**
 * Convenience helper — merges clearance headers (if available) into an
 * existing headers object, without overwriting fields the clearance
 * doesn't provide (e.g. Accept, Accept-Language already set by the
 * caller). Falls back to the original headers unchanged if no clearance
 * is saved.
 */
export function withClearance(site: ClearanceSite, baseHeaders: Record<string, string>): Record<string, string> {
  const clearance = getClearanceHeaders(site);
  if (!clearance) return baseHeaders;
  return { ...baseHeaders, ...clearance };
}