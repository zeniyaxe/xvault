// UI gallery: loads the real extension, seeds a varied synthetic archive (threads, quotes, link cards, polls,
// 0–4 media at real aspect ratios, tags, favorites, notes) and screenshots every major surface at several
// viewports and themes. Used for visual review and before/after comparisons; not part of CI.
//   CHROMIUM_PATH=... node scripts/ui-gallery.mjs [--out=output/gallery] [--only=library,remote] [--themes=graphite,paper]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';

const root = new URL('..', import.meta.url).pathname;
const arg = (name, fallback) => process.argv.find(item => item.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const out = resolve(root, arg('out', 'output/gallery'));
const only = new Set(String(arg('only', '')).split(',').filter(Boolean));
const themes = String(arg('themes', 'graphite')).split(',');
const want = name => !only.size || only.has(name);
mkdirSync(out, { recursive: true });

function hash(text) {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}
function hsl(h, s, l) {
  const k = n => (n + h / 30) % 12,
    a = s * Math.min(l, 1 - l),
    f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map(v => Math.round(v * 255));
}
// A soft "photo": diagonal two-hue gradient, a glowing disc and a darker horizon band.
function photo(width, height, seed) {
  const h1 = seed % 360,
    h2 = (h1 + 40 + (seed % 90)) % 360,
    c1 = hsl(h1, 0.55, 0.42),
    c2 = hsl(h2, 0.6, 0.62),
    sun = hsl((h1 + 180) % 360, 0.7, 0.78);
  const cx = width * (0.25 + ((seed >> 3) % 50) / 100),
    cy = height * (0.25 + ((seed >> 5) % 30) / 100),
    radius = Math.min(width, height) * 0.18,
    horizon = height * (0.62 + ((seed >> 7) % 20) / 100);
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const t = (x / width + y / height) / 2;
      let px = c1.map((v, i) => v + (c2[i] - v) * t);
      const d = Math.hypot(x - cx, y - cy);
      if (d < radius * 2.4) {
        const g = d < radius ? 1 : Math.max(0, 1 - (d - radius) / (radius * 1.4)) ** 2 * 0.6;
        px = px.map((v, i) => v + (sun[i] - v) * g);
      }
      if (y > horizon) px = px.map(v => v * (0.55 + 0.25 * Math.sin((x / width) * 6 + seed)));
      row.set(
        px.map(v => Math.max(0, Math.min(255, Math.round(v)))),
        1 + x * 3
      );
    }
    rows.push(row);
  }
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
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const imageCache = new Map();
function imageFor(url) {
  if (imageCache.has(url)) return imageCache.get(url);
  const size = url.match(/_(\d+)x(\d+)/),
    width = size ? Math.min(640, Number(size[1])) : 320,
    height = size ? Math.min(640, Number(size[2])) : 320;
  const body = photo(width, height, hash(url));
  imageCache.set(url, body);
  return body;
}

