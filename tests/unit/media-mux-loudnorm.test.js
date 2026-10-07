import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { muxNarration, LOUDNORM_TARGETS } from '../../src/media/render.js';

// Real-FFmpeg test (no database, no network). Skipped where ffmpeg is absent.
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

function measureIntegratedLufs(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = [...r.stderr.matchAll(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)].pop();
  return m ? Number(m[1]) : NaN;
}

function build(dir, amp) {
  const v = path.join(dir, 'v.mp4');
  const a = path.join(dir, 'a.wav');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=8:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `anoisesrc=d=8:c=pink:r=22050:a=${amp}`, '-ac', '1', a]);
  return { v, a };
}

test('muxNarration normalizes a quiet narration near the loudness target, 48 kHz AAC, duration preserved', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-loudnorm-'));
  try {
    const { v, a } = build(dir, 0.02);
    const before = measureIntegratedLufs(a);
    const out = path.join(dir, 'out.mp4');
    muxNarration({ silentVideoPath: v, narrationPath: a, audioEncoder: 'aac', outputPath: out });
    const after = measureIntegratedLufs(out);
    assert.ok(before < -30, `fixture should be quiet, was ${before}`);
    assert.ok(Math.abs(after - LOUDNORM_TARGETS.I) <= 1.5, `integrated ${after} LUFS not within 1.5 of ${LOUDNORM_TARGETS.I}`);
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out]).toString());
    const audio = probe.streams.find((s) => s.codec_type === 'audio');
    assert.equal(audio.codec_name, 'aac');
    assert.equal(Number(audio.sample_rate), 48000);
    assert.ok(Math.abs(Number(probe.format.duration) - 8) < 0.3);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('normalizeLoudness:false keeps the previous pass-through behaviour', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-loudnorm-off-'));
  try {
    const { v, a } = build(dir, 0.02);
    const out = path.join(dir, 'out.mp4');
    muxNarration({ silentVideoPath: v, narrationPath: a, audioEncoder: 'aac', outputPath: out, normalizeLoudness: false });
    assert.ok(measureIntegratedLufs(out) < -30);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a very short narration still muxes with a valid audio stream (no loudnorm failure)', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-loudnorm-short-'));
  try {
    const v = path.join(dir, 'v.mp4'); const a = path.join(dir, 'a.wav'); const out = path.join(dir, 'out.mp4');
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=0.6:r=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', v]);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=300:d=0.6:r=22050', '-ac', '1', a]);
    muxNarration({ silentVideoPath: v, narrationPath: a, audioEncoder: 'aac', outputPath: out });
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', out]).toString());
    assert.ok(probe.streams.some((s) => s.codec_type === 'audio'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
