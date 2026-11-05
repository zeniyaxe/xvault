import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const artifacts = process.argv[4] || path.join(os.tmpdir(), 'xvault-product-pass');
await fs.mkdir(artifacts, { recursive: true });
const browser = await pw.chromium.launch({
  headless: true,
  ...(process.argv[3] ? { executablePath: process.argv[3] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }),
    errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:8765/tests/dashboard-harness.html?demo=1&records=150');
  const frame = page.frames().find(candidate => candidate !== page.mainFrame());
  await frame.locator('.nav[data-page="settings"]').click();
  await frame.locator('#themeGallery .theme-card').first().waitFor();
  assert.equal(await frame.locator('.theme-card').count(), 12);
  const contrast = await frame.evaluate(() => {
    const lum = hex => {
      if (hex.length === 4)
        hex =
          '#' +
          hex
            .slice(1)
            .split('')
            .map(v => v + v)
            .join('');
      const parts = [1, 3, 5]
        .map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
        .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return parts.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    };
    return [...document.querySelectorAll('.theme-card')].map(card => {
      const style = getComputedStyle(card.querySelector('.tc-mini')),
        fg = lum(style.getPropertyValue('--m').trim()),
        bg = lum(style.getPropertyValue('--g').trim());
      return { id: card.dataset.themeId, ratio: (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) };
    });
  });
  assert.ok(
    contrast.every(row => row.ratio >= 4.5),
    `small muted theme text must meet 4.5:1: ${JSON.stringify(contrast)}`
  );
  await frame.locator('[data-theme-id="paper"]').hover();
  await frame.waitForFunction(() => document.body.dataset.theme === 'paper');
  await page.keyboard.press('Escape');
  await frame.waitForFunction(() => document.body.dataset.theme === 'graphite', null, { timeout: 2000 });
  await frame.locator('[data-theme-id="graphite"]').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  try {
    await frame.waitForFunction(() => document.body.dataset.theme === 'midnight', null, { timeout: 3000 });
  } catch (error) {
    console.log(
      await frame.evaluate(() => ({
        theme: document.body.dataset.theme,
        committed: settings.theme,
        focus: document.activeElement.outerHTML.slice(0, 160),
      }))
    );
    throw error;
  }
  await page.keyboard.press('Escape');
  try {
    await frame.waitForFunction(() => document.body.dataset.theme === 'graphite', null, { timeout: 3000 });
  } catch (error) {
    console.log(
      await frame.evaluate(() => ({
        theme: document.body.dataset.theme,
        committed: settings.theme,
        focus: document.activeElement.outerHTML.slice(0, 100),
      }))
    );
    throw error;
  }
  await frame.locator('[data-theme-id="paper"]').click();
  await frame.waitForFunction(() => settings.theme === 'paper');
  await frame.locator('#cmdBtn').hover();
  await frame.waitForFunction(() => document.body.dataset.theme === 'paper');
  await frame.locator('#accentCustom').evaluate(input => {
    input.value = '#e48a4a';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await frame.waitForFunction(
    () => getComputedStyle(document.body).getPropertyValue('--accent-ink').trim() === '#17120a'
  );
  await frame.locator('[data-setting="railWidth"]').selectOption('wide');
  await frame.locator('#workspaceName').fill('Reading desk');
  await frame.locator('#workspaceSave').click();
  await frame.locator('.workspace-row').waitFor();
  await frame.locator('[data-theme-id="oled"]').click();
  await frame.waitForFunction(() => settings.theme === 'oled');
  await frame.locator('.workspace-row [data-workspace-action="apply"]').click();
  await frame.waitForFunction(() => settings.theme === 'paper' && settings.railWidth === 'wide');
  await frame.locator('.workspace-toolbar summary').click();
  await frame.locator('[data-toolbar="inbox"] input').check();
  await frame.locator('#inbox').waitFor({ state: 'visible' });
  assert.ok(await frame.locator('#cmdBtn').isVisible(), 'Command Center remains mandatory');
  await frame.locator('#cmdBtn').click();
  await frame.locator('#paletteInput').fill('Workspace: Reading');
  await frame.locator('#paletteList button').filter({ hasText: 'Workspace: Reading desk' }).click();
  await frame.waitForFunction(() => document.querySelector('#palette').classList.contains('hidden'));
  await frame.evaluate(() => window.XVaultActionRegistry.get('workspaces').run());
  await frame.locator('#workspaceSwitcher').waitFor({ state: 'visible' });
  assert.equal(await frame.locator('#workspaceSwitcherSearch').evaluate(node => node === document.activeElement), true);
  await page.screenshot({ path: path.join(artifacts, 'workspaces-paper-desktop.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await frame.locator('.workspace-actions summary').first().click();
  await frame.locator('[data-workspace-action=startup]').first().click();
  await frame.waitForFunction(() => settings.startupWorkspaceId === settings.workspaces[0].id);
  await page.keyboard.press('Control+Alt+w');
  await frame.locator('#workspaceSwitcherSearch').fill('Reading');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await frame.waitForFunction(() => !document.querySelector('#workspaceSwitcher').open);
  await frame.evaluate(async () => {
    await save({ motionLevel: 'off', libraryView: 'compact' }, false);
    page('library');
    document.querySelector('#search').value = '';
    renderLib();
  });
  await frame.waitForFunction(
    () => window.XVaultLibraryQueryState?.().loaded && !document.querySelector('#list').hasAttribute('aria-busy')
  );
  const cached = await frame.evaluate(() => ({
    key: XVaultLibraryQueryState().loadedFor,
    queries: window.__xvMessageLog.filter(type => type === 'QUERY_LIBRARY_PAGE').length,
  }));
  await frame.evaluate(async () => {
    const id = settings.workspaces[0].id;
    const result = await call({ type: 'UPDATE_WORKSPACE', change: { op: 'apply', id } });
    settings = result.settings;
    apply();
    renderLib();
  });
  assert.equal(
    await frame.evaluate(() => XVaultLibraryQueryState().loadedFor),
    cached.key,
    'presentation restore retains cursor plan'
  );
  assert.equal(
    await frame.evaluate(() => window.__xvMessageLog.filter(type => type === 'QUERY_LIBRARY_PAGE').length),
    cached.queries,
    'presentation restore does not reread Library'
  );
  await frame.evaluate(async () => {
    await save({ libraryView: 'compact' }, false);
    renderLib();
  });
  await frame.locator('#list .tweet [data-details]').first().click();
  await frame.locator('#dNote').waitFor();
  const width = await frame.locator('#detailsDrawer').evaluate(node => Math.round(node.getBoundingClientRect().width));
  await frame.locator('.xv-inspector-resize').focus();
  await page.keyboard.press('ArrowLeft');
  await frame.waitForFunction(expected => settings.inspectorPixels === expected, width + 10);
  await frame.waitForFunction(
    expected => Math.round(document.querySelector('#detailsDrawer').getBoundingClientRect().width) === expected,
    width + 10,
    { timeout: 2000 }
  );
  const resizeBox = await frame.locator('.xv-inspector-resize').boundingBox();
  await frame.locator('.xv-inspector-resize').evaluate(node => {
    window.__resizeEvents = [];
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'lostpointercapture'])
      node.addEventListener(type, event => window.__resizeEvents.push({ type, x: event.clientX }));
  });
  await page.mouse.move(resizeBox.x + 3, resizeBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(resizeBox.x - 37, resizeBox.y + 60);
  await page.mouse.up();
  try {
    await frame.waitForFunction(expected => settings.inspectorPixels === expected, width + 50, { timeout: 2000 });
  } catch (error) {
    console.log(
      await frame.evaluate(() => ({
        events: window.__resizeEvents,
        width: settings.inspectorPixels,
        rect: document.querySelector('#detailsDrawer').getBoundingClientRect().width,
        overlay: document.querySelector('#detailsDrawer').dataset.overlay,
      }))
    );
    throw error;
  }
  await frame.locator('#drawerClose').click();
  await frame.locator('.nav[data-page="settings"]').click();
  await frame.locator('[data-section-link="appearance"]').click();
  await frame.locator('#settingsContent').evaluate(node => (node.scrollTop = 0));
  const toolbarTop = await frame.locator('.top').evaluate(node => Math.round(node.getBoundingClientRect().top));
  if (toolbarTop !== 0)
    console.log(
      await frame.evaluate(() => {
        const rows = [];
        for (let node = document.querySelector('.top'); node; node = node.parentElement)
          rows.push({
            tag: node.tagName,
            class: node.className,
            top: node.scrollTop,
            height: node.clientHeight,
            scrollHeight: node.scrollHeight,
            overflow: getComputedStyle(node).overflow,
            rect: node.getBoundingClientRect().top,
          });
        return rows;
      })
    );
  assert.equal(toolbarTop, 0, 'scrolling nested Settings must not scroll the app toolbar off screen');
  await page.screenshot({ path: path.join(artifacts, 'appearance-paper-desktop.png'), animations: 'disabled' });
  await frame.evaluate(async () => {
    await save({ theme: 'oled' }, false);
  });
  await frame.locator('#settingsContent').evaluate(node => (node.scrollTop = 0));
  await page.screenshot({ path: path.join(artifacts, 'appearance-oled-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await frame.waitForFunction(
    () => innerWidth === 390 && Math.round(document.querySelector('.rail').getBoundingClientRect().width) === 56
  );
  const narrow = await frame.evaluate(() => ({
    rail: document.querySelector('.rail').getBoundingClientRect().width,
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.equal(narrow.rail, 56);
  assert.ok(narrow.width <= narrow.viewport, 'custom widths must not overflow a narrow screen');
  await page.screenshot({ path: path.join(artifacts, 'appearance-oled-390.png'), animations: 'disabled' });
  await page.keyboard.press('Control+Alt+w');
  await frame.locator('#workspaceSwitcher').waitFor({ state: 'visible' });
  assert.ok(
    await frame.locator('#workspaceSwitcher').evaluate(node => node.getBoundingClientRect().right <= innerWidth)
  );
  await page.screenshot({ path: path.join(artifacts, 'workspaces-390.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  for (const zoom of [2, 3, 4]) {
    await frame.evaluate(async zoom => {
      await save({ dashboardScale: zoom }, false);
      window.XVaultOpenWorkspaceSwitcher();
    }, zoom);
    const bounds = await frame.locator('#workspaceSwitcher').evaluate(node => ({
      right: node.getBoundingClientRect().right,
      left: node.getBoundingClientRect().left,
      height: node.getBoundingClientRect().height,
      overflow: node.scrollWidth - node.clientWidth,
      width: innerWidth,
      available: innerHeight,
    }));
    if (bounds.overflow > 1)
      console.log(
        await frame.locator('#workspaceSwitcher').evaluate(node =>
          [...node.querySelectorAll('*')]
            .filter(child => child.scrollWidth > child.clientWidth + 1)
            .map(child => ({
              tag: child.tagName,
              id: child.id,
              width: getComputedStyle(child).width,
              min: getComputedStyle(child).minWidth,
              grid: getComputedStyle(child).gridTemplateColumns,
              white: getComputedStyle(child).whiteSpace,
              scroll: child.scrollWidth,
              client: child.clientWidth,
            }))
        )
      );
    assert.ok(
      bounds.left >= 0 && bounds.right <= bounds.width && bounds.height <= bounds.available && bounds.overflow <= 1,
      'workspace switcher fits ' + zoom * 100 + '% scale: ' + JSON.stringify(bounds)
    );
    await page.screenshot({
      path: path.join(artifacts, 'workspace-scale-' + zoom * 100 + '.png'),
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');
  }
  await frame.evaluate(() => save({ dashboardScale: 1 }, false));
  await frame.evaluate(async () => {
    await save({ motionLevel: 'normal' }, false);
    const node = document.querySelector('#settingsContent');
    for (let i = 0; i < 8; i++)
      window.XVaultMotion.play(node, [{ transform: 'translateX(12px)' }, { transform: 'none' }], 600);
  });
  assert.ok(
    (await frame.locator('#settingsContent').evaluate(node => node.getAnimations().length)) <= 1,
    'rapid actions replace their previous animation'
  );
  await frame.evaluate(async () => {
    await save({ motionLevel: 'normal', motionSpeed: 2 }, false);
  });
  assert.ok(
    await frame
      .locator('.theme-card')
      .first()
      .evaluate(node =>
        getComputedStyle(node)
          .transitionDuration.split(',')
          .some(value => Math.abs(parseFloat(value) - 0.055) < 0.005)
      ),
    'the speed control must scale CSS interaction motion as well as pane animations'
  );
  for (const level of ['off', 'reduced']) {
    await frame.evaluate(async level => {
      await save({ motionLevel: level }, false);
      window.XVaultMotion.play(document.querySelector('#settingsContent'), [
        { transform: 'translateX(20px)' },
        { transform: 'none' },
      ]);
    }, level);
    assert.equal(await frame.locator('#settingsContent').evaluate(node => node.getAnimations().length), 0);
  }
  await frame.locator('[data-theme-id="graphite"]').hover();
  assert.equal(
    await frame.locator('[data-theme-id="graphite"]').evaluate(node => getComputedStyle(node).transform),
    'none',
    'calm modes remove hover displacement rather than making it jump instantly'
  );
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await frame.evaluate(async () => {
    await save({ motionLevel: 'rich' }, false);
    window.XVaultMotion.play(document.querySelector('#settingsContent'), [{ opacity: 0 }, { opacity: 1 }]);
  });
  assert.equal(await frame.locator('#settingsContent').evaluate(node => node.getAnimations().length), 0);
  await frame.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.__decisionFail = false;
    chrome.runtime.sendMessage = message =>
      message.type === 'GET_DOWNLOAD_DECISIONS'
        ? Promise.resolve(
            window.__decisionFail
              ? { ok: false, error: 'Simulated service unavailable' }
              : {
                  ok: true,
                  rows: [
                    {
                      at: Date.now(),
                      code: 'new',
                      outcome: 'queued',
                      source: 'Library',
                      installationId: 'a'.repeat(32),
                      browserPresence: 'complete',
                      tweetId: '42',
                      asset: 'img:Forest',
                      reason: 'New media',
                    },
                    {
                      at: Date.now(),
                      code: 'already-downloaded',
                      outcome: 'skipped',
                      source: 'X',
                      tweetId: '43',
                      asset: 'img:Door',
                      reason: 'Already saved',
                    },
                  ],
                }
          )
        : send(message);
    page('media');
  });
  await frame.locator('#downloadDecisions summary').click();
  await frame.locator('#decisionList .decision').first().waitFor();
  assert.equal(await frame.locator('#decisionList .decision').count(), 2);
  await frame.locator('#decisionSearch').fill('Forest');
  assert.equal(await frame.locator('#decisionList .decision').count(), 1);
  await frame.evaluate(() => (window.__decisionFail = true));
  await frame.locator('#decisionsRefresh').click();
  await frame.waitForFunction(() =>
    document.querySelector('#decisionState').textContent.includes('Simulated service unavailable')
  );
  assert.equal(
    await frame.locator('#decisionList .decision').count(),
    1,
    'failed refresh retains the filtered evidence'
  );
  await frame.locator('#decisionState').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'download-decisions-390.png'), animations: 'disabled' });
  assert.deepEqual(errors, []);
  console.log(
    `PASS theme hover/Escape, keyboard preview, custom accent contrast, workspace restore/Command Center, toolbar, Inspector resizing, narrow layout and authoritative motion · ${JSON.stringify({ narrow, artifacts })}`
  );
} finally {
  await browser.close();
}