export const AUTHORS = [
  { handle: 'nasa', name: 'NASA', verified: true, avatar: true },
  { handle: 'natgeo', name: 'National Geographic', verified: true, avatar: true },
  { handle: 'artist_jo', name: 'Jo Park', avatar: true },
  { handle: 'dev_kim', name: 'Kim Devlin' },
  { handle: 'photo_lee', name: 'Lee Okafor', avatar: true },
  { handle: 'mara_writes', name: 'Mara Ellison' },
  { handle: 'studio_fern', name: 'Studio Fern', avatar: true },
  {
    handle: 'averyveryLongHan',
    name: 'Bartholomew Featherstonehaugh-Montgomery of the Northern Archive Society',
    avatar: true,
    brokenAvatar: true,
  },
  { handle: 'q', name: 'Q' },
];
const TEXTS = [
  'Sunset over the bay tonight. The fog rolled in just as the light went gold.',
  'New telescope images just dropped — the detail in the outer spiral arms is unreal.',
  'Sketch of the week: a quiet street corner in the rain, ink and a little watercolor.',
  'Shipping a release today. Faster search, a calmer inbox, and the export bug is finally gone.',
  'Street photography from this morning’s market. Everyone was too busy to notice the camera.',
  'Cats being cats.',
  'Mountain trail at dawn. 5 km in, nobody else around, the whole valley glowing.',
  'Thread on how we rebuilt the media pipeline: what broke, what we measured, and what we would do differently. 1/',
  'Reading list for the weekend — three essays on attention, craft and slow software.',
  'Quick tip: hold Shift while dragging to keep the aspect ratio. Saves me every single day.',
  'A long one. We spent six months interviewing people who archive things obsessively — bookmarks, screenshots, entire timelines. The pattern that kept coming up was not hoarding; it was trust. People keep copies because platforms forget, links rot and accounts disappear. The tools that earned trust were boring in the best way: predictable, local, and honest about what they did not have.',
  'Golden hour, again.',
  'https://example.com/a/really/long/link/that/should/wrap/instead/of/forcing/horizontal/scrolling/on/small/screens?utm_source=xvault&utm_medium=archive',
  'Reply-guy energy: honestly the second photo is the better one, and I will not be taking questions at this time.',
];
const RATIOS = [
  [640, 360],
  [480, 600],
  [500, 500],
  [600, 400],
  [450, 600],
  [640, 400],
];
export function seedPosts(count = 72) {
  const base = 1800000000000000000n;
  const posts = [];
  for (let i = 0; i < count; i++) {
    const author = AUTHORS[i % AUTHORS.length];
    const id = String(base + BigInt(i));
    const mediaCount = [1, 0, 2, 1, 4, 1, 3, 0, 1, 2, 0, 1][i % 12];
    const media = Array.from({ length: mediaCount }, (_, m) => {
      const [w, h] = RATIOS[(i + m) % RATIOS.length];
      const video = i % 5 === 0 && m === 0;
      return video
        ? {
            type: 'video',
            url: `https://pbs.twimg.com/ext_tw_video_thumb/${i}/pu/img/V${i}_${w}x${h}.jpg`,
            preview: `https://pbs.twimg.com/ext_tw_video_thumb/${i}/pu/img/V${i}_${w}x${h}.jpg`,
            playbackUrl: `https://video.twimg.com/ext_tw_video/${i}/pu/vid/avc1/${w}x${h}/v.mp4`,
            width: w * 3,
            height: h * 3,
            durationMs: 14000 + i * 900,
          }
        : {
            type: 'photo',
            url: `https://pbs.twimg.com/media/SEED${i}_${m}_${w}x${h}.jpg`,
            width: w * 3,
            height: h * 3,
          };
    });
    const post = {
      id,
      text: TEXTS[i % TEXTS.length] + (i % 3 === 0 ? ` #${['space', 'photography', 'design', 'release'][i % 4]}` : ''),
      url: `https://x.com/${author.handle}/status/${id}`,
      createdAt: new Date(Date.UTC(2025, i % 12, 1 + (i % 27), 9 + (i % 11), (i * 7) % 60)).toISOString(),
      author: {
        handle: author.handle,
        name: author.name,
        verified: !!author.verified,
        ...(author.avatar ? { avatar: `https://pbs.twimg.com/profile_images/${author.handle}_96x96.jpg` } : {}),
      },
      metrics: {
        likes: (i * 1371) % 48000,
        reposts: (i * 91) % 4200,
        replies: (i * 37) % 900,
        views: (i * 48211) % 2400000,
        bookmarks: (i * 13) % 700,
      },
      media,
      sources: [i % 2 ? 'bookmarks' : 'likes'],
      sourceFlags: [i % 2 ? 'bookmarks' : 'likes'],
      language: 'en',
      conversationId: id,
    };
    if (i % 9 === 4) {
      post.replyToId = String(base + BigInt(i - 1));
      post.replyToHandle = AUTHORS[(i - 1) % AUTHORS.length].handle;
      post.conversationId = String(base + BigInt(i - 1));
    }
    if (i % 8 === 7 && i < count - 1) {
      post.text = 'Thread 2/ The first thing we changed was how files are named, so nothing is ever overwritten.';
      post.replyToId = String(base + BigInt(i - 1));
      post.replyToHandle = author.handle;
    }
    if (i % 7 === 3 && i > 2) post.quotedPostId = String(base + BigInt(i - 2));
    // A few longer threads and repeatedly quoted posts, so Atlas "Threads and quotes" has something to draw.
    if (i > 23 && i % 23 >= 1 && i % 23 <= 4 + (i % 3)) {
      post.conversationId = String(base + BigInt(i - (i % 23)));
      post.replyToId = String(base + BigInt(i - 1));
      post.replyToHandle = AUTHORS[(i - 1) % AUTHORS.length].handle;
    }
    if (i % 13 === 6 && i > 12) post.quotedPostId = String(base + BigInt(12 + (((i / 13) | 0) % 3)));
    if (i % 31 === 9) post.quotedPostId = '1790000000000000001';
    if (i % 10 === 8) {
      post.links = ['https://example.com/essays/slow-software'];
      post.card = {
        name: 'summary_large_image',
        url: 'https://example.com/essays/slow-software',
        title: 'Slow software: why the best tools feel calm',
        description: 'Notes on predictability, local-first storage and interfaces that respect attention.',
        domain: 'example.com',
        image: { url: `https://pbs.twimg.com/card_img/${i}/CARD_${i}_640x335.jpg`, width: 640, height: 335 },
      };
    }
    if (i === 11)
      post.poll = {
        choices: [
          { label: 'Grid', count: 412 },
          { label: 'Timeline', count: 655 },
          { label: 'Table', count: 98 },
        ],
        totalVotes: 1165,
        final: true,
      };
    // Realistic edge cases for layout review: sensitive media, a missing (404) file, multi-image, and a broken avatar.
    if (i % 13 === 6) post.sensitive = true;
    if (i % 17 === 9 && media.length)
      media[media.length - 1].url = media[media.length - 1].url.replace('/media/', '/media/MISSING');
    if (author.brokenAvatar)
      post.author.avatar = `https://pbs.twimg.com/profile_images/MISSING_${author.handle}_96x96.jpg`;
    posts.push(post);
  }
  return posts;
}

