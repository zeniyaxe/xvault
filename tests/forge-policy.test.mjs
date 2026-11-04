// XVault 21 "Forge": settings normalisation, quality/repair/gap/check selection, watch-list scheduling
// and download policy (video quality, hold window, bandwidth cap, host health, duplicates, re-verify).
import assert from 'node:assert/strict';
import {
  FORGE_DEFAULTS,
  normalizeForgeSettings,
  sanitizeWatchLists,
  sanitizeCapturePresets,
  insideWindow,
  msUntilWindow,
  minutesOf,
  parseVideoQualityRules,
} from '../sw/forge-settings.mjs';
import {
  qualityReport,
  repairCandidates,
  gapCandidates,
  threadGaps,
  checkCandidates,
  changeSummary,
} from '../sw/forge-candidates.mjs';
import { dueLists, matchesList, watchUrl } from '../sw/watch-lists.mjs';
import {
  pickVariant,
  applyVideoQuality,
  variantHeight,
  holdReason,
  createBandwidthGovernor,
  hostHealth,
  duplicateReport,
  integrityDue,
} from '../sw/download-policy.mjs';

const DAY = 86400000;

// ── Settings ──
{
  const out = normalizeForgeSettings({
    ...FORGE_DEFAULTS,
    searchHybridWeight: 7,
    searchHistoryLimit: 3,
    videoQuality: '4k',
    downloadWindowStart: '25:00',
    downloadMaxMBps: -1,
    integrityScheduleDays: 400,
    availabilityScope: 'everything',
    quoteChainDepth: 9,
    capturePresets: [
      { name: 'Mine', source: 'profile', handle: '@Alice_1', mirror: 1 },
      { source: 'profile', handle: 'not a handle!' },
      { source: 'spaces' },
      { id: 'same', source: 'likes' },
      { id: 'same', source: 'bookmarks' },
    ],
    watchLists: [
      { kind: 'author', value: '@Bob' },
      { kind: 'author', value: 'bad handle' },
      { kind: 'search', value: 'from:nasa', everyHours: 0 },
    ],
  });
  assert.equal(out.searchHybridWeight, 1);
  assert.equal(out.searchHistoryLimit, 10);
  assert.equal(out.videoQuality, 'highest');
  assert.equal(out.downloadWindowStart, '01:00');
  assert.equal(out.downloadMaxMBps, 0);
  assert.equal(out.integrityScheduleDays, 90);
  assert.equal(out.availabilityScope, 'favorites');
  assert.equal(out.quoteChainDepth, 5);
  assert.deepEqual(
    out.capturePresets.map(({ name, source, handle, mirror, resume }) => ({ name, source, handle, mirror, resume })),
    [
      { name: 'Mine', source: 'profile', handle: 'alice_1', mirror: true, resume: true },
      { name: 'likes', source: 'likes', handle: '', mirror: false, resume: true },
    ]
  );
  assert.deepEqual(
    out.watchLists.map(list => [list.kind, list.value, list.everyHours]),
    [
      ['author', 'bob', 24],
      ['search', 'from:nasa', 1],
    ]
  );
  assert.equal(sanitizeCapturePresets('x').length, 0);
  assert.equal(
    sanitizeWatchLists(Array.from({ length: 60 }, (_, i) => ({ kind: 'search', value: `q${i}` }))).length,
    40
  );
}
{
  assert.equal(minutesOf('07:30'), 450);
  const at = (h, m = 0) => new Date(2026, 0, 5, h, m).getTime();
  assert.equal(insideWindow(at(2), '01:00', '07:00'), true);
  assert.equal(insideWindow(at(8), '01:00', '07:00'), false);
  assert.equal(insideWindow(at(23), '22:00', '06:00'), true, 'windows wrap past midnight');
  assert.equal(insideWindow(at(5), '22:00', '06:00'), true);
  assert.equal(insideWindow(at(12), '22:00', '06:00'), false);
  assert.equal(insideWindow(at(12), '05:00', '05:00'), true, 'an empty window means always');
  assert.equal(msUntilWindow(at(20), '22:00', '06:00'), 2 * 3600000);
  assert.equal(msUntilWindow(at(23), '22:00', '06:00'), 0);
}

