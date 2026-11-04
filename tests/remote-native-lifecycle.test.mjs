import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

// Exercise the worker's actual lifecycle with Chrome's local-disconnect semantics.
const source = await fs.readFile(new URL('../background.js', import.meta.url), 'utf8');
const block = source.slice(source.search(/let remoteNativePort\s*=/), source.indexOf('function validRemoteId('));
function fixture() {
  const ports = [],
    timers = new Map();
  let sequence = 0;
  const context = vm.createContext({
    crypto: webcrypto,
    console,
    getSettings: async () => ({ remoteEnabled: false }),
    setTimeout: fn => {
      const id = ++sequence;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: id => timers.delete(id),
    chrome: {
      runtime: {
        lastError: null,
        connectNative: () => {
          const messages = [],
            disconnects = [];
          const port = {
            closed: false,
            onMessage: { addListener: fn => messages.push(fn) },
            onDisconnect: { addListener: fn => disconnects.push(fn) },
            disconnect() {
              this.closed = true;
            }, // Chrome does NOT fire onDisconnect on this local port.
            postMessage(message) {
              if (this.closed) throw Error('Attempting to use a disconnected port object');
              this.sent.push(message);
            },
            sent: [],
            reply(result) {
              const message = this.sent.at(-1);
              for (const fn of messages) fn({ type: 'response', id: message.id, result });
            },
            remoteClose() {
              this.closed = true;
              for (const fn of disconnects) fn();
            },
          };
          ports.push(port);
          return port;
        },
      },
    },
  });
  vm.runInContext(block, context);
  return {
    ports,
    context,
    command: name => vm.runInContext(`remoteHostCommand(${JSON.stringify(name)})`, context),
    async flush() {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
    idle() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
  };
}
{
  const f = fixture(),
    check = f.command('devices.list');
  f.ports[0].reply({ rows: [] });
  await check;
  f.idle();
  assert.equal(f.ports[0].closed, true);
  const start = f.command('remote.start');
  assert.equal(f.ports.length, 2, 'a locally disconnected idle host must be replaced before pairing');
  f.ports[1].reply({ listening: true });
  await start;
}
{
  const f = fixture(),
    check = f.command('remote.status');
  f.ports[0].reply({ listening: false });
  await check;
  const start = f.command('remote.start');
  f.ports[0].reply({ listening: true });
  await start;
  f.idle();
  assert.equal(f.ports[0].closed, false, 'idle status cleanup must not stop a newly started listener');
}
{
  const f = fixture(),
    old = f.command('remote.status');
  f.ports[0].reply({ listening: false });
  await old;
  f.ports[0].remoteClose();
  const next = f.command('remote.start');
  f.ports[0].remoteClose();
  f.ports[1].reply({ listening: true });
  assert.equal((await next).listening, true, 'late events from an old port cannot reject a newer command');
}
console.log('PASS Native lifecycle: local idle disconnect, rapid start, stale-port event ownership');
