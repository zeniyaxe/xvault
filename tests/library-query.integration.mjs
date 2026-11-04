import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const playwright = require(process.argv[2] || 'playwright');
const browser = await playwright.chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/library-query.integration.html');
  await page.waitForFunction(() => document.querySelector('#result')?.textContent !== 'Running', null, { timeout: 30000 }).catch(() => {});
  const result = await page.locator('#result').innerText();
  if (errors.length) throw Error(errors.join('\n'));
  assert.equal(result, 'PASS', result);
  console.log('library query IndexedDB cursor/revision invariants passed');
} finally { await browser.close(); }