// ── Quality, repair, gaps, checks, changes ──
const complete = {
  id: '10',
  text: 'hello',
  createdAt: '2026-01-01T00:00:00Z',
  author: { handle: 'a', name: 'A', avatar: 'x' },
  metrics: { likes: 1, reposts: 0, replies: 0 },
  conversationId: '10',
  language: 'en',
};
const bare = { id: '11', text: '' };
{
  const report = qualityReport([complete, bare]);
  assert.equal(report.total, 2);
  assert.equal(report.incomplete, 1);
  assert.equal(
    report.buckets.reduce((a, b) => a + b, 0),
    2
  );
  assert.ok(report.reasons.author >= 1 && report.reasons.text >= 1);
  const now = Date.now();
  const repair = repairCandidates(
    [
      complete,
      bare,
      { ...bare, id: '12', repairAttemptAt: now - DAY },
      { ...bare, id: '13', availability: { state: 'deleted' } },
      { id: 'x' },
    ],
    { now }
  );
  assert.deepEqual(
    repair.map(entry => entry.id),
    ['11'],
    'recently tried, gone and invalid posts are skipped'
  );
}
{
  const posts = [
    { id: '1', conversationId: '1' },
    { id: '2', conversationId: '1', replyToId: '1' },
    { id: '3', conversationId: '1', replyToId: '50' },
    { id: '4', conversationId: '1', replyToId: '50', quotedPostId: '60' },
    { id: '5', conversationId: '70', replyToId: '70', quotedPostId: '50' },
  ];
  const gaps = gapCandidates(posts);
  assert.deepEqual(gaps.list, [
    { id: '50', kind: 'parent', needed: 2 },
    { id: '70', kind: 'parent', needed: 1 },
    { id: '60', kind: 'quote', needed: 1 },
  ]);
  assert.equal(gaps.quotes, 2, 'quote 50 is counted but listed once, as a parent');
  assert.deepEqual(
    gapCandidates(posts, undefined, { include: ['quotes'] }).list.map(entry => entry.id),
    ['50', '60']
  );
  const threads = threadGaps(posts);
  assert.deepEqual(
    threads.map(thread => [thread.conversationId, thread.posts, thread.missing.sort()]),
    [
      ['1', 4, ['50']],
      ['70', 1, ['70']],
    ]
  );
}
{
  const now = Date.now();
  const posts = [
    { id: '1', userMeta: { favorite: true } },
    { id: '2', userMeta: { favorite: true }, availability: { checkedAt: now - DAY } },
    { id: '3', userMeta: { colorLabel: 'red' }, availability: { checkedAt: now - 90 * DAY } },
    { id: '4', userMeta: {} },
  ];
  assert.deepEqual(
    checkCandidates(posts, { now }).map(entry => entry.id),
    ['1']
  );
  assert.deepEqual(
    checkCandidates(posts, { now, scope: 'favorites-labeled' }).map(entry => entry.id),
    ['1', '3']
  );
  assert.deepEqual(
    checkCandidates(posts, { now, scope: 'all' }).map(entry => entry.id),
    ['1', '4', '3']
  );
  const changes = changeSummary([
    { id: '1', textRevisionCount: 2, revisionCount: 3 },
    { id: '2', edit: { edited: true } },
    { id: '3', availability: { state: 'deleted', checkedAt: 5 }, author: { handle: 'z' }, text: 'gone' },
    { id: '4', availability: { state: 'suspended', checkedAt: 9 } },
    { id: '5', availability: { state: 'available', checkedAt: 1 } },
  ]);
  assert.deepEqual(
    {
      edited: changes.edited,
      revisions: changes.revisions,
      deleted: changes.deleted,
      unavailable: changes.unavailable,
      checked: changes.checked,
    },
    { edited: 2, revisions: 3, deleted: 1, unavailable: 1, checked: 3 }
  );
  assert.deepEqual(
    changes.recent.map(row => row.id),
    ['4', '3'],
    'most recently noticed first'
  );
}

// ── Watch lists ──
{
  const now = Date.UTC(2026, 2, 1, 12);
  const settings = {
    watchDailyCap: 2,
    watchLists: [
      { id: 'a', kind: 'author', value: 'alice', everyHours: 24 },
      { id: 'b', kind: 'search', value: 'cats', everyHours: 6 },
      { id: 'c', kind: 'author', value: 'carol', everyHours: 1, enabled: false },
      { id: 'd', kind: 'author', value: 'dan', everyHours: 1 },
    ],
  };
  const state = {
    lists: { a: { lastRunAt: now - 3600000 }, b: { lastRunAt: now - 7 * 3600000 }, d: { lastRunAt: 0 } },
    usage: {},
  };
  assert.deepEqual(
    dueLists(settings, state, now).map(list => list.id),
    ['d', 'b'],
    'due, enabled, least recent first, capped'
  );
  assert.deepEqual(dueLists(settings, { ...state, usage: { '2026-03-01': 2 } }, now), [], 'daily cap reached');
  assert.equal(watchUrl({ kind: 'author', value: 'alice' }), 'https://x.com/alice');
  assert.equal(watchUrl({ kind: 'search', value: 'a b' }), 'https://x.com/search?q=a%20b&src=typed_query&f=live');
  assert.equal(matchesList({ kind: 'author', value: 'Alice' }, { author: { handle: '@alice' } }), true);
  assert.equal(
    matchesList({ kind: 'search', value: 'cats' }, { text: 'cats' }, (post, query) => post.text.includes(query)),
    true
  );
}

