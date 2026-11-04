import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url);
const messages = [];
const scope = { postMessage: message => messages.push(message) };
const context = vm.createContext({
  self: scope, URL, Set, Map, String, Number, Math, RegExp, Error,
  setTimeout,
  importScripts: (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(new URL(file, root), 'utf8'), context, { filename: file }))
});
vm.runInContext(fs.readFileSync(new URL('../library-export-worker.js', import.meta.url), 'utf8'), context, { filename: 'library-export-worker.js' });

const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Timed out waiting for worker message');
};
const send = data => scope.onmessage({ data });

send({ type: 'start', total: 2, settings: { linkProvider: 'fixupx' }, perBlock: 5 });
await waitFor(() => messages.find(message => message.type === 'ready'));
send({ type: 'chunk', done: 2, posts: [
  { id: '1', url: 'https://x.com/a/status/1' },
  { id: '1', url: 'https://x.com/a/status/1' },
  { id: '2', url: 'https://x.com/b/status/2' }
] });
await waitFor(() => messages.find(message => message.type === 'progress'));
send({ type: 'finish' });
const complete = await waitFor(() => messages.find(message => message.type === 'complete'));
assert.equal(complete.text, 'https://fixupx.com/a/status/1\nhttps://fixupx.com/b/status/2');
assert.equal(complete.unique, 2);
assert.equal(complete.duplicates, 1);

messages.length = 0;
send({ type: 'start', total: 400, settings: {}, perBlock: 5 });
await waitFor(() => messages.find(message => message.type === 'ready'));
send({ type: 'chunk', done: 400, posts: Array.from({ length: 400 }, (_, index) => ({ id: String(index + 10), url: `https://x.com/a/status/${index + 10}` })) });
send({ type: 'cancel' });
await waitFor(() => messages.find(message => message.type === 'cancelled'));
assert.equal(messages.some(message => message.type === 'complete'), false);
console.log('library export worker: chunked ordered output, deduplication, and cancellation passed');
