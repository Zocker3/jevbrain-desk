#!/usr/bin/env node
'use strict';
/**
 * Optional helper used to produce the README screenshots.
 *
 *   npm i --no-save puppeteer-core
 *   PORT=4777 npm run demo -- --no-open &
 *   CHROME_PATH=/path/to/chrome node scripts/screenshot.js http://127.0.0.1:4777 docs [prefix]
 *
 * Captures each view. Use demo mode (fake data) or a throwaway wallet only.
 * If the app shows the unlock screen and JEVDESK_SHOT_PASSWORD is set, it
 * unlocks through the UI first.
 */
const path = require('path');
const puppeteer = require('puppeteer-core');

const [url = 'http://127.0.0.1:4777', outDir = 'docs', prefix = ''] = process.argv.slice(2);
const password = process.env.JEVDESK_SHOT_PASSWORD || '';
const chrome = process.env.CHROME_PATH || 'google-chrome';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'networkidle0' });
  await sleep(500);
  const shot = async name => {
    const file = path.join(outDir, `${prefix}${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log('saved', file);
  };

  const onUnlock = await page.$eval('#unlock-form', el => !el.classList.contains('hidden')).catch(() => false);
  const onSetup = await page.$eval('#setup-form', el => !el.classList.contains('hidden')).catch(() => false);
  if (onSetup) { await shot('setup'); await browser.close(); return; }
  if (onUnlock) {
    await shot('unlock');
    if (!password) { await browser.close(); return; }
    await page.type('#unlock-pass', password);
    await page.click('#unlock-submit');
    await page.waitForSelector('#main:not(.hidden)', { timeout: 60000 });
  }
  await sleep(Number(process.env.JEVDESK_SHOT_WAIT || 6000));
  await shot('dashboard');
  for (const view of ['farm', 'credits', 'market', 'settings']) {
    await page.click(`.nav-item[data-view="${view}"]`);
    if (view === 'credits') { await page.click('#c-ledger-load'); }
    await sleep(2500);
    await shot(view);
  }
  await browser.close();
})().catch(err => { console.error(err); process.exit(1); });