async function seed(page) {
  const posts = seedPosts(Number(arg('count', '96')));
  const stored = await page.evaluate(
    tweets => chrome.runtime.sendMessage({ type: 'STORE_RECORDS', tweets, users: [] }),
    posts
  );
  if (!stored?.ok) throw new Error(`seed failed ${JSON.stringify(stored).slice(0, 200)}`);
  const ids = posts.map(post => post.id);
  const patch = (list, value) =>
    page.evaluate(
      ([idList, p]) => chrome.runtime.sendMessage({ type: 'BULK_UPDATE_TWEET_META', ids: idList, patch: p }),
      [list, value]
    );
  await patch(
    ids.filter((_, i) => i % 4 === 1),
    { favorite: true }
  );
  await patch(
    ids.filter((_, i) => i % 3 === 0),
    { addTags: ['inspiration'] }
  );
  await patch(
    ids.filter((_, i) => i % 5 === 2),
    { addTags: ['reference', 'color'] }
  );
  await patch(
    ids.filter((_, i) => i % 6 === 5),
    { readLater: true }
  );
  await patch(
    ids.filter((_, i) => i % 11 === 3),
    { noteAppend: 'Use this framing for the spring campaign deck.' }
  );
  return posts;
}

// The eight review sizes: large desktop, MacBook, common laptop, small laptop, iPad landscape and portrait, phone, narrow phone.
const VIEWPORTS = {
  wide: { width: 1920, height: 1080 },
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1366, height: 768 },
  small: { width: 1280, height: 720 },
  tablet: { width: 1024, height: 768 },
  portrait: { width: 768, height: 1024 },
  phone: { width: 390, height: 844 },
  narrow: { width: 320, height: 700 },
};

