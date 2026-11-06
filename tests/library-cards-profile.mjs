/* global save, renderLib, XVaultLibraryMetrics */
// Card-layout render profile on the 50k synthetic harness: switches the Library to the Cards layout with a
// 600-post page and measures render time, mounted DOM and heap. Synthetic phase measurements, not a benchmark
// of a personal archive. Usage: node tests/library-cards-profile.mjs [playwright] [chromium] [out dir] [origin]
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url),
  pw = require(process.argv[2] || 'playwright');
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto((process.argv[5] || 'http://127.0.0.1:8765') + '/tests/dashboard-harness.html?records=50000');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(item => item !== page.mainFrame());
  await frame.locator('.nav[data-page="library"]').click();
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return state?.rows > 0 && state.loadedFor === state.queryKeyNow && !state.busy;
  });
  const report = { records: 50000, runs: [] };
  for (const view of ['cards', 'timeline', 'gallery']) {
    await frame.evaluate(async layout => {
      await save({ libraryPageSize: 600 }, false);
      document.querySelector(`#libraryLayout [data-layout="${layout}"]`)?.click();
      renderLib();
    }, view);
    await frame.waitForFunction(() => {
      const state = window.XVaultLibraryQueryState?.();
      return state?.rows === 600 && state.loadedFor === state.queryKeyNow && !state.busy;
    });
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const started = await frame.evaluate(() => performance.now());
    // Re-render the same loaded page (no query) to isolate the renderer.
    const renderMs = await frame.evaluate(async () => {
      const t0 = performance.now();
      renderLib(true);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - t0;
    });
    const facts = await frame.evaluate(() => ({
      layout: document.querySelector('#list')?.dataset.view,
      metrics: XVaultLibraryMetrics().at(-1),
      cards: document.querySelectorAll('#list .tweet').length,
      listNodes: document.querySelectorAll('#list *').length,
      documentNodes: document.getElementsByTagName('*').length,
      heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e5) / 10 : null,
    }));
    report.runs.push({
      view,
      layout: facts.layout,
      firstRenderMs: Math.round(facts.metrics?.firstRenderMs ?? -1),
      usableMs: Math.round(facts.metrics?.usableLibraryMs ?? -1),
      rerenderMs: Math.round(renderMs),
      mountedCards: facts.cards,
      listNodes: facts.listNodes,
      documentNodes: facts.documentNodes,
      heapMB: facts.heapMB,
      startedAt: Math.round(started),
    });
  }
  if (process.argv[4]) {
    await fs.mkdir(process.argv[4], { recursive: true });
    await fs.writeFile(`${process.argv[4]}/cards-profile.json`, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
