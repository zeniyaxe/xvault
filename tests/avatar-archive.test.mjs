// XVault 25: locally archived avatars — URL normalisation, magic-byte checks, bounded fetches, failure memory and
// on-demand lookups for the phone, against an in-memory store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAX_AVATAR_BYTES,
  avatarCandidates,
  avatarSource,
  createAvatarArchive,
  sniffImage,
} from '../sw/avatar-archive.mjs';

const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 1]);
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    get: async key => rows.get(key),
    put: async row => void rows.set(row.handle, structuredClone(row)),
    clear: async () => rows.clear(),
    count: async () => rows.size,
    bytes: async () => [...rows.values()].reduce((sum, row) => sum + (row.size || 0), 0),
  };
}
function response(bytes, { status = 200, length = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => (name === 'content-length' && length !== null ? String(length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test('only pbs.twimg.com profile images are accepted and normalised to the 96 px variant', () => {
  assert.equal(
    avatarSource('https://pbs.twimg.com/profile_images/123/abc_normal.jpg?x=1#y'),
    'https://pbs.twimg.com/profile_images/123/abc_x96.jpg'
  );
  assert.equal(
    avatarSource('https://pbs.twimg.com/profile_images/9/pic_400x400.png'),
    'https://pbs.twimg.com/profile_images/9/pic_x96.png'
  );
  assert.equal(
    avatarSource('https://pbs.twimg.com/default_profile_images/default_profile_normal.png'),
    'https://pbs.twimg.com/default_profile_images/default_profile_x96.png'
  );
  for (const bad of [
    'http://pbs.twimg.com/profile_images/1/a_normal.jpg',
    'https://evil.example/profile_images/1/a_normal.jpg',
    'https://pbs.twimg.com/media/abc.jpg',
    'https://pbs.twimg.com:8443/profile_images/1/a.jpg',
    'javascript:alert(1)',
    '',
  ])
    assert.equal(avatarSource(bad), '', bad);
});

test('magic bytes decide the image type', () => {
  assert.equal(sniffImage(JPEG), 'image/jpeg');
  assert.equal(sniffImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 13, 10])), 'image/png');
  assert.equal(sniffImage(new TextEncoder().encode('<svg onload=alert(1)>')), '');
});

test('candidates are unique per lower-cased handle and include quoted authors', () => {
  const avatar = 'https://pbs.twimg.com/profile_images/1/a_normal.jpg';
  const list = avatarCandidates([
    { author: { handle: 'Ada', avatar } },
    { author: { handle: 'ada', avatar } },
    { author: { handle: 'bad handle!', avatar } },
    { author: { handle: 'Bob', avatar: 'https://evil.example/x.jpg' }, quoted: { author: { handle: 'Cy', avatar } } },
  ]);
  assert.deepEqual(
    list.map(row => row.handle),
    ['ada', 'cy']
  );
});

test('remembered avatars are fetched without credentials, stored, and not refetched while fresh', async () => {
  const store = memoryStore();
  const calls = [];
  const archive = createAvatarArchive({
    store,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response(JPEG);
    },
  });
  await archive.remember([{ handle: 'Ada', url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' }]);
  for (let i = 0; i < 5 && archive.pending(); i++) await tick();
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].url, 'https://pbs.twimg.com/profile_images/1/a_x96.jpg');
  assert.equal(store.rows.get('ada').mime, 'image/jpeg');
  await archive.remember([{ handle: 'ada', url: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg' }]);
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(calls.length, 1, 'a fresh stored avatar is not downloaded again');
  const encoded = await archive.readEncoded('ADA');
  assert.equal(encoded.ok, true);
  assert.deepEqual([...Buffer.from(encoded.data, 'base64')], [...JPEG]);
  const stats = await archive.stats();
  assert.equal(stats.count, 1);
  assert.equal(stats.bytes, JPEG.byteLength);
});

test('oversized, non-image and failed responses are refused and remembered as failures', async () => {
  const store = memoryStore();
  const answers = {
    big: response(JPEG, { length: MAX_AVATAR_BYTES + 1 }),
    html: response(new TextEncoder().encode('<html>')),
    gone: response(JPEG, { status: 404 }),
  };
  const archive = createAvatarArchive({ store, fetchImpl: async url => answers[url.split('/')[4]] });
  await archive.remember(
    Object.keys(answers).map(name => ({ handle: name, url: `https://pbs.twimg.com/profile_images/${name}/a.jpg` }))
  );
  for (let i = 0; i < 10 && archive.pending(); i++) await tick();
  await tick();
  assert.match(store.rows.get('big').error, /256 KB/);
  assert.match(store.rows.get('html').error, /not a JPEG/);
  assert.match(store.rows.get('gone').error, /404/);
  for (const name of Object.keys(answers)) assert.equal(store.rows.get(name).data, undefined);
  assert.equal((await archive.readEncoded('gone')).ok, false, 'a recent failure is not retried in a loop');
});

test('the phone can ask for an author that was archived before avatars were kept', async () => {
  const store = memoryStore();
  let looked = 0;
  const archive = createAvatarArchive({
    store,
    lookup: async handle => {
      looked++;
      return handle === 'Old' ? 'https://pbs.twimg.com/profile_images/7/o_normal.jpg' : '';
    },
    fetchImpl: async () => response(JPEG),
  });
  assert.equal((await archive.readEncoded('Old')).ok, true);
  assert.equal((await archive.readEncoded('nobody')).ok, false);
  assert.equal(looked, 2);
  const off = createAvatarArchive({ store: memoryStore(), enabled: async () => false, lookup: async () => 'x' });
  assert.equal((await off.readEncoded('Old')).ok, false, 'turning the setting off stops new downloads');
  assert.equal(
    (await off.remember([{ handle: 'a', url: 'https://pbs.twimg.com/profile_images/1/a.jpg' }])).disabled,
    true
  );
});
