// XVault 21: OCR host selection — Chrome/Edge offscreen document, Firefox background page, otherwise unavailable.
import assert from 'node:assert/strict';
import { createOcrHost, createInlineHost } from '../sw/ocr.mjs';

// Chrome: offscreen API present → offscreen host (creates the document once, then messages it).
{
  const created = [],
    sent = [];
  let open = false;
  const chromeApi = {
    offscreen: {
      createDocument: async options => (created.push(options), (open = true)),
      closeDocument: async () => (open = false),
    },
    runtime: {
      getURL: path => `chrome-extension://id/${path}`,
      getContexts: async () => (open ? [{}] : []),
      sendMessage: async message => (sent.push(message), { ok: true, echo: message.type }),
    },
  };
  const host = createOcrHost(chromeApi, {});
  assert.deepEqual(await host.send({ type: 'OCR_PING' }), { ok: true, echo: 'OCR_PING' });
  await host.send({ type: 'OCR_PING' });
  assert.equal(created.length, 1, 'one offscreen document');
  assert.equal(sent[0].target, 'xv-ocr');
  await host.close();
  assert.equal(await host.has(), false);
}

// Firefox: no offscreen, but a DOM → the engine is loaded into the page and called directly.
{
  const scope = { document: { createElement() {} } };
  let loads = 0;
  const load = async () => {
    loads++;
    scope.XVaultOcrEngine = {
      handle: async message => ({ ok: true, type: message.type }),
      release: async () => (scope.released = true),
    };
  };
  const host = createOcrHost({ runtime: {} }, scope, load);
  assert.equal(await host.has(), false);
  assert.deepEqual(await host.send({ type: 'OCR_RECOGNIZE', url: 'https://pbs.twimg.com/media/a.jpg' }), {
    ok: true,
    type: 'OCR_RECOGNIZE',
  });
  await host.send({ type: 'OCR_PING' });
  assert.equal(loads, 1, 'the engine script is loaded once');
  await host.close();
  assert.equal(scope.released, true);
  await assert.rejects(createInlineHost({}, async () => {}).send({ type: 'OCR_PING' }), /could not start/);
}

// Neither (e.g. a worker without offscreen): a clear, non-throwing error the OCR job reports.
{
  const host = createOcrHost({ runtime: {} }, {});
  const result = await host.send({ type: 'OCR_PING' });
  assert.equal(result.ok, false);
  assert.match(result.error, /offscreen document .* background page/);
}
console.log('OCR host: offscreen (Chrome/Edge), in-page (Firefox) and unavailable passed');
