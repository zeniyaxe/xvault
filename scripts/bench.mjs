// XVault 20 performance benchmarks: `npm run bench` (optionally `-- --sizes=10000,50000`).
// Measures the pure engines on synthetic but realistically shaped data (Zipf word frequencies,
// topical clusters, tweet-length posts) on this machine. Numbers vary by CPU; the point is to catch
// regressions and to show the cost curve, not to promise absolute speeds.
import { performance } from 'node:perf_hooks';
import { deflateRawSync } from 'node:zlib';
import { buildSemanticIndex, searchIndex, similarTo, upsertDocuments, DIM } from '../sw/semantic.mjs';
import { encryptingWriter, decryptBackup } from '../backup-crypto.mjs';
import { readXArchive } from '../x-archive-import.mjs';
import { buildInsights } from '../vault-insights.mjs';
import searchCore from '../library-search-core.js';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=')[1];
const sizes = (argument('sizes') || '10000,50000').split(',').map(Number).filter(Boolean);
let seed = 20;
const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const syllables = ['ka', 'lo', 'mi', 'ren', 'to', 'sa', 'vi', 'dor', 'el', 'qu', 'an', 'ost', 'ir', 'ux', 'pe', 'ly'];
const words = Array.from({ length: 24000 }, (_, index) => {
  let word = '',
    value = index + 17;
  while (value > 0 || word.length < 4)
    ((word += syllables[value % syllables.length]), (value = Math.floor(value / 16)));
  return word;
});
// Zipf: a few words are everywhere, most are rare. 60 topics each favour their own slice of the vocabulary.
const zipf = () => words[Math.min(words.length - 1, Math.floor(Math.exp(random() * Math.log(words.length))) - 1)];
const topicWord = topic => words[200 + topic * 300 + Math.floor(random() ** 2 * 300)];
function corpus(count) {
  return Array.from({ length: count }, (_, index) => {
    const topic = index % 60,
      length = 8 + Math.floor(random() * 30);
    const text = Array.from({ length }, () => (random() < 0.45 ? topicWord(topic) : zipf())).join(' ');
    return { id: String(1e15 + index), text, topic };
  });
}
const time = async (label, run, repeat = 1) => {
  const start = performance.now();
  let value;
  for (let index = 0; index < repeat; index++) value = await run(index);
  const ms = (performance.now() - start) / repeat;
  return { label, ms, value };
};
const rows = [];
const report = (area, label, ms, extra = '') => {
  rows.push({ area, label, ms });
  console.log(`${area.padEnd(10)} ${label.padEnd(44)} ${ms.toFixed(ms < 10 ? 2 : 0).padStart(9)} ms  ${extra}`);
};

