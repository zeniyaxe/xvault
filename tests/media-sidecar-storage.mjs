import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pw = require(process.argv[2] || 'playwright');
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/media-sidecar-storage.html', { waitUntil: 'load', timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#result')?.textContent !== 'Running', { timeout: 30000 });
  const result = await page.locator('#result').innerText();
  assert.match(result, /^PASS /, result);
  assert.deepEqual(errors, []);
  console.log(result);
} finally {
  await browser.close();
}
