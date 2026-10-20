import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOTICES = readFileSync(fileURLToPath(new URL('../../THIRD_PARTY_NOTICES.md', import.meta.url)), 'utf8');

// Every external tool or donor the engine's code integrates must have an entry in THIRD_PARTY_NOTICES.md.
// Add a row here when a new donor is integrated; the test then fails until the notice is written.
const REQUIRED = [
  ['kokoro-js', /^## Kokoro/m],
  ['espeak-ng', /^## espeak-ng/m],
  ['ffmpeg', /^## FFmpeg and ffprobe/m],
  ['whisper.cpp', /^## whisper\.cpp/m],
  ['@napi-rs/canvas', /^## Thumbnail canvas worker/m],
  ['siglip', /^## Scene-relevance ranker worker \(SigLIP/m]
];

for (const [name, heading] of REQUIRED) {
  test(`THIRD_PARTY_NOTICES.md has a section for ${name}`, () => {
    assert.match(NOTICES, heading);
  });
}

test('FFmpeg notice states that the licence is the installed build\'s and records the GPL configuration', () => {
  const sec = NOTICES.split(/^## /m).find((s) => s.startsWith('FFmpeg and ffprobe'));
  assert.ok(sec);
  assert.match(sec, /not bundled/i);
  assert.match(sec, /--enable-gpl/);
  assert.match(sec, /build/i);
});

test('whisper.cpp notice says it is optional and off by default', () => {
  const sec = NOTICES.split(/^## /m).find((s) => s.startsWith('whisper.cpp'));
  assert.ok(sec);
  assert.match(sec, /off by default/i);
  assert.match(sec, /ASR_PROVIDER=whisper\.cpp/);
});
