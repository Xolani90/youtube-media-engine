import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase 2B: deterministic YouTube thumbnail generation.
 *
 * Uses the existing FFmpeg installation already relied on throughout
 * Media Production (see ./render.js, ./narration.js) — no new
 * dependency, no AI image provider, no external image API. A single
 * 1280x720 PNG frame is synthesized from FFmpeg's `color` lavfi source
 * plus one `drawtext` filter per wrapped line of the title, rendered
 * with a DejaVu Sans Bold font file bundled in this repository (see
 * assets/fonts/DejaVuSans-Bold.ttf) and referenced via `fontfile=`
 * rather than relying on the host's fontconfig to resolve a
 * `font='DejaVu Sans'` family name -- that family lookup succeeds on
 * Linux/CI (where the family happens to be installed) but is not
 * guaranteed to resolve on Windows, which previously made thumbnail
 * generation host-dependent.
 *
 * Deterministic by construction: identical title text always produces
 * an identical filter graph and therefore identical output bytes (no
 * randomness, no timestamps, no clock-dependent input anywhere in the
 * command). Text layout borrows the donor repository's useful, purely
 * layout-level patterns (fixed 1280x720 canvas, safe bottom margin,
 * iterative font-size fitting, deterministic wrapping) — implemented
 * here from scratch against FFmpeg, not transplanted code.
 *
 * Primary renderer (Stage A thumbnail donor): a local, replaceable
 * @napi-rs/canvas worker (./thumbnailCanvasWorker.js) draws a gradient
 * background, accent graphics and fitted typography from the title alone,
 * in a child process with a bounded timeout and a narrow JSON contract.
 * The FFmpeg renderer described above is the fallback: ANY canvas failure
 * (timeout, crash, missing/unloadable native binary, malformed or invalid
 * output, glyphs the bundled font lacks) falls back to it, so thumbnail
 * generation behaves exactly as before whenever the donor is unavailable.
 * Set THUMBNAIL_RENDERER=ffmpeg to bypass the canvas worker entirely.
 */

export const THUMBNAIL_WIDTH = 1280;
export const THUMBNAIL_HEIGHT = 720;

// Safe-area margins (donor pattern: avoid clipping, avoid the
// YouTube-chrome bottom strip where duration/progress UI is overlaid).
const MARGIN_X = 72;
const MARGIN_TOP = 72;
const MARGIN_BOTTOM = 110;
const MAX_LINES = 4;
const LINE_GAP = 14;

// Iterative font-fitting ladder (donor pattern), largest first.
const FONT_SIZE_STEPS = [110, 96, 84, 72, 60, 50, 42, 36, 30];
const MIN_FONT_SIZE = 30;

// DejaVu Sans Bold is a near-monospace-width-predictable sans font;
// this average-advance-width ratio (relative to font size) is a
// deliberately conservative, deterministic estimate used only to
// decide wrapping/fitting locally -- FFmpeg itself does the actual
// glyph rendering, so a slightly conservative estimate only ever
// produces safe (never clipped) layouts, never microscopic text.
const AVG_CHAR_WIDTH_RATIO = 0.62;

const BACKGROUND_COLOR = '0x14181f';
const TEXT_COLOR = 'white';

// Bundled font (portability fix): rather than depend on the host's
// fontconfig resolving the family name 'DejaVu Sans' (present on
// Linux/CI, not guaranteed on Windows), drawtext is pointed at this
// repository-local font file. Resolved relative to this module's own
// location, not process.cwd(), so it works regardless of the caller's
// working directory.
const FONT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'fonts');
const FONT_FILENAME = 'DejaVuSans-Bold.ttf';

// Windows-specific fix (same pattern as ./render.js's `subtitles` filter
// handling): FFmpeg's filtergraph parser splits an option value on any
// colon it encounters, so an absolute Windows path like
// 'C:\...\DejaVuSans-Bold.ttf' can never appear inside the filtergraph
// itself. Instead, FFmpeg's working directory is set to the font's own
// directory (see generateThumbnail below) and only the bare, colon-free
// filename is referenced in `fontfile=`.
function escapeFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

function estimateTextWidth(text, fontSize) {
  return text.length * fontSize * AVG_CHAR_WIDTH_RATIO;
}

