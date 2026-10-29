import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFfmpeg } from './ffmpegFailure.js';

// Photo-based thumbnail (worker capability): a graded still from the video's own
// first visual, a dark gradient on the text side, and the title in large type.
//
// SCOPE: image processing only. It uses an asset that already passed the D-G2
// rights re-check because it is the SAME file the render used (taken from the
// persisted render_spec); it never selects, fetches or authorises anything. Any
// failure throws and the caller falls back to the typography-only canvas
// thumbnail, so a thumbnail problem can never block publication.
//
// Output is PNG because the YouTube adapter uploads thumbnails as image/png.
// A result above YouTube's 2 MB limit is refused (caller falls back).

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BUNDLED_FONT = path.join(HERE, '..', '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
export const PHOTO_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;
const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;

/** THUMBNAIL_STYLE=photo (default) | canvas. */
export function resolveThumbnailStyle(env = process.env) {
  const v = (env.THUMBNAIL_STYLE ?? 'photo').trim().toLowerCase();
  if (v === '' || v === 'photo' || v === 'auto') return 'photo';
  if (v === 'canvas' || v === 'off') return 'canvas';
  throw new Error(`THUMBNAIL_STYLE must be one of photo, canvas (got "${v}")`);
}

/** Word-wraps to at most maxLines lines of at most maxChars; null if it cannot fit. */
export function wrapWords(text, maxChars, maxLines) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (w.length > maxChars) return null;
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length <= maxLines ? lines : null;
}

const SIZE_LADDER = [132, 118, 106, 94, 84, 74, 66, 58];
const CHAR_WIDTH_RATIO = 0.72; // conservative DejaVu Sans Bold uppercase advance / font size
const TEXT_BOX_WIDTH = 760;

/** Largest font size whose wrapped uppercase title fits in <= 3 lines (4 at the smallest size). */
export function layoutTitle(title) {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!t) throw new Error('thumbnail title is empty');
  for (const size of SIZE_LADDER) {
    const lines = wrapWords(t, Math.floor(TEXT_BOX_WIDTH / (CHAR_WIDTH_RATIO * size)), 3);
    if (lines) return { size, lines };
  }
  const size = SIZE_LADDER[SIZE_LADDER.length - 1];
  const lines = wrapWords(t, Math.floor(TEXT_BOX_WIDTH / (CHAR_WIDTH_RATIO * size)), 4);
  if (!lines) throw new Error('thumbnail title is too long for a legible thumbnail');
  return { size, lines };
}

/**
 * The first still image of a persisted render_spec that exists on disk, or null.
 * Pre-rendered motion clips are never in the persisted spec (only source images are).
 */
export function pickThumbnailImage(renderSpecJson) {
  let spec;
  try { spec = typeof renderSpecJson === 'string' ? JSON.parse(renderSpecJson) : renderSpecJson; } catch { return null; }
  for (const seg of spec?.visual_timing ?? []) {
    const loc = seg?.location;
    if (typeof loc === 'string' && IMAGE_EXT.test(loc) && fs.existsSync(loc)) return loc;
  }
  return null;
}

function probeImage(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  const v = (j.streams ?? []).find((s) => s.codec_type === 'video');
  if (!v) throw new Error('thumbnail source is not a decodable image');
  return v;
}

/** Pure: the -vf chain (bare file names; ffmpeg runs with cwd = a private work dir, so no drive-letter colons). */
export function buildThumbnailFilter({ size, lines, fontFile = 'font.ttf' }) {
  const gap = Math.round(size * 0.14);
  const blockHeight = lines.length * size + (lines.length - 1) * gap;
  const top = Math.max(90, Math.round((720 - blockHeight) / 2));
  const f = [
    'scale=1280:720:flags=lanczos+accurate_rnd:force_original_aspect_ratio=increase', 'crop=1280:720', 'format=gbrp',
    'colorbalance=rs=-0.04:bs=0.06:rh=0.06:bh=-0.05',
    "curves=all='0/0 0.22/0.17 0.75/0.82 1/1'",
    'eq=saturation=1.22:contrast=1.06', 'vignette=PI/4',
    // Darken the left side so the headline stays legible on any photo.
    "geq=r='r(X,Y)*(0.30+0.70*min(1,X/(W*0.66)))':g='g(X,Y)*(0.30+0.70*min(1,X/(W*0.66)))':b='b(X,Y)*(0.30+0.70*min(1,X/(W*0.66)))'",
    'format=yuv420p'
  ];
  lines.forEach((_, i) => {
    const y = top + i * (size + gap);
    const colour = i === lines.length - 1 ? '0xFFD21F' : 'white';
    f.push(`drawtext=fontfile=${fontFile}:textfile=l${i}.txt:expansion=none:fontsize=${size}:fontcolor=${colour}:borderw=7:bordercolor=black@0.9:shadowx=5:shadowy=5:shadowcolor=black@0.7:x=64:y=${y}`);
  });
  f.push(`drawbox=x=64:y=${top - 26}:w=170:h=9:color=0xFFD21F:t=fill`);
  return f.join(',');
}

/** Renders the photo thumbnail to outputPath (PNG, 1280x720). Throws on any problem. */
export function generateThumbnailFromImage({ title, imagePath, outputPath, fontPath = BUNDLED_FONT }) {
  if (!fs.existsSync(imagePath)) throw new Error(`thumbnail source not found: ${imagePath}`);
  if (!fs.existsSync(fontPath)) throw new Error(`thumbnail font not found: ${fontPath}`);
  probeImage(imagePath);
  const { size, lines } = layoutTitle(title);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-thumb-'));
  try {
    fs.copyFileSync(fontPath, path.join(work, 'font.ttf'));
    lines.forEach((line, i) => fs.writeFileSync(path.join(work, `l${i}.txt`), line, 'utf8'));
    runFfmpeg('thumbnail_photo', [
      '-y', '-hide_banner', '-nostdin', '-i', path.resolve(imagePath), '-frames:v', '1',
      '-vf', buildThumbnailFilter({ size, lines }), '-compression_level', '9', path.resolve(outputPath)
    ], { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
    const bytes = fs.statSync(outputPath).size;
    if (bytes > PHOTO_THUMBNAIL_MAX_BYTES) {
      fs.rmSync(outputPath, { force: true });
      throw new Error(`photo thumbnail is ${bytes} bytes, above the ${PHOTO_THUMBNAIL_MAX_BYTES} byte limit`);
    }
    return { bytes, size, lines };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
