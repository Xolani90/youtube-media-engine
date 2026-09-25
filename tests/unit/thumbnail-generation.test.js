import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { generateThumbnail, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT } from '../../src/media/thumbnail.js';

function tmpPngPath() {
  return path.join(os.tmpdir(), `thumb-test-${crypto.randomUUID()}.png`);
}

function probe(pngPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name',
    '-of', 'default=noprint_wrappers=1', pngPath
  ]).toString();
  const width = Number(/width=(\d+)/.exec(out)?.[1]);
  const height = Number(/height=(\d+)/.exec(out)?.[1]);
  const codec = /codec_name=(\S+)/.exec(out)?.[1];
  return { width, height, codec };
}

test('produces a 1280x720 PNG for a short title', () => {
  const out = tmpPngPath();
  generateThumbnail('Short Title', out);
  assert.ok(fs.existsSync(out));
  const { width, height, codec } = probe(out);
  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, THUMBNAIL_HEIGHT);
  assert.equal(codec, 'png');
  fs.rmSync(out, { force: true });
});

test('produces a valid 1280x720 image for a long, multi-line title', () => {
  const out = tmpPngPath();
  const longTitle = 'This is a considerably longer video title that will need to wrap across several lines to stay readable';
  generateThumbnail(longTitle, out);
  const { width, height } = probe(out);
  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, THUMBNAIL_HEIGHT);
  fs.rmSync(out, { force: true });
});

test('handles titles with punctuation and special drawtext characters (colons, percent, quotes, backslash)', () => {
  const out = tmpPngPath();
  generateThumbnail(`Colons: percent %100 'quotes' and a \\ backslash`, out);
  const { width, height } = probe(out);
  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, THUMBNAIL_HEIGHT);
  fs.rmSync(out, { force: true });
});

test('handles Unicode titles', () => {
  const out = tmpPngPath();
  generateThumbnail('Déjà vu — Ünïcödé Tëst 日本語テスト', out);
  const { width, height } = probe(out);
  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, THUMBNAIL_HEIGHT);
  fs.rmSync(out, { force: true });
});

test('produces a valid image for an extremely long title (forced ellipsis truncation, never overflow)', () => {
  const out = tmpPngPath();
  const extremeTitle = 'word '.repeat(80).trim();
  generateThumbnail(extremeTitle, out);
  const { width, height } = probe(out);
  assert.equal(width, THUMBNAIL_WIDTH);
  assert.equal(height, THUMBNAIL_HEIGHT);
  fs.rmSync(out, { force: true });
});

test('deterministic: identical title produces byte-identical output', () => {
  const outA = tmpPngPath();
  const outB = tmpPngPath();
  generateThumbnail('Determinism Check Title', outA);
  generateThumbnail('Determinism Check Title', outB);
  const hashA = crypto.createHash('sha256').update(fs.readFileSync(outA)).digest('hex');
  const hashB = crypto.createHash('sha256').update(fs.readFileSync(outB)).digest('hex');
  assert.equal(hashA, hashB);
  fs.rmSync(outA, { force: true });
  fs.rmSync(outB, { force: true });
});

test('different titles produce different output', () => {
  const outA = tmpPngPath();
  const outB = tmpPngPath();
  generateThumbnail('Title One', outA);
  generateThumbnail('Title Two, Completely Different', outB);
  const hashA = crypto.createHash('sha256').update(fs.readFileSync(outA)).digest('hex');
  const hashB = crypto.createHash('sha256').update(fs.readFileSync(outB)).digest('hex');
  assert.notEqual(hashA, hashB);
  fs.rmSync(outA, { force: true });
  fs.rmSync(outB, { force: true });
});

test('throws on empty title rather than producing a blank/invalid thumbnail', () => {
  const out = tmpPngPath();
  assert.throws(() => generateThumbnail('', out));
  assert.throws(() => generateThumbnail('   ', out));
  fs.rmSync(out, { force: true });
});

test('throws for non-string input', () => {
  const out = tmpPngPath();
  assert.throws(() => generateThumbnail(null, out));
  assert.throws(() => generateThumbnail(undefined, out));
});