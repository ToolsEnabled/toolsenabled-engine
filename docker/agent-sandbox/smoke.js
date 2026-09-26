'use strict';

const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const fixture = process.env.SANDBOX_FIXTURE_URL;
  if (fixture !== 'http://fixture:8080') throw new Error('The isolated fixture URL was not injected.');
  let publicNetworkBlocked = false;
  try {
    await fetch('https://example.com', { signal: AbortSignal.timeout(2000) });
  } catch {
    publicNetworkBlocked = true;
  }
  if (!publicNetworkBlocked) throw new Error('The fixture sandbox unexpectedly reached the public internet.');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 720 } });
    await page.goto(fixture, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.getByRole('button', { name: 'Run check' }).click();
    const status = await page.locator('#status').textContent();
    if (status !== 'fixture interaction passed') throw new Error(`Unexpected fixture status: ${status}`);
    await page.screenshot({ path: path.join('/workspace', 'artifacts', 'fixture-smoke.png'), fullPage: true });
    process.stdout.write(`${JSON.stringify({ ok: true, title: await page.title(), status, publicNetworkBlocked })}\n`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