console.log(`XVault benchmarks · Node ${process.version} · ${process.platform}/${process.arch}\n`);
for (const size of sizes) {
  const docs = corpus(size);
  const build = await time('build', () => buildSemanticIndex(docs));
  const index = build.value;
  const bytes = index.vectors.byteLength + index.contexts.byteLength + index.idf.byteLength;
  report(
    'meaning',
    `build index · ${size.toLocaleString()} posts`,
    build.ms,
    `${index.terms.length.toLocaleString()} terms · ${(bytes / 1048576).toFixed(1)} MiB`
  );
  const queries = Array.from({ length: 20 }, (_, n) => `${topicWord(n)} ${topicWord(n)}`);
  const search = await time('search', n => searchIndex(index, queries[n % queries.length]), 20);
  // Precision@20 against the synthetic topic labels.
  let precise = 0;
  for (let n = 0; n < 20; n++) {
    const hits = [...searchIndex(index, `${topicWord(n)} ${topicWord(n)} ${topicWord(n)}`, { limit: 20 })];
    precise += hits.filter(([id]) => docs[Number(id) - 1e15].topic === n).length / Math.max(1, hits.length);
  }
  report(
    'meaning',
    `about: query · ${size.toLocaleString()} posts`,
    search.ms,
    `precision@20 ${(precise / 20).toFixed(2)} (synthetic topics)`
  );
  const similar = await time('similar', n => similarTo(index, docs[n * 7].id), 20);
  report('meaning', `similar: neighbours · ${size.toLocaleString()} posts`, similar.ms);
  const upsert = await time('upsert', () => upsertDocuments(index, corpus(100)));
  report('meaning', `upsert 100 posts · ${size.toLocaleString()}`, upsert.ms);

  // Library search core: projection + a compound filter + sort over the whole archive.
  const posts = docs.map((doc, n) => ({
    id: doc.id,
    text: doc.text,
    author: { handle: `user${Math.floor(random() ** 3 * 900)}` },
    media: n % 3 ? [{ type: 'photo', url: `https://pbs.twimg.com/media/${n}.jpg` }] : [],
    metrics: { likes: n % 5000 },
    hashtags: [topicWord(n % 60)],
    mentions: [`user${Math.floor(random() ** 3 * 900)}`],
    createdAt: new Date(Date.UTC(2018 + (n % 8), n % 12, 1 + (n % 27))).toISOString(),
    archivedAt: 1.7e12 + n,
    userMeta: n % 11 ? {} : { readLater: true, tags: ['keep'], boards: ['inspo'], highlights: [{ text: 'x' }] },
  }));
  const project = await time('project', () => posts.map((post, n) => searchCore.projectPost(post, n)));
  report('search', `project ${size.toLocaleString()} posts`, project.ms);
  const compiled = searchCore.compileQuery('has:media likes:>100 -is:later');
  const filter = await time(
    'filter',
    () =>
      project.value
        .filter(row => searchCore.matchesCompiledQuery(row, compiled))
        .sort((a, b) => searchCore.compareRows(a, b, 'likes')),
    5
  );
  report(
    'search',
    `compound filter + sort · ${size.toLocaleString()}`,
    filter.ms,
    `${filter.value.length.toLocaleString()} hits`
  );

  const insights = await time('insights', () => buildInsights(posts, { timeZone: 'utc' }));
  report(
    'atlas',
    `insights incl. Year in Review · ${size.toLocaleString()}`,
    insights.ms,
    `${insights.value.years.length} years · ${insights.value.graph.edges.length} graph edges`
  );
}

// X archive import: a deflated tweets.js of 20,000 posts.
{
  const tweets = corpus(20000).map((doc, n) => ({
    tweet: {
      id_str: doc.id,
      full_text: doc.text,
      created_at: new Date(1.6e12 + n * 6e4).toUTCString(),
      favorite_count: String(n % 400),
    },
  }));
  const text = Buffer.from(`window.YTD.tweets.part0 = ${JSON.stringify(tweets)}`);
  const packed = deflateRawSync(text);
  const name = Buffer.from('data/tweets.js');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(text.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(text.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(30 + name.length + packed.length, 16);
  const file = new File([local, name, packed, central, name, end], 'twitter.zip');
  const read = await time('import', () => readXArchive(file));
  report(
    'import',
    'read X archive · 20,000 tweets',
    read.ms,
    `${(text.length / 1048576).toFixed(1)} MiB tweets.js · ${(file.size / 1048576).toFixed(1)} MiB zipped`
  );
}

// Encrypted backups: key derivation at the shipped 600k iterations, then throughput on 32 MiB.
{
  const derive = await time('derive', async () => {
    const writer = encryptingWriter(
      { write: async () => {}, close: async () => {}, abort: async () => {} },
      'correct horse battery',
      { iterations: 600000 }
    );
    await writer.write('x');
    await writer.close();
  });
  report('backup', 'PBKDF2-SHA-256 key · 600,000 iterations', derive.ms);
  const payload = new Uint8Array(32 * 1048576).map((_, n) => n & 255);
  const parts = [];
  const encrypt = await time('encrypt', async () => {
    const writer = encryptingWriter(
      { write: async part => parts.push(part), close: async () => {}, abort: async () => {} },
      'correct horse battery',
      { iterations: 1000 }
    );
    for (let at = 0; at < payload.length; at += 256 * 1024) await writer.write(payload.subarray(at, at + 256 * 1024));
    await writer.close();
  });
  report(
    'backup',
    'encrypt 32 MiB (AES-256-GCM, 1 MiB frames)',
    encrypt.ms,
    `${(32 / (encrypt.ms / 1000)).toFixed(0)} MiB/s`
  );
  const decrypt = await time('decrypt', () => decryptBackup(new Blob(parts), 'correct horse battery'));
  report('backup', 'decrypt + verify 32 MiB', decrypt.ms, `${(32 / (decrypt.ms / 1000)).toFixed(0)} MiB/s`);
}
console.log(`\nVector size ${DIM} × int8 per post.`);
if (argument('json')) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(argument('json'), JSON.stringify({ node: process.version, rows }, null, 2));
}
