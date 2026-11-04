import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createOcrProcessor, createOcrIndex, ocrSource } from '../sw/ocr.mjs';
import { HttpStatusError } from '../sw/derived-jobs.mjs';

const search = createRequire(import.meta.url)('../library-search-core.js');

test('ocr: and has:ocr match locally recognised image text only', () => {
  const post = { id: '1', text: 'look at this', media: [{ type: 'photo' }] };
  const withText = search.projectPost(post, 0, { ocrText: 'TOTAL  $12.50\nThank You' });
  const without = search.projectPost(post, 0, {});
  assert.ok(search.matchesQuery(withText, 'ocr:"thank you"'));
  assert.ok(search.matchesQuery(withText, 'has:ocr'));
  assert.ok(!search.matchesQuery(without, 'has:ocr'));
  assert.ok(!search.matchesQuery(withText, 'ocr:receipt'));
  assert.ok(search.usesRuleKind(search.compileQuery('cat ocr:menu'), ['ocrText']));
  assert.deepEqual(search.queryIssues('has:ocr ocr:x'), []);
});

test('OCR processor reads the medium rendition and classifies failures', async () => {
  const sent = [];
  const host = {
    send: async message => {
      sent.push(message);
      if (message.type === 'OCR_PING') return { ok: true };
      if (message.url.includes('gone')) return { ok: false, status: 404 };
      if (message.url.includes('slow')) return { ok: false, status: 429, retryAfterMs: 5000 };
      return { ok: true, text: 'hello', confidence: 90 };
    },
  };
  const processor = createOcrProcessor({ store: {}, host });
  assert.deepEqual(await processor.ready(), { ok: true });
  const item = {
    key: 'p:1',
    postId: 'p',
    type: 'photo',
    thumb: 'https://pbs.twimg.com/media/a?format=jpg&name=thumb',
    fallback: 'https://pbs.twimg.com/media/a?format=jpg&name=small',
  };
  assert.equal(ocrSource(item), 'https://pbs.twimg.com/media/a?format=jpg&name=medium');
  const row = await processor.process(item);
  assert.equal(row.text, 'hello');
  assert.equal(row.state, 'ok');
  await assert.rejects(
    processor.process({ ...item, fallback: item.fallback.replace('/a?', '/gone?') }),
    error => error instanceof HttpStatusError && error.status === 404
  );
  await assert.rejects(
    processor.process({ ...item, fallback: item.fallback.replace('/a?', '/slow?') }),
    error => error.status === 429 && error.retryAfterMs === 5000
  );
  assert.ok(!processor.eligible({ ...item, type: 'video' }));
});

test('OCR index joins text per post and rebuilds only when the revision changes', async () => {
  let revision = 1,
    reads = 0;
  const rows = [
    { key: 'a:0', postId: 'a', state: 'ok', text: 'one' },
    { key: 'a:1', postId: 'a', state: 'ok', text: 'two' },
    { key: 'b:0', postId: 'b', state: 'unavailable', text: '' },
  ];
  const index = createOcrIndex({ revision: async () => revision, getAll: async () => (reads++, rows) });
  const first = await index.map();
  assert.equal(first.get('a'), 'one\ntwo');
  assert.ok(!first.has('b'));
  await index.map();
  assert.equal(reads, 1);
  revision = 2;
  await index.map();
  assert.equal(reads, 2);
});
