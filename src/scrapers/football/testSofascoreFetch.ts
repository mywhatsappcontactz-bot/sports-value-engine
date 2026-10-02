// Standalone test — NOT part of the build. Confirms whether SofaScore's
// API works once a real browser session has loaded the site (setting
// whatever cookies/tokens curl couldn't fake), before wiring anything
// permanent. Same discipline as testFbrefFetch.ts.

import { chromium } from 'playwright-extra';
// @ts-ignore - no official types for this plugin
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const API_URL = 'https://api.sofascore.com/api/v1/search/all?q=arsenal';
const SITE_URL = 'https://www.sofascore.com/';

async function main() {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    // Load the real site first so any cookies/session tokens SofaScore's
    // own frontend sets get carried into the next request.
    console.log('Loading site:', SITE_URL);
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    console.log('Requesting API from within browser context:', API_URL);
    // Fetch the API endpoint from INSIDE the page context, not a separate
    // request — this carries the same cookies/headers a real page-driven
    // call would use.
    const result = await page.evaluate(async (url) => {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const status = res.status;
      const text = await res.text();
      return { status, text };
    }, API_URL);

    console.log('Status:', result.status);
    console.log('Body (first 500 chars):', result.text.slice(0, 500));
  } finally {
    await browser.close();
  }
}

main();