// Seeds a synthetic archive into the real extension, exercises Library search syntax, and runs the HTML/CSV
// exporters with an in-memory save picker. Screenshots land in output/e2e/.
import { chromium } from 'playwright';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    return page.evaluate(() => document.querySelectorAll('#list [data-id], #list article, #list .card').length);
  };
  const all = await count('');
  check('library renders seeded posts', all > 0, `${all} cards`);
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
    () => document.querySelectorAll('#list [data-id], #list article, #list .card').length
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
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
if (results.some(r => !r.ok)) process.exitCode = 1;
