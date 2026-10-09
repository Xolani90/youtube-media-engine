#!/usr/bin/env node
// Produces real thumbnails through the production code path (generateThumbnailDetailed) and verifies
// them: renderer used, PNG signature, 1280x720, size vs the 2MB YouTube API limit, SHA-256, and
// determinism across two independent worker runs. Exits non-zero unless the CANVAS renderer produced
// every file (a silent FFmpeg fallback is a failure of this proof, not a pass).
//
// usage: node scripts/prove-thumbnail-canvas.js [outputDir]     (default: ./tmp/thumbnail-proof)
// No network, no credentials, no publication.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { generateThumbnailDetailed, generateThumbnailFfmpeg, MAX_THUMBNAIL_BYTES } from '../src/media/thumbnail.js';

const outDir = path.resolve(process.argv[2] ?? path.join('tmp', 'thumbnail-proof'));
fs.mkdirSync(outDir, { recursive: true });

const SAMPLES = [
  ['short', 'Short Title'],
  ['hook', 'Why 50% of AI Startups Fail: The Real Reason'],
  ['long', 'This is a considerably longer video title that will need to wrap across several lines to stay readable'],
  ['special', `Colons: 100% "quotes" and 'apostrophes' & more`]
];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rows = [];
let failed = false;

for (const [name, title] of SAMPLES) {
  const file = path.join(outDir, `${name}.canvas.png`);
  const again = path.join(outDir, `${name}.canvas.repeat.png`);
  const r = generateThumbnailDetailed(title, file);
  generateThumbnailDetailed(title, again);
  const bytes = fs.readFileSync(file);
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const deterministic = sha256(file) === sha256(again);
  fs.rmSync(again);
  const ok = r.renderer === 'canvas' && isPng && width === 1280 && height === 720 && bytes.length <= MAX_THUMBNAIL_BYTES && deterministic;
  if (!ok) failed = true;
  rows.push({ name, title, renderer: r.renderer, fallbackReason: r.fallbackReason, png: isPng, width, height, bytes: bytes.length, sha256: sha256(file), deterministic, ok });
}

// Side-by-side baseline from the preserved FFmpeg renderer, for visual comparison only.
generateThumbnailFfmpeg(SAMPLES[1][1], path.join(outDir, 'hook.ffmpeg-baseline.png'));

console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, node: process.version, outDir, rows }, null, 2));
if (failed) {
  console.error('PROOF FAILED: at least one thumbnail was not produced by the canvas renderer or failed verification');
  process.exit(1);
}
