// Standalone test #2 — confirms the actual stats endpoint returns
// cards/SOT/possession in the shape expected, using the same
// browser-loaded-session pattern that got a 200 on the search endpoint.

import { chromium } from 'playwright-extra';
// @ts-ignore - no official types for this plugin
import stealth from 'puppeteer-extra-plugin-stealth';

chromium.use(stealth());

const SITE_URL = 'https://www.sofascore.com/';
const ARSENAL_TEAM_ID = 42; // confirmed from prior search test
const LAST_EVENTS_URL = `https://api.sofascore.com/api/v1/team/${ARSENAL_TEAM_ID}/events/last/0`;

async function fetchInPageContext(page: any, url: string) {
  return page.evaluate(async (u: string) => {
    const res = await fetch(u, { headers: { Accept: 'application/json' } });
    const status = res.status;
    const text = await res.text();
    return { status, text };
  }, url);
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();

    console.log('Loading site:', SITE_URL);
    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);

    console.log('Fetching last events for Arsenal (team 42)...');
    const eventsResult = await fetchInPageContext(page, LAST_EVENTS_URL);
    console.log('Events status:', eventsResult.status);

    if (eventsResult.status !== 200) {
      console.log('FAILED at events step. Body:', eventsResult.text.slice(0, 500));
      return;
    }

    const eventsData = JSON.parse(eventsResult.text);
    const events = eventsData.events || [];
    if (!events.length) {
      console.log('No events found in response.');
      return;
    }

    const lastEventId = events[0].id;
    const homeTeam = events[0].homeTeam?.name;
    const awayTeam = events[0].awayTeam?.name;
    console.log(`Found event ${lastEventId}: ${homeTeam} vs ${awayTeam}`);

    const statsUrl = `https://api.sofascore.com/api/v1/event/${lastEventId}/statistics`;
    console.log('Fetching statistics:', statsUrl);
    const statsResult = await fetchInPageContext(page, statsUrl);
    console.log('Statistics status:', statsResult.status);
    console.log('Body (first 1500 chars):', statsResult.text.slice(0, 1500));
  } finally {
    await browser.close();
  }
}

main();