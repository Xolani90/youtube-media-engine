import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveFinishProfile, resolveRenderSize, buildFinishVideoFilter, buildFinishAudioFilter, parseLoudnormJson, inputColour, finishRenderedVideo, voicePan } from '../../src/media/finish.js';
import { layoutTitle, wrapWords, resolveThumbnailStyle, pickThumbnailImage, generateThumbnailFromImage } from '../../src/media/thumbnailPhoto.js';

const ff = (a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a], { stdio: 'pipe' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'finish-test-'));

test('profile and size resolvers', () => {
  assert.equal(resolveFinishProfile({}), 'cinematic');
  assert.equal(resolveFinishProfile({ FINISH_PROFILE: 'off' }), 'off');
  assert.throws(() => resolveFinishProfile({ FINISH_PROFILE: 'x' }), /CONFIG_INVALID/);
  assert.deepEqual(resolveRenderSize({}), { width: 1280, height: 720 });
  assert.deepEqual(resolveRenderSize({ RENDER_RESOLUTION: '1080' }), { width: 1920, height: 1080 });
  assert.throws(() => resolveRenderSize({ RENDER_RESOLUTION: '480' }), /CONFIG_INVALID/);
  assert.equal(resolveThumbnailStyle({}), 'photo');
  assert.equal(resolveThumbnailStyle({ THUMBNAIL_STYLE: 'canvas' }), 'canvas');
});

test('filters are deterministic and tag BT.709', () => {
  const stream = { pix_fmt: 'yuvj420p', height: 720 };
  assert.deepEqual(inputColour(stream), { range: 'pc', matrix: 'bt709' });
  const a = buildFinishVideoFilter({ stream, durationSeconds: 10 });
  assert.equal(a, buildFinishVideoFilter({ stream, durationSeconds: 10 }));
  assert.match(a, /fade=t=out:st=8\.800:d=1\.2/);
  assert.match(a, /out_color_matrix=bt709/);
  assert.ok(a.indexOf('format=yuv420p') < a.indexOf('fade=t=in'), 'fades must run after the final YUV conversion');
  assert.ok(a.endsWith(':d=1.2'), 'fade-out is the last filter');
  assert.match(buildFinishAudioFilter({ durationSeconds: 10 }), /print_format=json/);
  assert.match(buildFinishAudioFilter({ measured: { input_i: '-20', input_tp: '1', input_lra: '5', input_thresh: '-30', target_offset: '0.1' }, durationSeconds: 10 }), /linear=true.*alimiter/);
  assert.equal(voicePan(2), 'pan=stereo|c0=c0|c1=c1');
  assert.throws(() => parseLoudnormJson('nothing'), /MEASURE_FAILED/);
});

test('title layout fits or throws', () => {
  assert.ok(layoutTitle('AI vs. Franchise Admin').lines.length <= 3);
  assert.equal(wrapWords('a b c', 3, 1), null);
  assert.throws(() => layoutTitle(''), /empty/);
  assert.throws(() => layoutTitle('x'.repeat(200)), /too long/);
});

test('real finishing pass: stereo, -14 LUFS band, peak below -1 dBTP, bt709, same size', () => {
  const d = tmp();
  try {
    const src = path.join(d, 'in.mp4'); const out = path.join(d, 'out.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-af', 'volume=2.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '1', src]);
    finishRenderedVideo({ inputPath: src, outputPath: out, preset: 'ultrafast' });
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out]).toString());
    const v = j.streams.find((s) => s.codec_type === 'video'); const a = j.streams.find((s) => s.codec_type === 'audio');
    assert.equal(v.codec_name, 'h264'); assert.equal(`${v.width}x${v.height}`, '640x360');
    assert.equal(v.color_space, 'bt709'); assert.equal(a.codec_name, 'aac'); assert.equal(a.channels, 2); assert.equal(a.sample_rate, '48000');
    const r = spawnSync('ffmpeg', ['-hide_banner', '-nostdin', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const summary = r.slice(r.lastIndexOf('Summary:'));
    const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)[1]);
    const peak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)[1]);
    assert.ok(lufs > -16 && lufs < -12, `LUFS ${lufs}`);
    assert.ok(peak < -1, `true peak ${peak}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('photo thumbnail: 1280x720 PNG under 2 MB; picker ignores missing files', () => {
  const d = tmp();
  try {
    const img = path.join(d, 's.jpg'); const out = path.join(d, 't.png');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=1600x900:rate=1', '-frames:v', '1', img]);
    const res = generateThumbnailFromImage({ title: 'AI vs. Franchise Admin', imagePath: img, outputPath: out });
    assert.ok(res.bytes > 0 && res.bytes <= 2 * 1024 * 1024);
    const v = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out]).toString()).streams[0];
    assert.equal(`${v.codec_name} ${v.width}x${v.height}`, 'png 1280x720');
    assert.equal(pickThumbnailImage({ visual_timing: [{ location: '/nope.jpg' }, { location: img }] }), img);
    assert.equal(pickThumbnailImage('not json'), null);
    assert.equal(pickThumbnailImage({ visual_timing: [{ location: '/nope.jpg' }] }), null);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('black stays black: a faded all-black clip starts, runs and ends at broadcast black (luma ~16), not grey', () => {
  const d = tmp();
  try {
    const src = path.join(d, 'b.mp4'); const out = path.join(d, 'bf.mp4');
    ff(['-f', 'lavfi', '-i', 'color=black:s=640x360:r=24:d=4', '-f', 'lavfi', '-i', 'sine=d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
    finishRenderedVideo({ inputPath: src, outputPath: out, preset: 'ultrafast' });
    const luma = (extra) => Number(/YAVG=([\d.]+)/.exec(spawnSync('ffmpeg', ['-v', 'error', ...extra, '-i', out, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'], { encoding: 'utf8' }).stdout)[1]);
    assert.ok(luma(['-ss', '0']) <= 19, `first frame luma ${luma(['-ss', '0'])}`);
    assert.ok(luma(['-ss', '2']) <= 19, `middle frame luma ${luma(['-ss', '2'])}`);
    assert.ok(luma(['-sseof', '-0.1']) <= 19, `last frame luma ${luma(['-sseof', '-0.1'])}`);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
