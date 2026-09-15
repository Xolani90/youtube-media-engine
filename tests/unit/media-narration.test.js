import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { synthesizeNarration, probeDurationSeconds } from '../../src/media/narration.js';

function tmpWavPath() {
  return path.join(os.tmpdir(), `narration-unit-${Date.now()}-${Math.random()}.wav`);
}

test('synthesizeNarration: produces an audio artifact with a measurable positive duration', () => {
  const outPath = tmpWavPath();
  try {
    synthesizeNarration('This is a short test narration.', outPath);
    assert.ok(fs.existsSync(outPath));
    assert.ok(fs.statSync(outPath).size > 0);

    const duration = probeDurationSeconds(outPath);
    assert.ok(Number.isFinite(duration));
    assert.ok(duration > 0);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});

test('synthesizeNarration: rejects empty/whitespace-only text without invoking the engine', () => {
  const outPath = tmpWavPath();
  assert.throws(() => synthesizeNarration('', outPath));
  assert.throws(() => synthesizeNarration('   ', outPath));
  assert.equal(fs.existsSync(outPath), false);
});

test('probeDurationSeconds: throws for a nonexistent file', () => {
  assert.throws(() => probeDurationSeconds(path.join(os.tmpdir(), `does-not-exist-${Date.now()}.wav`)));
});