// ── Video quality ──
{
  const variants = [
    { url: 'https://video.twimg.com/v/1/pl/a.m3u8', contentType: 'application/x-mpegURL' },
    { url: 'https://video.twimg.com/v/1/vid/480x852/a.mp4', contentType: 'video/mp4', bitrate: 950000 },
    { url: 'https://video.twimg.com/v/1/vid/720x1280/a.mp4', contentType: 'video/mp4', bitrate: 2176000 },
    { url: 'https://video.twimg.com/v/1/vid/1080x1920/a.mp4', contentType: 'video/mp4', bitrate: 10368000 },
  ];
  assert.equal(variantHeight(variants[2]), 720, 'the shorter side, so portrait videos compare fairly');
  assert.match(pickVariant(variants, 'highest').url, /1080x1920/);
  assert.match(pickVariant(variants, '720').url, /720x1280/);
  assert.match(pickVariant(variants, '480').url, /480x852/);
  assert.match(pickVariant(variants.slice(3), '480').url, /1080x1920/, 'falls back to the smallest available');
  assert.equal(pickVariant([variants[0]], '720'), null, 'HLS playlists are never chosen');
  const items = [
    { url: variants[3].url, sourceMediaType: 'video', mediaId: 'm1' },
    { url: 'https://pbs.twimg.com/media/a.jpg', sourceMediaType: 'photo' },
    { url: variants[3].url, sourceMediaType: 'video', quality: 'original' },
  ];
  const out = applyVideoQuality(items, () => ({ variants }), '720');
  assert.match(out[0].url, /720x1280/);
  assert.equal(out[0].mediaId, 'm1');
  assert.equal(out[0].variantHeight, 720);
  assert.equal(out[1], items[1]);
  assert.equal(out[2], items[2], 'an explicit original request is kept');
  assert.equal(
    applyVideoQuality(items, () => ({ variants }), 'highest'),
    items
  );
}

// ── Holds and bandwidth ──
{
  const night = new Date(2026, 0, 5, 12).getTime();
  const settings = {
    downloadWindowEnabled: true,
    downloadWindowStart: '22:00',
    downloadWindowEnd: '06:00',
    downloadRespectSaveData: true,
  };
  const hold = holdReason(settings, night, null);
  assert.equal(hold.code, 'window');
  assert.equal(hold.retryInMs, 10 * 3600000);
  assert.equal(holdReason({ ...settings, downloadWindowEnabled: false }, night, { saveData: true }).code, 'save-data');
  assert.equal(
    holdReason({ ...settings, downloadWindowEnabled: false, downloadRespectSaveData: false }, night, {
      saveData: true,
    }),
    null
  );
  assert.equal(holdReason({ ...settings, downloadWindowEnabled: false }, night, { type: 'cellular' }).code, 'cellular');
  assert.equal(
    holdReason({ ...settings, downloadWindowEnabled: false }, night, { type: 'wifi', effectiveType: '2g' }).code,
    'slow'
  );
  assert.equal(
    holdReason({ ...settings, downloadWindowEnabled: false }, night, { type: 'wifi', effectiveType: '4g' }),
    null
  );
  assert.equal(
    holdReason({ ...settings, downloadWindowEnabled: false, downloadRespectSaveData: false }, night, {
      type: 'cellular',
    }),
    null
  );

  let clock = 0,
    received = 0;
  const pausedIds = [],
    resumed = [];
  const chromeApi = {
    downloads: {
      search: async () => [{ bytesReceived: received }],
      pause: async id => pausedIds.push(id),
      resume: async id => resumed.push(id),
    },
  };
  const governor = createBandwidthGovernor({ chromeApi, activeIds: () => [7], getCap: () => 1, now: () => clock });
  assert.equal((await governor.sample()).capped, false, 'first sample only measures');
  clock = 1000;
  received = 4 * 1048576; // 4 MB/s against a 1 MB/s cap
  const capped = await governor.sample();
  assert.equal(capped.capped, true);
  assert.equal(capped.pauseMs, 3000);
  assert.deepEqual(pausedIds, [7]);
  assert.equal(governor.isPausedByCap(7), true);
  clock = 2000;
  assert.equal((await governor.sample()).capped, true, 'still inside the pause');
  clock = 4500;
  await governor.sample();
  assert.deepEqual(resumed, [7], 'resumed after the pause');
  assert.equal(governor.isPausedByCap(7), false);
  const off = createBandwidthGovernor({ chromeApi, activeIds: () => [7], getCap: () => 0, now: () => clock });
  assert.deepEqual(await off.sample(), { capped: false, rate: 0 });
}

