import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../FFmpeg_Helper/xvault_ffmpeg_helper.py', import.meta.url), 'utf8');
assert.match(source, /secrets\.token_urlsafe\(32\)/, 'helper token must be generated, not hardcoded');
assert.match(source, /hmac\.compare_digest/, 'helper auth must use constant-time comparison');
assert.match(source, /Request too large/, 'helper must bound request size');
assert.match(source, /Malformed JSON/, 'helper must reject malformed JSON');
assert.match(source, /Path outside XVault root/, 'helper must reject traversal outside the configured root');
assert.match(source, /CANCEL_REQUESTS/, 'helper must track cancellation by job id');
assert.match(source, /max_concurrency.*1/, 'helper must expose a conservative bounded concurrency default');
assert.match(source, /state.{0,20}cancel-requested/, 'helper must persist cancellation state');
assert.match(source, /auth\/rotate/, 'helper must expose authenticated token rotation');
assert.match(source, /u\.path=='\/media' and not self\.authorized\(\)/, 'media reads must require the bearer token');
assert.match(source, /u\.path=='\/conversions\/queue'/, 'helper must accept explicit conversion jobs');
assert.match(source, /requestedGif.*requestedWebP/, 'conversion requests must carry explicit derivative selection');
assert.match(source, /'maxWidth'.*'webpQuality'/, 'conversion requests must carry bounded quality settings');
console.log('helper protocol: 13 checks passed');
