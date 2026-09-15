import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateMediaArtifact } from '../../src/media/validate.js';

const EXPECTED = { width: 320, height: 240, videoCodecName: 'h264', audioCodecName: 'aac' };

function tmpPath(name) {
  return path.join(os.tmpdir(), `media-validate-${Date.now()}-${Math.random()}-${name}`);
}

function makeValidMp4() {
  const out = tmpPath('valid.mp4');
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-y', out
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

function makeVideoOnlyMp4() {
  const out = tmpPath('video-only.mp4');
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=red:s=320x240:d=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-y', out
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

function makeAudioOnlyMp4() {
  const out = tmpPath('audio-only.m4a');
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:a', 'aac',
    '-y', out
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

function makeWrongResolutionMp4() {
  const out = tmpPath('wrong-res.mp4');
  execFileSync('ffmpeg', [
    '-f', 'lavfi', '-i', 'color=c=green:s=640x480:d=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-y', out
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
}

test('validateMediaArtifact: accepts a valid MP4 matching expected codecs/resolution', () => {
  const file = makeValidMp4();
  try {
    const result = validateMediaArtifact(file, EXPECTED);
    assert.equal(result.valid, true);
    assert.ok(result.duration > 0);
    assert.equal(result.width, 320);
    assert.equal(result.height, 240);
    assert.equal(result.videoCodec, 'h264');
    assert.equal(result.audioCodec, 'aac');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('validateMediaArtifact: rejects a missing file', () => {
  const result = validateMediaArtifact(path.join(os.tmpdir(), `nope-${Date.now()}.mp4`), EXPECTED);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'FILE_MISSING');
});

test('validateMediaArtifact: rejects an empty file', () => {
  const file = tmpPath('empty.mp4');
  fs.writeFileSync(file, '');
  try {
    const result = validateMediaArtifact(file, EXPECTED);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'FILE_EMPTY');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('validateMediaArtifact: rejects a corrupt/non-media file', () => {
  const file = tmpPath('corrupt.mp4');
  fs.writeFileSync(file, 'not a real video file, just garbage bytes');
  try {
    const result = validateMediaArtifact(file, EXPECTED);
    assert.equal(result.valid, false);
    assert.ok(result.reason.startsWith('FFPROBE_FAILED_') || result.reason === 'INVALID_DURATION' || result.reason === 'NO_VIDEO_STREAM');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('validateMediaArtifact: rejects a file missing an audio stream', () => {
  const file = makeVideoOnlyMp4();
  try {
    const result = validateMediaArtifact(file, EXPECTED);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'NO_AUDIO_STREAM');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('validateMediaArtifact: rejects a file missing a video stream', () => {
  const file = makeAudioOnlyMp4();
  try {
    const result = validateMediaArtifact(file, EXPECTED);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'NO_VIDEO_STREAM');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('validateMediaArtifact: rejects a file with an unexpected resolution', () => {
  const file = makeWrongResolutionMp4();
  try {
    const result = validateMediaArtifact(file, EXPECTED);
    assert.equal(result.valid, false);
    assert.ok(result.reason.startsWith('UNEXPECTED_RESOLUTION_'));
  } finally {
    fs.rmSync(file, { force: true });
  }
});
