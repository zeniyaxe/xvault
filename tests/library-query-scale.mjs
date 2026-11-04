import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwright = require(process.argv[2] || 'playwright');
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(180000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/library-query-scale.html');
  await page.waitForFunction(() => document.querySelector('#result')?.textContent !== 'Running', null, {
    timeout: 180000,
  });
  const result = await page.locator('#result').innerText();
  if (errors.length) throw Error(errors.join('\n'));
  const report = JSON.parse(result);
  assert.equal(report.ok, true, result);
  assert.deepEqual(
    report.measurements.map(item => item.records),
    [1000, 10000, 50000, 100000]
  );
  assert.ok(
    report.measurements.every(item => item.indexedReads === 50 && item.materialized === 50 && item.returned === 50)
  );
  assert.ok(
    report.measurements.every(item => item.remoteFirstPageReads === 50 && item.remoteFirstPageMaterialized === 50)
  );
  assert.ok(report.measurements.every(item => item.remoteSparseReads <= 2500));
  assert.ok(
    report.measurements.every(
      item =>
        item.rankRecordsRead === item.records &&
        item.rankCacheHit &&
        item.rankDurableHit &&
        item.rankRetained === Math.min(item.records, 5000) &&
        item.rankFirstRowsRead === 50
    )
  );
  assert.ok(
    report.measurements
      .filter(item => item.records > 2500)
      .every(item => item.remoteSparseMatches === 0 && item.remoteSparseHasMore)
  );
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
