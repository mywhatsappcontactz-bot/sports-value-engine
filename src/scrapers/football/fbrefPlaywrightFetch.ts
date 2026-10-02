// Replacement for fetchFbrefHtml (fbrefCardsSotScraper.ts) — plain fetch()/
// curl gets served Cloudflare's managed JS challenge page ("Just a
// moment...") instead of real content, confirmed by direct test against
// a live FBref URL. This uses a real (stealth-patched) browser to
// execute the challenge JS instead.
//
// NO GUARANTEE THIS WORKS RELIABLY. Cloudflare's managed challenge tier
// increasingly fingerprints headless browsers directly, even with stealth
// patches applied. This is the best free-tier option, not a confirmed fix
// — test it against the same Arsenal URL before building anything further
// on top of it.
//
// npm install playwright playwright-extra puppeteer-extra-plugin-stealth

import { chromium } from 'playwright-extra';
// @ts-ignore - no official types for this plugin
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const CHALLENGE_WAIT_MS = 25000; // extended for diagnosis — original 8s may have been too short

export async function fetchFbrefHtmlViaBrowser(url: string): Promise<string> {
  const browser = await chromium.launch({
    headless: false, // headless mode is more readily fingerprinted than a real window
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Give Cloudflare's challenge time to run and redirect to real content.
    // If it's still on the challenge page after this wait, the attempt failed —
    // check page title for "Just a moment" as a signal.
    await page.waitForTimeout(CHALLENGE_WAIT_MS);

    const title = await page.title();
    if (title.includes('Just a moment')) {
      throw new Error(`[fbrefPlaywrightFetch] Still on Cloudflare challenge page after ${CHALLENGE_WAIT_MS}ms wait — challenge not resolved`);
    }

    const html = await page.content();
    return html;
  } finally {
    await browser.close();
  }
}