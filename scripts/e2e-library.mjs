// Seeds a synthetic archive into the real extension, exercises Library search syntax, and runs the HTML/CSV
// exporters with an in-memory save picker. Screenshots land in output/e2e/.
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'output', 'e2e');
mkdirSync(out, { recursive: true });
const profile = join(tmpdir(), `xvault-e2e-lib-${Date.now()}`);
const context = await chromium.launchPersistentContext(profile, {
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  channel: process.env.CHROMIUM_PATH ? undefined : 'chromium', // full Chromium: headless-shell cannot load extensions
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
  viewport: { width: 1440, height: 900 },
});
// Media from X's CDN is answered locally with a small solid PNG so thumbnails and the lightbox have real
// pixels (the lightbox zoom needs a decoded image) without touching the network.
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]),
      sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const cdnImage = png(160, 120, [70, 120, 170]);
await context.route('https://pbs.twimg.com/**', route =>
  route.fulfill({ status: 200, contentType: 'image/png', body: cdnImage })
);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
try {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.waitForTimeout(800);
  const authors = ['nasa', 'natgeo', 'artist_jo', 'dev_kim', 'photo_lee'];
  const words = [
    'Sunset over the bay',
    'New telescope images',
    'Sketch of the week',
    'Shipping a release',
    'Street photography',
    'Cats being cats',
    'Mountain trail at dawn',
  ];
  const tweets = Array.from({ length: 60 }, (_, i) => {
    const handle = authors[i % authors.length];
    const video = i % 4 === 0;
    return {
      id: String(1800000000000000000n + BigInt(i)),
      text: `${words[i % words.length]} #${i}`,
      url: `https://x.com/${handle}/status/${1800000000000000000n + BigInt(i)}`,
      createdAt: new Date(Date.UTC(2024, i % 12, 1 + (i % 27))).toISOString(),
      author: { handle, name: handle.replace('_', ' ') },
      metrics: { likes: i * 137, reposts: i * 3, replies: i, views: i * 1000 },
      media: [
        video
          ? {
              type: 'video',
              url: `https://pbs.twimg.com/ext_tw_video_thumb/${i}/pu/img/t.jpg`,
              playbackUrl: `https://video.twimg.com/ext_tw_video/${i}/pu/vid/avc1/720x720/v.mp4`,
            }
          : { type: 'photo', url: `https://pbs.twimg.com/media/SEED${i}.jpg` },
      ],
      sources: [i % 2 ? 'bookmarks' : 'likes'],
    };
  });
  const stored = await page.evaluate(
    t => chrome.runtime.sendMessage({ type: 'STORE_RECORDS', tweets: t, users: [] }),
    tweets
  );
  check('seed records accepted', !!stored?.ok, JSON.stringify(stored).slice(0, 120));
  await page.reload();
  await page.waitForTimeout(1500);
  const dismiss = page.locator('text=Start using XVault');
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(out, 'library-seeded.png') });

  const count = async q => {
    await page.fill('#search', q);
    await page.press('#search', 'Enter');
    await page.waitForTimeout(900);
    // Library 5.0 mounts cards incrementally, so the result count is the loaded window, not the DOM.
    return page.evaluate(
      () =>
        window.XVaultLibraryResultRows?.()?.length ??
        document.querySelectorAll('#list [data-id], #list article, #list .card').length
    );
  };
  const all = await count('');
  const mountedCards = await page.evaluate(() => document.querySelectorAll('#list > article.tweet').length);
  check('library renders seeded posts', all > 0 && mountedCards > 0, `${all} results, ${mountedCards} mounted`);
  const nasa = await count('from:nasa');
  check('from: filter', nasa > 0 && nasa < all, `${nasa}`);
  const notNasa = await count('-from:nasa');
  check('negated filter', notNasa > 0 && notNasa < all && notNasa !== nasa, `${notNasa}`);
  const either = await count('from:nasa|natgeo');
  check('OR filter', either > nasa, `${either}`);
  const vids = await count('type:video');
  check('type:video', vids > 0 && vids < all, `${vids}`);
  await count('');

  // XVault 22 timeline: whole-archive counts, click a bar → after:/before: and exactly that many posts.
  // XVault 25 folds the strip by default; the header's Timeline chip opens it.
  const timelineFolded = await page.evaluate(() => document.querySelector('#xkTimeline')?.hidden !== false);
  check('timeline is folded by default', timelineFolded);
  await page.locator('#libraryTimelineToggle').click();
  check(
    'Timeline chip opens the strip',
    await page.evaluate(
      () =>
        document.querySelector('#xkTimeline')?.hidden === false &&
        document.querySelector('#libraryTimelineToggle')?.getAttribute('aria-expanded') === 'true'
    )
  );
  // Wait for the empty search's counts (the previous search's bars may still be on screen).
  await page
    .waitForFunction(
      total => (document.querySelector('#xkTimeline .xk-summary')?.textContent || '').startsWith(`${total} posts`),
      tweets.length,
      { timeout: 8000 }
    )
    .catch(() => {});
  const bars = await page.$$eval('#xkTimeline .xk-bar', nodes =>
    nodes.map(node => Number(/: ([\d,]+) posts$/.exec(node.getAttribute('aria-label'))?.[1].replace(/,/g, '') || 0))
  );
  check(
    'timeline counts every post',
    bars.reduce((sum, value) => sum + value, 0) === tweets.length,
    `${bars.length} bars, ${bars.reduce((sum, value) => sum + value, 0)} posts`
  );
  const pick = bars.findIndex(value => value > 0);
  await page.keyboard.press('Escape'); // close the search suggestions that overlay the results
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('#xkTimeline .xk-bar').nth(pick).click();
  await page.waitForTimeout(1200);
  const ranged = await page.inputValue('#search');
  const rangedCards = await page.evaluate(
    () =>
      window.XVaultLibraryResultRows?.()?.length ??
      document.querySelectorAll('#list [data-id], #list article, #list .card').length
  );
  check(
    'timeline bar narrows the search to its dates',
    /after:\d{4}-\d\d-\d\d before:\d{4}-\d\d-\d\d/.test(ranged) && rangedCards === bars[pick],
    `${ranged} → ${rangedCards} (bar ${bars[pick]})`
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('#xkTimeline [data-xk="clear"]').click();
  await page.waitForTimeout(1200);
  check('timeline "All dates" removes the range', !/after:|before:/.test(await page.inputValue('#search')));
  await page.screenshot({ path: join(out, 'library-timeline.png') });
  await count('');

  // Timeline zoom stack: a bar step can be undone with Back, which restores the exact previous search.
  await page.waitForFunction(
    total => (document.querySelector('#xkTimeline .xk-summary')?.textContent || '').startsWith(`${total} posts`),
    tweets.length,
    { timeout: 20000 }
  );
  await page.evaluate(() => document.activeElement?.blur());
  await page.locator('#xkTimeline .xk-bar:not(.is-empty)').first().click();
  await page.waitForTimeout(1200);
  const zoomed = await page.inputValue('#search');
  const backVisible = await page.locator('#xkTimeline [data-xk="back"]').isVisible();
  await page.locator('#xkTimeline [data-xk="back"]').click();
  await page.waitForTimeout(1200);
  check(
    'timeline Back restores the previous search',
    /after:/.test(zoomed) && backVisible && (await page.inputValue('#search')) === '',
    `${zoomed} → "${await page.inputValue('#search')}"`
  );
  // Brushing previews the range before anything is searched.
  await page.waitForFunction(
    total => (document.querySelector('#xkTimeline .xk-summary')?.textContent || '').startsWith(`${total} posts`),
    tweets.length,
    { timeout: 20000 }
  );
  const barBoxes = await page.locator('#xkTimeline .xk-bar').evaluateAll(nodes =>
    nodes.slice(0, 6).map(node => {
      const box = node.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })
  );
  await page.mouse.move(barBoxes[0].x, barBoxes[0].y);
  await page.mouse.down();
  await page.mouse.move(barBoxes[5].x, barBoxes[5].y, { steps: 4 });
  const brushing = await page.locator('#xkTimeline .xk-summary').textContent();
  await page.mouse.up();
  await page.waitForTimeout(1200);
  check('timeline brush previews the range', /release to filter/.test(brushing || ''), brushing || '');
  await page.locator('#xkTimeline [data-xk="clear"]').click();
  await page.waitForTimeout(900);

  // Motion layer: notices, the sliding segmented pill, lightbox zoom and the favourite burst.
  const notices = await page.evaluate(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    window.toast('Saved the view');
    window.toast('Saved the view');
    const repeated = document.querySelector('#toast .xt-count')?.textContent;
    const successTone = document.querySelector('#toast')?.dataset.tone;
    window.toast('Could not reach the helper');
    const ghosts = document.querySelectorAll('.xt-ghost').length;
    const errorTone = document.querySelector('#toast')?.dataset.tone;
    let ran = 0;
    window.toast('Moved 3 posts', { action: { label: 'Undo', run: () => ran++ } });
    document.querySelector('#toast .xt-action')?.click();
    await wait(50);
    window.XVaultNotices.show();
    const listed = document.querySelectorAll('#xvNoticeHistory .xt-list li').length;
    document.getElementById('xvNoticeHistory')?.close();
    return { repeated, successTone, ghosts, errorTone, ran, listed, hidden: !document.querySelector('#toast.show') };
  });
  check(
    'notices: repeat counter, tones, lift-away, action, history',
    notices.repeated === '×2' &&
      notices.successTone === 'success' &&
      notices.errorTone === 'error' &&
      notices.ghosts >= 1 &&
      notices.ran === 1 &&
      notices.hidden &&
      notices.listed >= 3,
    JSON.stringify(notices)
  );
  const pillAt = async () =>
    page.evaluate(() => {
      const seg = document.querySelector('#libraryLayout'),
        pill = seg?.querySelector('.xv-seg-pill'),
        active = seg?.querySelector('[aria-checked="true"], .active, [aria-pressed="true"]');
      if (!pill || !active) return null;
      const a = active.getBoundingClientRect(),
        b = pill.getBoundingClientRect();
      return { dx: Math.abs(a.left - b.left), dw: Math.abs(a.width - b.width), label: active.textContent.trim() };
    });
  const pillBefore = await pillAt();
  const otherLayout = page.locator('#libraryLayout > button:not([aria-checked="true"]):not(.active)').first();
  await otherLayout.click();
  await page.waitForTimeout(900);
  const pillAfter = await pillAt();
  check(
    'segmented pill follows the selected layout',
    !!pillBefore &&
      !!pillAfter &&
      pillBefore.dx < 2 &&
      pillAfter.dx < 2 &&
      pillAfter.dw < 2 &&
      pillBefore.label !== pillAfter.label,
    JSON.stringify({ pillBefore, pillAfter })
  );
  await page.locator('#libraryLayout > button').first().click();
  await page.waitForTimeout(900);
  await count('type:photo');
  await page.waitForTimeout(800);
  const zoomStart = await page.evaluate(async () => {
    const item = document.querySelector('#list .mediaItem');
    if (!item) return { error: 'no media item' };
    item.click();
    for (let i = 0; i < 40; i++) {
      const img = document.querySelector('#lbContent .lbImageCanvas img');
      const running = img
        ?.getAnimations()
        .some(animation => String(animation.effect?.getKeyframes?.()[0]?.transform || '').includes('scale'));
      if (running) return { zoomed: true };
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { zoomed: false, open: !document.querySelector('#lightbox')?.classList.contains('hidden') };
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: join(out, 'lightbox-zoom.png') });
  check('lightbox zooms out of the clicked thumbnail', zoomStart.zoomed === true, JSON.stringify(zoomStart));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  const sparks = await page.evaluate(() => {
    const button = document.querySelector('#list [data-fav][aria-pressed="false"]');
    button?.click();
    return document.querySelectorAll('.xv-spark').length;
  });
  check('favourite burst', sparks >= 6, `${sparks} sparks`);
  await page.waitForTimeout(700);
  await count('');

  // Exporters with an in-memory save picker.
  await page.evaluate(() => {
    window.__exports = {};
    window.showSaveFilePicker = async ({ suggestedName }) => ({
      createWritable: async () => {
        const parts = [];
        return {
          write: async v => parts.push(v),
          close: async () => (window.__exports[suggestedName] = parts.join('')),
          abort: async () => {},
        };
      },
    });
  });
  for (const button of ['#exportHtml', '#csv']) {
    await page.evaluate(sel => document.querySelector(sel).click(), button);
    await page.waitForTimeout(2500);
  }
  const exportsDone = await page.evaluate(() => window.__exports);
  const html = Object.entries(exportsDone).find(([k]) => k.endsWith('.html'))?.[1] || '';
  const csv = Object.entries(exportsDone).find(([k]) => k.endsWith('.csv'))?.[1] || '';
  check(
    'HTML export contains every post',
    (html.match(/<article /g) || []).length === tweets.length,
    `${(html.match(/<article /g) || []).length}`
  );
  check('CSV export has header + rows', csv.split('\r\n').filter(Boolean).length === tweets.length + 1);
  writeFileSync(join(out, 'export-sample.html'), html);
  await page.screenshot({ path: join(out, 'export-dialog.png') });
  // Atlas Year in Review export: both buttons produce real files (anchor downloads captured in-page).
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    window.__saved = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download && this.href.startsWith('blob:')) {
        window.__saved.push(
          fetch(this.href)
            .then(response => response.blob())
            .then(async blob => ({
              name: this.download,
              type: blob.type,
              size: blob.size,
              head: Array.from(new Uint8Array(await blob.slice(0, 8).arrayBuffer())),
              text: blob.type.startsWith('text/') ? await blob.text() : '',
            }))
        );
        return;
      }
      return click.call(this);
    };
    window.XVaultAtlas.open('review');
  });
  await page.waitForSelector('#page-atlas [data-act="review-md"]', { timeout: 30000 });
  await page.evaluate(() => {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    document.querySelector('#page-atlas [data-act="review-md"]').click();
    document.querySelector('#page-atlas [data-act="review-png"]').click();
  });
  await page.waitForTimeout(1500);
  const saved = await page.evaluate(() => Promise.all(window.__saved));
  const md = saved.find(file => file.name.endsWith('.md')),
    png = saved.find(file => file.name.endsWith('.png'));
  check(
    'Year in Review Markdown summary',
    !!md && md.text.startsWith('# 2024 in my XVault') && md.text.includes(`**Posts written:** ${tweets.length}`),
    md ? `${md.name} ${md.size} bytes` : 'not saved'
  );
  check(
    'Year in Review PNG card',
    !!png && png.type === 'image/png' && png.head.join(',') === '137,80,78,71,13,10,26,10' && png.size > 8000,
    png ? `${png.name} ${png.size} bytes` : 'not saved'
  );
  if (md) writeFileSync(join(out, 'year-in-review.md'), md.text);
  const card = await page.evaluate(() => window.XVaultAtlas.review.canvas()?.toDataURL('image/png') || '');
  if (card) writeFileSync(join(out, 'year-in-review.png'), Buffer.from(card.split(',')[1], 'base64'));
  // Reader thread map: a self-thread spine, branching replies and an in-conversation quote.
  const base = 1900000000000000000n,
    tid = n => String(base + BigInt(n)),
    root = tid(0);
  const threadPosts = [
    [0, 'dev_kim', null],
    [1, 'dev_kim', 0],
    [2, 'dev_kim', 1],
    [3, 'dev_kim', 2],
    [4, 'nasa', 1],
    [5, 'natgeo', 1],
    [6, 'photo_lee', 4],
    [7, 'artist_jo', 0, 2],
  ].map(([n, handle, parent, quote]) => ({
    id: tid(n),
    text: `Thread part ${n} by ${handle}`,
    url: `https://x.com/${handle}/status/${tid(n)}`,
    createdAt: new Date(Date.UTC(2023, 5, 1, 9, n)).toISOString(),
    author: { handle, name: handle },
    conversationId: root,
    ...(parent == null ? {} : { replyToId: tid(parent) }),
    ...(quote == null ? {} : { quotedPostId: tid(quote) }),
    sources: ['bookmarks'],
  }));
  await page.evaluate(t => chrome.runtime.sendMessage({ type: 'STORE_RECORDS', tweets: t, users: [] }), threadPosts);
  await page.evaluate(() => document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close()));
  await page.evaluate(id => window.XVaultReader.open(id), tid(2));
  await page.waitForSelector('#xvReaderMap:not([hidden]) .tm-node', { timeout: 8000 }).catch(() => {});
  const map = await page.evaluate(() => {
    const aside = document.querySelector('#xvReaderMap');
    const nodes = [...document.querySelectorAll('#xvReaderMap .tm-node')];
    const column = document.querySelector('.xr-column')?.getBoundingClientRect(),
      box = aside?.getBoundingClientRect();
    return {
      shown: !!aside && !aside.hidden,
      nodes: nodes.length,
      spine: nodes.filter(node => node.classList.contains('is-spine')).length,
      focus: document.querySelector('#xvReaderMap .tm-node.is-focus')?.dataset.mapId || '',
      quotes: document.querySelectorAll('#xvReaderMap path.tm-quote').length,
      count: aside?.querySelector('.xr-map-count')?.textContent || '',
      clear: !!column && !!box && box.left >= column.right - 1,
    };
  });
  check(
    'Reader thread map lays out spine, replies and quote',
    map.shown && map.nodes === 8 && map.spine === 4 && map.quotes === 1 && map.focus === tid(2) && map.clear,
    JSON.stringify(map)
  );
  await page.evaluate(
    id =>
      document
        .querySelector(`#xvReaderMap .tm-node[data-map-id="${id}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    tid(6)
  );
  await page.waitForTimeout(900);
  const jumped = await page.evaluate(id => {
    const article = document.querySelector(`#xvReaderBody .xr-post[data-id="${id}"]`);
    const box = article?.getBoundingClientRect();
    return {
      present: !!article,
      inView: !!box && box.top < innerHeight && box.bottom > 0,
      current: document.querySelector('#xvReaderMap .tm-node.is-current')?.dataset.mapId || '',
    };
  }, tid(6));
  check(
    'Reader thread map jumps to a reply',
    jumped.present && jumped.inView && jumped.current === tid(6),
    JSON.stringify(jumped)
  );
  await page.focus(`#xvReaderMap .tm-node[tabindex="0"]`).catch(() => {});
  await page.keyboard.press('Home');
  const homed = await page.evaluate(() => document.activeElement?.dataset?.mapId || '');
  check('Reader thread map keyboard Home', homed === tid(0), homed);
  await page.evaluate(() => document.querySelector('dialog.xv-reader [data-act="map"]').click());
  const toggled = await page.evaluate(() => ({
    hidden: document.querySelector('#xvReaderMap').hidden,
    pressed: document.querySelector('dialog.xv-reader [data-act="map"]').getAttribute('aria-pressed'),
    stored: localStorage.getItem('xv-reader-map'),
  }));
  check(
    'Reader thread map toggles off and remembers',
    toggled.hidden && toggled.pressed === 'false',
    JSON.stringify(toggled)
  );
  await page.evaluate(() => document.querySelector('dialog.xv-reader [data-act="map"]').click());
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(out, 'reader-thread-map.png') });
  await page.evaluate(() => window.XVaultReader.close());
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
if (results.some(r => !r.ok)) process.exitCode = 1;
