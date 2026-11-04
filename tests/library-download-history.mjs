import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const playwright = require(process.argv[2] || 'playwright');
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/library-download-history.html');
  await page.waitForFunction(() => document.querySelector('#result')?.textContent !== 'Running', null, {
    timeout: 30000,
  });
  const text = await page.locator('#result').innerText();
  if (errors.length) throw Error(errors.join('\n'));
  const result = JSON.parse(text);
  assert.equal(result.ok, true, text);
  assert.equal(result.records, 6002);
  assert.equal(result.returned, 60);
  assert.equal(result.index, 'createdAt');
  assert.equal(result.statePageRetained, 50);
  assert.equal(result.stateIndex, 'stateKey');
  assert.equal(result.browserIdIndex, 'downloadId');
  assert.equal(result.identityIndexOperations, 2);
  assert.equal(result.identityMaterialized, 1);
  assert.equal(result.assetScanRetained, 1);
  assert.equal(result.hashMatched, true);
  assert.equal(result.assetReadLimit, 10);
  assert.equal(result.assetWasTruncated, true);
  assert.equal(result.hashReadLimit, 10);
  assert.equal(result.hashWasTruncated, true);
  assert.equal(result.cancelled, true);
  assert.equal(result.assetIndexPages, 5);
  assert.equal(result.assetIndexRead, 100);
  assert.equal(result.assetIndexUpdated, 100);
  assert.equal(result.indexedAssetRead, 1);
  assert.equal(result.indexedAssetIndex, 'usableAssetKey');
  assert.equal(result.indexedMissRead, 0);
  assert.equal(result.assetIndexReady, true);
  assert.equal(result.stateCounters?.complete, 99, 'backfill counts every retained completed row');
  assert.equal(result.stateCounters?.failed, 1, 'backfill counts failed rows separately');
  assert.equal(result.stalePatchSkipped, 1);
  assert.equal(result.currentPatchUpdated, 1);
  assert.equal(result.getAllCalls, 0);
  assert.equal(result.countCalls, 0);
  assert.equal(result.legacySchemaRows, 20);
  assert.equal(result.mixedLegacyRows, 48);
  assert.equal(result.mixedRecordsRead, 60);
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
