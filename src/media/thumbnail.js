import { execFileSync } from 'node:child_process';
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
    .replace(/%/g, '\\%');
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

/**
 * Generates a deterministic 1280x720 PNG thumbnail for the given
 * (already-normalized -- see ./metadataValidation.js) title, writing it
 * to `outputPath` (caller is responsible for the existing
 * tmp-path-then-atomic-rename convention -- see
 * ./artifactStore.js#finalizeArtifact -- this function only writes the
 * final bytes to whatever path it is given).
 *
 * Never calls an LLM or any external service; the only input is the
 * already-authoritative title string.
 *
 * @param {string} title
 * @param {string} outputPath
 */
export function generateThumbnail(title, outputPath) {
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw new Error('thumbnail_generation_requires_non_empty_title');
  }
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

export default generateThumbnail;