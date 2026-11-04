// Reproducibly rasterize the hand-authored SVG for Chrome's PNG icon manifest.
// node tools/render-app-icons.mjs [Playwright package] [Chromium executable]
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require=createRequire(import.meta.url),pw=require(process.argv[2] || 'playwright');
const source=await fs.readFile(new URL('../icons/xvault-mark.svg',import.meta.url),'utf8');
const browser=await pw.chromium.launch({headless:true,...(process.argv[3]?{executablePath:process.argv[3]}:{})});
try {
  const page=await browser.newPage({deviceScaleFactor:1});
  for(const size of [16,32,48,128]) {
    await page.setViewportSize({width:size,height:size});
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${source}`);
    await page.screenshot({path:fileURLToPath(new URL(`../icons/icon${size}.png`,import.meta.url)),omitBackground:true});
  }
  console.log('Rendered XVault SVG into 16/32/48/128px Chrome icons');
}finally{await browser.close();}