// ── Host health, duplicates, re-verify schedule ──
{
  const now = Date.now();
  const rows = [
    ...Array.from({ length: 9 }, (_, i) => ({
      state: 'complete',
      item: { url: 'https://video.twimg.com/a.mp4' },
      totalBytes: 2 * 1048576,
      history: [
        { to: 'downloading', at: 1000 },
        { to: 'complete', at: 3000 },
      ],
      attempts: i === 0 ? 3 : 1,
    })),
    {
      state: 'failed',
      item: { url: 'https://video.twimg.com/b.mp4' },
      failureReason: 'NETWORK_FAILED',
      updatedAt: now,
    },
    { state: 'retry-wait', item: { url: 'https://video.twimg.com/c.mp4' } },
    { state: 'failed', item: { url: 'https://pbs.twimg.com/a.jpg' }, error: 'SERVER_FORBIDDEN', updatedAt: now },
  ];
  const [video, photo] = hostHealth(rows, { now });
  assert.equal(video.host, 'video.twimg.com');
  assert.equal(video.successRate, 90);
  assert.equal(video.queued, 1);
  assert.equal(video.retries, 2);
  assert.equal(video.avgMBps, 1);
  assert.equal(video.status, 'fair');
  assert.deepEqual(video.topReasons, [{ reason: 'NETWORK_FAILED', count: 1 }]);
  assert.equal(photo.status, 'poor');

  const report = duplicateReport(
    [
      {
        key: 'k1',
        state: 'complete',
        downloadId: 1,
        sha256: 'aa',
        totalBytes: 10,
        updatedAt: 5,
        target: { filename: 'x/1.jpg' },
      },
      {
        key: 'k2',
        state: 'complete',
        downloadId: 2,
        sha256: 'aa',
        totalBytes: 10,
        updatedAt: 1,
        verification: { state: 'verified' },
      },
      { key: 'k3', state: 'complete', downloadId: 3, sha256: 'aa', totalBytes: 10, updatedAt: 9, reclaimedAt: 99 },
      { key: 'k4', state: 'complete', downloadId: 4, totalBytes: 20, item: { mediaId: 'm' } },
      { key: 'k5', state: 'complete', downloadId: 5, totalBytes: 20, item: { mediaId: 'm' } },
      { key: 'k6', state: 'complete', downloadId: 6, sha256: 'bb', totalBytes: 30, verification: { state: 'missing' } },
      { key: 'k7', state: 'complete', downloadId: 7, sha256: 'bb', totalBytes: 30 },
    ],
    { assetOf: row => row.item?.mediaId || '' }
  );
  assert.equal(report.files, 2);
  assert.equal(report.reclaimable, 30);
  const sha = report.groups.find(group => group.key === 'sha:aa');
  assert.equal(sha.keep.key, 'k2', 'the verified copy is kept');
  assert.deepEqual(
    sha.remove.map(row => row.key),
    ['k1'],
    'reclaimed rows are not offered again'
  );
  assert.equal(report.groups.find(group => group.key.startsWith('asset:')).confidence, 'same media and size');
  assert.ok(!report.groups.some(group => group.key === 'sha:bb'), 'missing files are not duplicates');

  assert.equal(integrityDue({ integrityScheduleDays: 0 }, 0, now), false);
  assert.equal(integrityDue({ integrityScheduleDays: 7 }, now - 8 * DAY, now), true);
  assert.equal(integrityDue({ integrityScheduleDays: 7 }, now - DAY, now), false);
}
{
  // Per-rule video quality.
  const parsed = parseVideoQualityRules(
    '# comment\nsource:likes => 720\nfrom:nasa has:video -> best\n\ntag:x => 9000\n=> 720\nnot a rule\ntag:ref → 1080p'
  );
  assert.deepEqual(
    parsed.rules.map(rule => [rule.query, rule.quality, rule.line]),
    [
      ['source:likes', '720', 2],
      ['from:nasa has:video', 'highest', 3],
      ['tag:ref', '1080', 8],
    ]
  );
  assert.deepEqual(
    parsed.issues.map(issue => issue.line),
    [5, 6, 7]
  );
  assert.match(parsed.issues[0].message, /Unknown quality "9000"/);
  assert.deepEqual(parseVideoQualityRules(''), { rules: [], issues: [] });
  assert.equal(parseVideoQualityRules(Array.from({ length: 50 }, () => 'a => 720').join('\n')).rules.length, 30);
  assert.equal(normalizeForgeSettings({ videoQualityRules: 'x'.repeat(5000) }).videoQualityRules.length, 4000);
  assert.equal(normalizeForgeSettings({}).videoQualityRules, '');
}
console.log(
  'Forge policy: settings, candidates, watch lists, video quality, holds, bandwidth, hosts, duplicates passed'
);
