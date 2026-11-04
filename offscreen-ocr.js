/* Offscreen document that hosts the local OCR engine (tesseract.js + WebAssembly).
 * Every file — worker, core, English model — is loaded from the extension package (vendor/ocr);
 * nothing is downloaded from third-party servers and image text never leaves this computer.
 * The service worker owns the job; this page only answers OCR_* messages addressed to it. */
(() => {
  const TARGET = 'xv-ocr';
  const base = chrome.runtime.getURL('vendor/ocr/');
  let engine = null,
    idleTimer = 0;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(Error('OCR engine not installed (vendor/ocr is missing from this build)'));
      document.head.append(script);
    });
  }
  async function worker() {
    engine ||= (async () => {
      if (!globalThis.Tesseract) await loadScript(`${base}tesseract.min.js`);
      return globalThis.Tesseract.createWorker('eng', 1, {
        workerPath: `${base}worker.min.js`,
        corePath: `${base}core`,
        langPath: `${base}lang`,
        workerBlobURL: false,
        gzip: true,
        cacheMethod: 'none',
      });
    })().catch(error => {
      engine = null;
      throw error;
    });
    return engine;
  }
  // Free the ~100 MB engine when the queue goes quiet.
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      const current = engine;
      engine = null;
      try {
        await (await current)?.terminate();
      } catch {}
    }, 90000);
  }
  function allowedImage(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'pbs.twimg.com' && !parsed.port;
    } catch {
      return false;
    }
  }
  const tidy = text =>
    String(text || '')
      .replace(/[^\S\n]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 20000);

  async function recognize(url) {
    if (!allowedImage(url)) throw Object.assign(Error('Only X media images can be read'), { status: 400 });
    const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!response.ok) {
      const retry = Number(response.headers.get('retry-after')) || 0;
      return { ok: false, status: response.status, retryAfterMs: retry * 1000, error: `HTTP ${response.status}` };
    }
    const blob = await response.blob(),
      ocr = await worker(),
      { data } = await ocr.recognize(blob);
    scheduleIdle();
    const words = (data.words || data.blocks || []).length;
    return { ok: true, text: tidy(data.text), confidence: Math.round(Number(data.confidence) || 0), words };
  }

  async function handle(message) {
    try {
      if (message?.type === 'OCR_PING') {
        const response = await fetch(`${base}engine.json`).catch(() => null);
        if (!response?.ok)
          return { ok: false, error: 'OCR engine not installed (vendor/ocr is missing from this build)' };
        return { ok: true, engine: await response.json() };
      }
      if (message?.type === 'OCR_RECOGNIZE') return await recognize(String(message.url || ''));
      return { ok: false, error: 'Unknown OCR request' };
    } catch (error) {
      return { ok: false, error: error?.message || String(error), status: error?.status || 0 };
    }
  }
  async function release() {
    clearTimeout(idleTimer);
    const current = engine;
    engine = null;
    try {
      await (await current)?.terminate();
    } catch {}
  }
  // Firefox runs the engine inside its background page (sw/ocr.mjs createInlineHost) and calls it directly.
  globalThis.XVaultOcrEngine = { handle, release };

  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    // Ignore everything not addressed to the OCR host so other extension pages keep working.
    if (message?.target !== TARGET || sender.id !== chrome.runtime.id) return;
    handle(message).then(reply);
    return true;
  });
})();