async function main() {
  const profile = join(tmpdir(), `xvault-gallery-${Date.now()}`);
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.CHROMIUM_PATH ? undefined : 'chromium',
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--no-sandbox'],
    viewport: VIEWPORTS.desktop,
    deviceScaleFactor: Number(arg('scale', '1')),
  });
  await context.route('https://pbs.twimg.com/**', route =>
    /MISSING/.test(route.request().url())
      ? route.fulfill({ status: 404, body: '' })
      : route.fulfill({ status: 200, contentType: 'image/png', body: imageFor(route.request().url()) })
  );
  await context.route('https://video.twimg.com/**', route => route.abort());
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/dashboard.html`);
  await page.waitForTimeout(700);
  await seed(page);
  await page.evaluate(() => localStorage.setItem('xv-nav', ''));
  const shots = [];
  const shot = async name => {
    const path = join(out, `${name}.png`);
    await page.screenshot({ path });
    shots.push(path);
  };
  const ready = async () => {
    await page.reload();
    await page.waitForTimeout(1300);
    const dismiss = page.locator('text=Start using XVault');
    if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
    await page.waitForTimeout(500);
  };
  const go = async name => {
    await page.evaluate(target => document.querySelector(`.rail [data-page="${target}"]`)?.click(), name);
    await page.waitForTimeout(700);
  };
  const layout = async name => {
    await page.evaluate(target => document.querySelector(`#libraryLayout [data-layout="${target}"]`)?.click(), name);
    await page.waitForTimeout(900);
  };
  for (const theme of themes) {
    await page.evaluate(t => chrome.runtime.sendMessage({ type: 'SET_SETTINGS', settings: { theme: t } }), theme);
    for (const [label, viewport] of Object.entries(VIEWPORTS)) {
      if (arg('viewports') && !arg('viewports').split(',').includes(label)) continue;
      await page.setViewportSize(viewport);
      await ready();
      const tag = `${theme}-${label}`;
      if (want('library')) {
        const everywhere = ['cards', 'timeline', 'gallery'],
          extra = ['wide', 'desktop', 'phone'].includes(label) ? ['masonry', 'compact', 'table'] : [];
        for (const name of [...everywhere, ...extra]) {
          await layout(name);
          await shot(`library-${name}-${tag}`);
        }
        // Scroll the library to its end: shows how paging / load-more sits relative to the last posts.
        await layout('cards');
        await page.evaluate(() => {
          const scrollers = [...document.querySelectorAll('*')].filter(
            el => el.scrollHeight > el.clientHeight + 40 && /auto|scroll/.test(getComputedStyle(el).overflowY)
          );
          for (const el of scrollers) el.scrollTop = el.scrollHeight;
          window.scrollTo(0, document.documentElement.scrollHeight);
        });
        await page.waitForTimeout(900);
        await shot(`library-end-${tag}`);
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0;
          window.scrollTo(0, 0);
        });
      }
      if (want('inspector') && label !== 'phone') {
        await page.locator('#list [data-details]').first().click();
        await page.waitForTimeout(600);
        await shot(`library-inspector-${tag}`);
        await page.keyboard.press('Escape');
        await page
          .locator('#drawerClose')
          .click({ timeout: 1000 })
          .catch(() => {});
      }
      if (want('selection')) {
        await page.evaluate(() => {
          const boxes = [...document.querySelectorAll('#list .xv-card-select input')].slice(0, 3);
          for (const box of boxes) box.click();
        });
        await page.waitForTimeout(500);
        await shot(`library-selection-${tag}`);
        await page.keyboard.press('Escape');
      }
      if (want('search')) {
        await page.fill('#search', 'from:nasa has:image likes:>500');
        await page.press('#search', 'Enter');
        await page.waitForTimeout(1000);
        await shot(`library-search-${tag}`);
        await page.evaluate(() => window.XVaultLibraryRunQuery?.(''));
        await page.waitForTimeout(600);
      }
      if (want('pages')) {
        for (const name of ['atlas', 'explorer', 'home', 'media', 'studio', 'health', 'settings']) {
          await go(name);
          await shot(`page-${name}-${tag}`);
          if (name === 'atlas') {
            const threads = page.locator('#xaThreads');
            if (await threads.count()) {
              await threads.scrollIntoViewIfNeeded();
              await page.waitForTimeout(400);
              await threads.screenshot({ path: join(out, `atlas-threads-${tag}.png`) });
              shots.push(`atlas-threads-${tag}`);
            }
          }
        }
        await go('library');
      }
      if (want('palette')) {
        await page.keyboard.press('Control+k');
        await page.waitForTimeout(500);
        await shot(`palette-${tag}`);
        await page.keyboard.press('Escape');
      }
    }
  }
  if (want('sidepanel')) {
    await page.setViewportSize({ width: 400, height: 860 });
    await page.goto(`chrome-extension://${id}/sidepanel.html`);
    await page.waitForTimeout(1000);
    await shot('sidepanel');
  }
  console.log(JSON.stringify({ shots: shots.length, out, errors: [...new Set(errors)].slice(0, 10) }, null, 2));
  await context.close();
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
