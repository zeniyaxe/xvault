// Synthetic phase measurements; not a personal-archive or download benchmark.
import assert from 'node:assert/strict';
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
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.__indexMessages = [];
    new PerformanceObserver(list =>
      window.__longTasks.push(...list.getEntries().map(row => Math.round(row.duration)))
    ).observe({ type: 'longtask' });
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        if (message.type?.startsWith('dataset'))
          window.__indexMessages.push({ type: message.type, count: message.records?.length || 0 });
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.goto((process.argv[5] || 'http://127.0.0.1:8765') + '/tests/dashboard-harness.html?records=50000');
  await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.querySelector('#libraryView'));
  const frame = page.frames().find(frame => frame !== page.mainFrame());
  await frame.locator('.nav[data-page="library"]').click();
  await frame.waitForFunction(() => {
    const state = window.XVaultLibraryQueryState?.();
    return state?.rows === 50 && state.loadedFor === state.queryKeyNow && !state.busy;
  });
  const startup = await frame.evaluate(() => ({
    state: XVaultLibraryQueryState(),
    rows: XVaultLibraryRows().length,
    messages: window.__xvMessageLog,
  }));
  assert.equal(startup.rows, 50, 'a 50k archive should mount one bounded Library page');
  assert.ok(
    !startup.messages.includes('GET_LIBRARY_ROWS') && !startup.messages.includes('GET_LIBRARY_CHUNK'),
    '50k startup should not fall back to whole-store reads'
  );
  await frame.evaluate(async () => {
    await save({ libraryView: 'compact', libraryPageSize: 1500 }, false);
    renderLib();
  });
  await frame.waitForFunction(
    () =>
      document.querySelector('#list').classList.contains('xv-virtual-list') &&
      window.XVaultLibraryRows?.().length === 1500
  );
  const measure = async (name, action) => {
    await frame.evaluate(() => (window.__longTasks = []));
    const started = performance.now();
    await action();
    await frame.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return {
      name,
      elapsedMs: Math.round(performance.now() - started),
      longTasks: await frame.evaluate(() => window.__longTasks),
    };
  };
  const phases = [];
  phases.push(
    await measure('select current 1.5k page from 50k archive', () =>
      frame.evaluate(() => document.querySelector('#librarySelectResultsQuick').click())
    )
  );
  assert.match(
    await frame.locator('#librarySelectedCount').textContent(),
    /^1[\s\u00a0\u202f,.]?500 selected$/,
    'selection should be limited to the loaded page'
  );
  await frame.evaluate(() => document.querySelector('#libraryClearSelection').click());
  phases.push(
    await measure('open text Quick Look', async () => {
      await frame.locator('#list .tweet').first().press('Space');
      await frame.waitForFunction(() => document.querySelector('#xvQuickLook').open);
    })
  );
  await page.keyboard.press('Escape');
  phases.push(
    await measure('latest of rapid searches', async () => {
      await frame.evaluate(() => {
        const input = document.querySelector('#search');
        for (const query of ['artwork', 'from:artist3', 'from:artist6']) {
          input.value = query;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      await frame.waitForFunction(() => {
        const state = window.XVaultLibraryQueryState?.();
        return (
          state?.loadedFor === state.queryKeyNow &&
          !state.busy &&
          window.XVaultLibraryRows?.().length === 1500 &&
          document.querySelector('#libShown').textContent.endsWith('+')
        );
      });
    })
  );
  await frame.evaluate(() => (window.__indexMessages = []));
  phases.push(
    await measure('favorite one post / update search', async () => {
      await frame.evaluate(() => toggleFavorite('900006'));
      await frame.waitForFunction(
        () =>
          !document.querySelector('#list').hasAttribute('aria-busy') &&
          document.querySelector('.tweet[data-id="900006"]')?.classList.contains('favorite')
      );
    })
  );
  const updates = await frame.evaluate(() => window.__indexMessages);
  assert.deepEqual(updates, [], 'metadata patches should not rebuild a full dashboard search projection');
  assert.ok((await frame.locator('#list .tweet').count()) <= 15);
  const report = {
    records: 50000,
    startup: await frame.evaluate(() => ({ metrics: XVaultLibraryMetrics()[0], longTasks: window.__longTasks })),
    phases,
    legacyProjectionMessages: updates,
    mountedRows: await frame.locator('#list .tweet').count(),
  };
  if (process.argv[4]) {
    await fs.mkdir(process.argv[4], { recursive: true });
    await fs.writeFile(`${process.argv[4]}/profile.json`, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
}