/** Deterministic greedy word-wrap against an estimated pixel width. */
function wrapText(title, fontSize, maxWidth) {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

/**
 * Iterative font fitting (donor pattern): try each font size, largest
 * first, wrapping at that size; accept the first size whose wrapped
 * line count fits MAX_LINES and whose block height fits the safe area.
 * Falls back to the smallest size with a truncated, ellipsized final
 * line rather than ever shrinking below MIN_FONT_SIZE or overflowing
 * the canvas.
 */
function fitTitle(title) {
  const maxWidth = THUMBNAIL_WIDTH - 2 * MARGIN_X;
  const maxBlockHeight = THUMBNAIL_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

  for (const fontSize of FONT_SIZE_STEPS) {
    const lines = wrapText(title, fontSize, maxWidth);
    const lineHeight = fontSize * 1.15;
    const blockHeight = lines.length * lineHeight + (lines.length - 1) * LINE_GAP;
    if (lines.length <= MAX_LINES && blockHeight <= maxBlockHeight) {
      return { fontSize, lines, lineHeight };
    }
  }

  // Fallback: smallest size, hard-capped to MAX_LINES, last visible
  // line ellipsized rather than clipped or overflowed.
  const fontSize = MIN_FONT_SIZE;
  let lines = wrapText(title, fontSize, maxWidth).slice(0, MAX_LINES);
  const lastIndex = lines.length - 1;
  if (lastIndex >= 0) {
    let last = lines[lastIndex];
    while (estimateTextWidth(`${last}…`, fontSize) > maxWidth && last.length > 1) {
      last = last.slice(0, -1);
    }
    lines[lastIndex] = `${last}…`;
  }
  const lineHeight = fontSize * 1.15;
  return { fontSize, lines, lineHeight };
}

/** Escapes text for safe use inside an FFmpeg drawtext filter's `text=` argument (colons, backslashes, quotes, percent signs). */
function escapeDrawtext(text) {
  return text
    .replace(/\\/g, '\\\\\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\u2019')
    // The filtergraph parser consumes one backslash before drawtext sees the
    // value, so percent needs two here to reach drawtext as an escaped `%`.
    .replace(/%/g, '\\\\%');
}

/**
 * Builds the deterministic FFmpeg filter_complex graph for a fitted
 * title: one `color` background source plus one `drawtext` per line,
 * each horizontally centered (FFmpeg's own `(w-text_w)/2` expression --
 * exact glyph metrics, not the estimate used for wrapping/fitting
 * above) and vertically stacked, centered as a block within the safe
 * area.
 */
function buildFilterGraph({ fontSize, lines, lineHeight }) {
  const blockHeight = lines.length * lineHeight + (lines.length - 1) * LINE_GAP;
  const safeAreaHeight = THUMBNAIL_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const startY = MARGIN_TOP + Math.max(0, (safeAreaHeight - blockHeight) / 2);

  const drawtextFilters = lines.map((line, i) => {
    const y = Math.round(startY + i * (lineHeight + LINE_GAP));
    const escaped = escapeDrawtext(line);
    const escapedFontFile = escapeFilterPath(FONT_FILENAME);
    return (
      `drawtext=fontfile='${escapedFontFile}':text='${escaped}':fontcolor=${TEXT_COLOR}:` +
      `fontsize=${fontSize}:borderw=4:bordercolor=black@0.85:` +
      `x=(w-text_w)/2:y=${y}`
    );
  });

  return drawtextFilters.join(',');
}

/** Existing FFmpeg renderer, unchanged in behavior; now the fallback. */
export function generateThumbnailFfmpeg(title, outputPath) {
  const fitted = fitTitle(title);
  const drawtextChain = buildFilterGraph(fitted);

  execFileSync('ffmpeg', [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${BACKGROUND_COLOR}:s=${THUMBNAIL_WIDTH}x${THUMBNAIL_HEIGHT}:d=1`,
    '-vf', drawtextChain,
    '-frames:v', '1',
    path.resolve(outputPath)
  ], { stdio: ['ignore', 'ignore', 'pipe'], cwd: FONT_DIR });

  return outputPath;
}

// ---- Canvas worker (primary renderer) -------------------------------------

const CANVAS_WORKER = fileURLToPath(new URL('./thumbnailCanvasWorker.js', import.meta.url));
const WORKER_CONTRACT_VERSION = 1;
export const DEFAULT_CANVAS_TIMEOUT_MS = 20_000;
// YouTube thumbnails.set maximum file size: 2MB (developers.google.com/youtube/v3/docs/thumbnails/set).
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
// SHA-256 of the bundled DejaVu Sans Bold font: the canvas worker only ever
// loads this verified file, never a system font.
export const BUNDLED_FONT_SHA256 = '5c1247acef7f2b8522a31742c76d6adcb5569bacc0be7ceaa4dc39dd252ce895';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class CanvasWorkerError extends Error {
  constructor(reason, detail) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

let verifiedFontPath = null;

function verifyBundledFont() {
  const fontPath = path.join(FONT_DIR, FONT_FILENAME);
  if (verifiedFontPath === fontPath) return fontPath;
  let bytes;
  try {
    bytes = fs.readFileSync(fontPath);
  } catch (err) {
    throw new CanvasWorkerError('FONT_MISSING', err.message);
  }
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== BUNDLED_FONT_SHA256) {
    throw new CanvasWorkerError('FONT_CHECKSUM_MISMATCH', FONT_FILENAME);
  }
  verifiedFontPath = fontPath;
  return fontPath;
}

function short(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** Parent-side validation of what the worker claims it wrote. Throws CanvasWorkerError. */
function validateWorkerOutput(stdout, outputPath) {
  const lastLine = String(stdout).split('\n').map((l) => l.trim()).filter(Boolean).at(-1);
  let msg;
  try {
    msg = JSON.parse(lastLine);
  } catch {
    throw new CanvasWorkerError('WORKER_OUTPUT_MALFORMED', short(lastLine ?? 'no output'));
  }
  if (msg === null || typeof msg !== 'object') throw new CanvasWorkerError('WORKER_OUTPUT_MALFORMED', 'not an object');
  if (msg.ok !== true) throw new CanvasWorkerError(typeof msg.reason === 'string' ? msg.reason : 'WORKER_REPORTED_FAILURE', short(msg.detail));
  if (msg.width !== THUMBNAIL_WIDTH || msg.height !== THUMBNAIL_HEIGHT || !Number.isInteger(msg.bytes) || !/^[0-9a-f]{64}$/.test(msg.sha256 ?? '')) {
    throw new CanvasWorkerError('WORKER_OUTPUT_MALFORMED', 'unexpected result fields');
  }
  let bytes;
  try {
    bytes = fs.readFileSync(outputPath);
  } catch {
    throw new CanvasWorkerError('WORKER_OUTPUT_MISSING', 'worker reported success but wrote no file');
  }
  if (bytes.length === 0 || bytes.length > MAX_THUMBNAIL_BYTES) throw new CanvasWorkerError('OUTPUT_INVALID', `size ${bytes.length}`);
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.readUInt32BE(16) !== THUMBNAIL_WIDTH || bytes.readUInt32BE(20) !== THUMBNAIL_HEIGHT) {
    throw new CanvasWorkerError('OUTPUT_INVALID', 'not a 1280x720 PNG');
  }
  if (bytes.length !== msg.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== msg.sha256) {
    throw new CanvasWorkerError('OUTPUT_INVALID', 'file does not match worker-reported checksum');
  }
}

function runCanvasWorker(title, outputPath, { workerScript = CANVAS_WORKER, timeoutMs = DEFAULT_CANVAS_TIMEOUT_MS } = {}) {
  const fontPath = verifyBundledFont();
  const request = JSON.stringify({ version: WORKER_CONTRACT_VERSION, title, outputPath: path.resolve(outputPath), fontPath });
  const run = spawnSync(process.execPath, [workerScript], {
    input: request,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  if (run.error) {
    if (run.error.code === 'ETIMEDOUT') throw new CanvasWorkerError('WORKER_TIMEOUT', `exceeded ${timeoutMs}ms`);
    throw new CanvasWorkerError('WORKER_SPAWN_FAILED', short(run.error.message));
  }
  if (run.signal) throw new CanvasWorkerError('WORKER_CRASHED', `terminated by ${run.signal}`);
  try {
    validateWorkerOutput(run.stdout, path.resolve(outputPath));
  } catch (err) {
    if (err instanceof CanvasWorkerError && err.reason === 'WORKER_OUTPUT_MALFORMED' && run.status !== 0) {
      throw new CanvasWorkerError('WORKER_CRASHED', `exit ${run.status}: ${short(run.stderr)}`);
    }
    throw err;
  }
}

/**
 * Same contract as generateThumbnail, but also reports which renderer produced
 * the file and, when the canvas worker was bypassed, why.
 *
 * @param {string} title
 * @param {string} outputPath
 * @param {{ renderer?: 'canvas'|'ffmpeg', workerScript?: string, timeoutMs?: number }} [options]
 * @returns {{ outputPath: string, renderer: 'canvas'|'ffmpeg', fallbackReason: string|null }}
 */
export function generateThumbnailDetailed(title, outputPath, options = {}) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('thumbnail_generation_requires_non_empty_title');
  }
  const renderer = options.renderer ?? (process.env.THUMBNAIL_RENDERER === 'ffmpeg' ? 'ffmpeg' : 'canvas');
  let fallbackReason = renderer === 'ffmpeg' ? 'RENDERER_FORCED_FFMPEG' : null;
  if (renderer === 'canvas') {
    try {
      runCanvasWorker(title, outputPath, options);
      return { outputPath, renderer: 'canvas', fallbackReason: null };
    } catch (err) {
      fallbackReason = err instanceof CanvasWorkerError ? err.message : `UNEXPECTED: ${short(err?.message)}`;
      // Never leave a partial/invalid canvas file behind; FFmpeg then writes the final bytes.
      fs.rmSync(path.resolve(outputPath), { force: true });
    }
  }
  generateThumbnailFfmpeg(title, outputPath);
  return { outputPath, renderer: 'ffmpeg', fallbackReason };
}

/**
 * Generates a deterministic 1280x720 PNG thumbnail for the given
 * (already-normalized -- see ./metadataValidation.js) title, writing it
 * to `outputPath` (caller is responsible for the existing
 * tmp-path-then-atomic-rename convention -- see
 * ./artifactStore.js#finalizeArtifact -- this function only writes the
 * final bytes to whatever path it is given).
 *
 * Never calls an LLM or any external service; the only input is the
 * already-authoritative title string. Uses the canvas worker when it
 * works and the FFmpeg renderer otherwise (see generateThumbnailDetailed).
 *
 * @param {string} title
 * @param {string} outputPath
 */
export function generateThumbnail(title, outputPath) {
  return generateThumbnailDetailed(title, outputPath).outputPath;
}

export default generateThumbnail;
