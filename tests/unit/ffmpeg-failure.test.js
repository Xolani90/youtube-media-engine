import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describeFfmpegFailure, runFfmpeg, FfmpegExecError, FFMPEG_FAILURE_LIMITS } from '../../src/media/ffmpegFailure.js';
import { muxNarration } from '../../src/media/render.js';

const BANNER = [
  'ffmpeg version 9.0.2-full_build Copyright (c) 2000-2026 the FFmpeg developers',
  '  built with gcc 16.2.0',
  '  configuration: --enable-gpl --enable-libx264',
  '  libavutil      61.  1.102 / 61.  1.102',
  '  libswscale      9.  0.100 /  9.  0.100'
];

test('FF1. banner lines are removed, real error lines survive', () => {
  const msg = describeFfmpegFailure({ status: 3, stderr: [...BANNER, 'Error while filtering: boom', 'Conversion failed!'].join('\n') });
  assert.match(msg, /^exit=3 signal=- code=- \| /);
  assert.match(msg, /Error while filtering: boom/);
  assert.match(msg, /Conversion failed!$/);
  assert.doesNotMatch(msg, /configuration:|built with|libavutil|libswscale|ffmpeg version/);
});

test('FF2. long stderr keeps the head and the actionable tail', () => {
  const lines = Array.from({ length: 40 }, (_, i) => 'line' + i);
  const msg = describeFfmpegFailure({ status: 1, stderr: lines.join('\n') });
  assert.match(msg, /line0 \| line1 \| line2 \| \.\.\. \| line34 \| line35 \| line36 \| line37 \| line38 \| line39$/);
  assert.doesNotMatch(msg, /line10\b/);
});

test('FF3. absent, empty, non-string and Buffer stderr are handled safely', () => {
  assert.match(describeFfmpegFailure({ status: 1 }), /^exit=1 signal=- code=- \| no stderr$/);
  assert.match(describeFfmpegFailure({ status: 1, stderr: '' }), /\| no stderr$/);
  assert.doesNotThrow(() => describeFfmpegFailure({ status: 1, stderr: 42 }));
  assert.doesNotThrow(() => describeFfmpegFailure(null));
  assert.doesNotThrow(() => describeFfmpegFailure(undefined));
  assert.match(describeFfmpegFailure({ status: 2, stderr: Buffer.from('a\nreal error\n') }), /a \| real error$/);
  assert.equal(describeFfmpegFailure({ message: 'spawn ffmpeg ENOENT', code: 'ENOENT' }), 'exit=- signal=- code=ENOENT | spawn ffmpeg ENOENT');
});

test('FF4. status, signal and spawn code are preserved', () => {
  assert.match(describeFfmpegFailure({ status: 3752568763, stderr: 'x' }), /^exit=3752568763 signal=- code=- \| x$/);
  assert.match(describeFfmpegFailure({ status: null, signal: 'SIGKILL', code: 'ENOBUFS', stderr: 'x' }), /^exit=- signal=SIGKILL code=ENOBUFS \| x$/);
});

test('FF5. output is bounded: very long lines and very many lines', () => {
  const one = describeFfmpegFailure({ status: 1, stderr: 'e'.repeat(100000) });
  assert.ok(one.length < FFMPEG_FAILURE_LIMITS.MAX_TOTAL_CHARS + 100, 'single huge line is truncated');
  const many = describeFfmpegFailure({ status: 1, stderr: Array.from({ length: 5000 }, (_, i) => 'warning number ' + i + ' ' + 'z'.repeat(50)).join('\n') });
  assert.ok(many.length < FFMPEG_FAILURE_LIMITS.MAX_TOTAL_CHARS + 100, 'many lines are bounded');
  assert.match(many, /warning number 4999/, 'the tail survives truncation');
});

test('FF6. runFfmpeg turns a real FFmpeg failure into FfmpegExecError with a useful message', () => {
  const missing = path.join(os.tmpdir(), 'no-such-input-ffmpeg-failure-test.mp4');
  const out = path.join(os.tmpdir(), 'ffmpeg-failure-test-out.mp4');
  assert.throws(
    () => runFfmpeg('unit', ['-y', '-i', missing, out], { stdio: ['ignore', 'pipe', 'pipe'] }),
    (e) => e instanceof FfmpegExecError
      && /^ffmpeg_unit_failed: exit=\d+ signal=- code=- \| /.test(e.message)
      && typeof e.status === 'number'
      && !/configuration:|built with|libavutil|ffmpeg version/.test(e.message)
      && e.message.length < FFMPEG_FAILURE_LIMITS.MAX_TOTAL_CHARS + 200
  );
});

test('FF7. muxNarration surfaces the same summarised error (error boundary), banner-free', () => {
  const missing = path.join(os.tmpdir(), 'no-such-video-ffmpeg-failure-test.mp4');
  assert.throws(
    () => muxNarration({ silentVideoPath: missing, narrationPath: missing, audioEncoder: 'aac', outputPath: path.join(os.tmpdir(), 'ffmpeg-failure-mux-out.mp4') }),
    (e) => e instanceof Error && /^ffmpeg_mux_failed: exit=\d+/.test(e.message) && !/configuration:|built with|ffmpeg version/.test(e.message)
  );
});
