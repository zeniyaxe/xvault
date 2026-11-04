// Accessibility audit: loads the unpacked extension in Chromium, seeds a small archive, then runs axe-core
// (WCAG 2.1 A/AA rules) on every dashboard page, the Atlas views, the Reader, the search suggestions, the
// Command Center and the side panel. Serious and critical violations fail the run; moderate/minor ones
// are reported. Also checks keyboard focus visibility and that reduced motion is honoured.
// Usage: node scripts/e2e-a11y.mjs   (requires `playwright` and `axe-core`; CHROMIUM_PATH for a system Chromium)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'output', 'a11y');
mkdirSync(out, { recursive: true });
const profile = join(tmpdir(), `xvault-a11y-${Date.now()}`);
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
});
const BLOCKING = new Set(['serious', 'critical']);
const report = [];
const failures = [];

async function audit(page, label, include = null) {
  await page.evaluate(axeSource);
  const result = await page.evaluate(async selector => {
    const target = selector ? document.querySelector(selector) : document;
    if (!target) return { missing: true, violations: [] };
    return window.axe.run(target, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] },
      resultTypes: ['violations'],
      rules: {
        // The dashboard is a single document with one <h1>; page sections are app panels, not documents.
        'page-has-heading-one': { enabled: false },
        region: { enabled: false },
      },
    });
  }, include);
  if (result.missing) {
    failures.push(`${label}: ${include} not found`);
    return;
  }
  for (const violation of result.violations) {
    const nodes = violation.nodes.map(node => node.target.join(' ')).slice(0, 6);
    const summary = String(violation.nodes[0]?.failureSummary || '')
      .split('\n')
      .slice(1, 2)
      .join(' ')
      .trim();
    const entry = { label, id: violation.id, impact: violation.impact, help: violation.help, nodes, summary };
    report.push(entry);
    if (BLOCKING.has(violation.impact))
      failures.push(`${label}: [${violation.impact}] ${violation.id} — ${nodes[0]}${summary ? ` (${summary})` : ''}`);
  }
  const blocking = result.violations.filter(violation => BLOCKING.has(violation.impact)).length;
  console.log(`${label}: ${result.violations.length} issue(s), ${blocking} blocking`);
}

try {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.waitForTimeout(800);
  const authors = ['nasa', 'artist_jo', 'dev_kim'];
  const tweets = Array.from({ length: 24 }, (_, i) => ({
    id: String(1800000000000000000n + BigInt(i)),
    text: `Accessible archive post ${i} #a11y`,
    url: `https://x.com/${authors[i % 3]}/status/${1800000000000000000n + BigInt(i)}`,
    createdAt: new Date(Date.UTC(2025, i % 12, 1 + (i % 27))).toISOString(),
    author: { handle: authors[i % 3], name: authors[i % 3].replace('_', ' ') },
    metrics: { likes: i * 10, reposts: i, replies: i, views: i * 100 },
    media: i % 3 ? [{ type: 'photo', url: `https://pbs.twimg.com/media/A11Y${i}.jpg` }] : [],
    sources: ['bookmarks'],
  }));
  await page.evaluate(t => chrome.runtime.sendMessage({ type: 'STORE_RECORDS', tweets: t, users: [] }), tweets);
  await page.reload();
  await page.waitForTimeout(1500);
  const dismiss = page.locator('text=Start using XVault');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();

  const pages = (
    process.env.A11Y_PAGES ||
    'home,library,atlas,explorer,archive,sessions,media,studio,health,integrity,activity,settings'
  ).split(',');
  for (const name of pages) {
    await page.evaluate(target => window.page(target), name);
    await page.waitForTimeout(900);
    await audit(page, `dashboard:${name}`, `#page-${name}`);
  }
  // App chrome (rail, top bar) once.
  await audit(page, 'dashboard:shell', '.rail, nav, header');

  // Atlas sub-views.
  for (const view of ['calendar', 'people', 'duplicates']) {
    await page.evaluate(target => window.XVaultAtlas?.open(target), view);
    await page.waitForTimeout(900);
    await audit(page, `atlas:${view}`, '#page-atlas');
  }

  // Search suggestions open.
  await page.evaluate(() => window.page('library'));
  await page.waitForTimeout(800);
  await page.click('#search');
  await page.keyboard.type('fro');
  await page.waitForTimeout(400);
  await audit(page, 'search suggestions', '#xvSearchAssist');
  await page.keyboard.press('Escape');

  // Reader.
  const card = page.locator('#list .tweet').first();
  if (await card.count()) {
    await card.focus();
    await page.keyboard.press('t');
    await page.waitForSelector('dialog.xv-reader[open]', { timeout: 4000 }).catch(() => {});
    if (await page.locator('dialog.xv-reader[open]').count()) {
      await page.waitForTimeout(500);
      await audit(page, 'reader', 'dialog.xv-reader[open]');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const restored = await page.evaluate(() => document.activeElement?.closest?.('.tweet') != null);
      if (!restored) failures.push('reader: focus not returned to the post after closing');
    } else failures.push('reader: did not open from a focused post');
  }

  // Command Center.
  await page.evaluate(() => window.openPalette());
  await page.waitForTimeout(300);
  await audit(page, 'command center', '#palette');
  await page.keyboard.press('Escape');

  // Keyboard focus must be visible: Tab a few times and check each focused control draws an outline/ring.
  await page.evaluate(() => window.page('library'));
  await page.evaluate(() => document.activeElement?.blur());
  const invisible = [];
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      // Range inputs draw their ring on the thumb (::-webkit-slider-thumb), which computed style can't see.
      if (el.matches('input[type=range]')) return { ring: true };
      const style = getComputedStyle(el);
      const ring =
        (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) ||
        (style.boxShadow && style.boxShadow !== 'none');
      return { ring, name: el.id || el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName };
    });
    if (info && !info.ring) invisible.push(info.name);
  }
  if (invisible.length) failures.push(`focus ring missing on: ${[...new Set(invisible)].join(', ')}`);
  console.log(`focus visibility: ${invisible.length ? invisible.length + ' without a ring' : 'ok'}`);

  // Reduced motion: the OS preference must switch the dashboard to its reduced motion level.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.reload();
  await page.waitForTimeout(1200);
  const motion = await page.evaluate(() => ({
    level: document.documentElement.dataset.motion || document.body.dataset.motion || '',
    duration: getComputedStyle(document.querySelector('.page.show') || document.body).transitionDuration,
  }));
  if (!/reduce/.test(motion.level)) failures.push(`reduced motion not applied (${JSON.stringify(motion)})`);
  console.log(`reduced motion: ${JSON.stringify(motion)}`);

  // Side panel.
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 390, height: 844 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.waitForTimeout(1200);
  await audit(panel, 'sidepanel');
  await panel.close();

  if (errors.length) failures.push(...errors.map(error => `page error: ${error}`));
  await page.close();
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
writeFileSync(join(out, 'axe-report.json'), JSON.stringify(report, null, 2));
const minor = report.filter(entry => !BLOCKING.has(entry.impact));
if (minor.length) {
  console.log(`\n${minor.length} non-blocking issue(s):`);
  for (const entry of minor) console.log(`  ${entry.label}: [${entry.impact}] ${entry.id} — ${entry.nodes[0]}`);
}
if (failures.length) {
  console.error(`\nAccessibility audit failed (${failures.length}):`);
  failures.forEach(failure => console.error('  ', failure.slice(0, 300)));
  process.exit(1);
}
console.log('\nAccessibility audit passed: no serious or critical violations.');
