// Rasterize the existing vector mark for PWA install surfaces. No runtime dependency.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const pw = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const root = path.resolve('FFmpeg_Helper/remote-ui');
const svg = await fs.readFile(path.join(root, 'app-icon.svg'), 'utf8');
const browser = await pw.chromium.launch({ headless: true, ...(process.argv[3] ? { executablePath: process.argv[3] } : {}) });
try {
  for (const size of [192, 512]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;width:100%;height:100%;background:#11151a}svg{display:block;width:100%;height:100%}</style>${svg}`);
    await page.screenshot({ path: path.join(root, `app-icon-${size}.png`) });
    await page.close();
  }
} finally { await browser.close(); }
console.log('Remote install icons regenerated from app-icon.svg at 192 and 512 pixels.');
