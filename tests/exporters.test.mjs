import test from 'node:test';
import assert from 'node:assert/strict';
import * as X from '../library-exporters.mjs';

const post = {
  id: '123',
  text: '# Not a heading\n=SUM(A1) <b>bold</b> *stars*',
  author: { handle: 'alice', name: 'Alice "A"' },
  createdAt: '2024-05-01T10:00:00Z',
  archivedAt: Date.parse('2024-06-01T00:00:00Z'),
  metrics: { likes: 5 },
  media: [
    { type: 'photo', url: 'https://pbs.twimg.com/media/A.jpg' },
    { type: 'video', playbackUrl: 'https://video.twimg.com/v.mp4' },
  ],
  userMeta: { tags: ['cats', 'big cats'], favorite: true, note: 'remember this' },
};

test('CSV cells neutralise formulas and quote separators', () => {
  assert.equal(X.csvCell('=1+1'), "'=1+1");
  assert.equal(X.csvCell('@cmd'), "'@cmd");
  assert.equal(X.csvCell('a,b'), '"a,b"');
  assert.equal(X.csvCell('say "hi"'), '"say ""hi"""');
  const row = X.csvRow(post);
  assert.ok(row.endsWith('\r\n'));
  assert.ok(row.includes('cats big cats'));
  assert.ok(row.includes('https://x.com/alice/status/123'));
  assert.equal(X.csvHeader().split(',').length, X.CSV_COLUMNS.length);
});

test('Markdown note has valid frontmatter and literal text', () => {
  const note = X.markdownNote(post);
  assert.ok(note.startsWith('---\nid: "123"\n'));
  assert.ok(note.includes('tags:\n  - "cats"\n  - "big-cats"'));
  assert.ok(note.includes('\\# Not a heading'));
  assert.ok(note.includes('\\<b\\>bold\\</b\\>'));
  assert.ok(note.includes('![media 1](https://pbs.twimg.com/media/A.jpg)'));
  assert.ok(note.includes('## Note\n\nremember this'));
  assert.equal(X.markdownFileName(post), '2024-05-01 @alice 123.md');
});

test('file names are safe on every OS', () => {
  assert.equal(X.safeFileName('a/b\\c:d*e?'), 'a b c d e');
  assert.equal(X.safeFileName('CON'), 'post');
  assert.equal(X.safeFileName('...hidden'), 'hidden');
  assert.equal(X.safeFileName(''), 'post');
});

test('HTML export escapes content and drops unsafe URLs', () => {
  const evil = {
    ...post,
    text: '<script>alert(1)</script>',
    url: 'javascript:alert(1)',
    media: [{ type: 'photo', url: 'javascript:x' }],
  };
  const html = X.htmlPost(evil);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('javascript:'));
  const doc = X.htmlHead('T') + X.htmlPost(post) + X.htmlFoot();
  assert.ok(doc.includes('Content-Security-Policy'));
  assert.ok(doc.includes('<img loading="lazy" src="https://pbs.twimg.com/media/A.jpg"'));
});

test('index links every note', () => {
  const idx = X.markdownIndex([{ file: 'a.md', handle: 'x', text: 'hello [world]' }], 0);
  assert.ok(idx.includes('- [[a]] — @x: hello  world '));
});
