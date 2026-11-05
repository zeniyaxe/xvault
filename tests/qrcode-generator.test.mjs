import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const qrcode = require('../FFmpeg_Helper/remote-ui/qrcode-generator.js');

const value = 'http://192.168.1.25:18765/pair#single-use-test-token';
const code = qrcode(0, 'Q');
code.addData(value, 'Byte');
code.make();
const svg = code.createSvgTag({ cellSize: 5, margin: 4, scalable: true });
assert.match(svg, /^<svg\b/);
assert.match(svg, /viewBox=/);
assert.ok(code.getModuleCount() > 21);
assert.ok(!svg.includes(value), 'QR SVG must encode, not render, its pairing URL');
console.log(`qrcode-generator: offline SVG encoder produced ${code.getModuleCount()} modules`);
