const test = require('node:test');
const assert = require('node:assert/strict');
const { createHooks } = require('../dashboard-hooks.js');

test('before and after observers run around the built-in in registration order', () => {
  const hooks = createHooks(['page']);
  const calls = [];
  hooks.before('page', name => calls.push(`before:${name}`));
  hooks.after('page', (result, name) => calls.push(`after1:${name}:${result}`));
  hooks.after('page', (result, name) => calls.push(`after2:${name}:${result}`));
  const result = hooks.invoke('page', name => (calls.push(`builtin:${name}`), name.toUpperCase()), null, ['home']);
  assert.equal(result, 'HOME');
  assert.deepEqual(calls, ['before:home', 'builtin:home', 'after1:home:HOME', 'after2:home:HOME']);
});

test('a provider replaces the built-in once and receives it', () => {
  const hooks = createHooks(['renderLib']);
  let made = 0;
  hooks.provide('renderLib', builtin => {
    made++;
    return options => `workspace(${builtin(options)})`;
  });
  const builtin = options => `builtin:${options?.externallyFiltered ? 'filtered' : 'all'}`;
  assert.equal(hooks.invoke('renderLib', builtin, null, []), 'workspace(builtin:all)');
  assert.equal(hooks.invoke('renderLib', builtin, null, [{ externallyFiltered: true }]), 'workspace(builtin:filtered)');
  assert.equal(made, 1);
  assert.throws(() => hooks.provide('renderLib', () => () => {}), /already has a provider/);
});

test('after observers wait for async results and failures are isolated', async () => {
  const errors = [];
  const hooks = createHooks(['queueStats'], { onError: error => errors.push(error.message) });
  const seen = [];
  hooks.after('queueStats', () => {
    throw new Error('broken observer');
  });
  hooks.after('queueStats', result => seen.push(result.queued));
  const result = await hooks.invoke('queueStats', async () => ({ queued: 3 }), null, []);
  assert.deepEqual(result, { queued: 3 });
  assert.deepEqual(seen, [3]);
  assert.deepEqual(errors, ['broken observer']);
});

test('unknown hooks are rejected and observers can unsubscribe', () => {
  const hooks = createHooks(['sync']);
  assert.throws(() => hooks.after('nope', () => {}), /Unknown dashboard hook/);
  let count = 0;
  const off = hooks.after('sync', () => count++);
  hooks.invoke('sync', () => {}, null, []);
  off();
  hooks.invoke('sync', () => {}, null, []);
  assert.equal(count, 1);
});

test('command sources are merged and a throwing source is skipped', () => {
  const hooks = createHooks([], { onError: () => {} });
  hooks.commands(query => [{ name: `Atlas ${query}` }]);
  hooks.commands(() => {
    throw new Error('x');
  });
  hooks.commands(() => [{ name: 'OCR' }]);
  assert.deepEqual(
    hooks.extraCommands('q').map(command => command.name),
    ['Atlas q', 'OCR']
  );
});
