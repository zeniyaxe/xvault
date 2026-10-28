// Loads the unpacked extension in real Chromium (MV3), opens every extension page at several viewport
// sizes, records console/page errors and saves screenshots to output/e2e/.
// Usage: node scripts/e2e-extension.mjs   (requires `playwright`; set CHROMIUM_PATH to use a system Chromium)
import { chromium } from 'playwright';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'output', 'e2e');
mkdirSync(out, { recursive: true });
const profile = join(tmpdir(), `xvault-e2e-${Date.now()}`);
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
});
const failures = [];
try {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  console.log('Service worker running:', worker.url());
  const pages = (process.env.E2E_PAGES || 'dashboard.html,sidepanel.html').split(',');
  const sizes = [
    ['desktop', 1440, 900],
    ['laptop', 1180, 760],
    ['tablet', 820, 1100],
    ['phone', 390, 844],
  ];
  for (const file of pages) {
    for (const [label, width, height] of sizes) {
      if (file === 'sidepanel.html' && label !== 'phone') continue;
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
      page.on('console', m => m.type() === 'error' && errors.push(`console: ${m.text()}`));
      await page.setViewportSize({ width, height });
      await page.goto(`chrome-extension://${id}/${file}`, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      if (overflow > 2) errors.push(`horizontal overflow ${overflow}px`);
      await page.screenshot({ path: join(out, `${file.replace('.html', '')}-${label}.png`) });
      for (const route of (process.env.E2E_ROUTES || '').split(',').filter(Boolean)) {
        if (file !== 'dashboard.html' || label !== 'desktop') continue;
        await page.evaluate(r => (location.hash = r), route);
        await page.waitForTimeout(900);
        await page.screenshot({ path: join(out, `route-${route.replace(/\W+/g, '_')}.png`) });
      }
      console.log(`${file} @ ${label}: ${errors.length ? errors.length + ' problem(s)' : 'ok'}`);
      errors.forEach(e => console.log('   ', e.slice(0, 300)));
      if (errors.length) failures.push(...errors.map(e => `${file}@${label} ${e}`));
      await page.close();
    }
  }
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
if (failures.length) process.exitCode = 1;
