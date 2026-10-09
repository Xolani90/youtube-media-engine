/**
 * Deterministic typography-and-graphics thumbnail renderer.
 *
 * Donor: @napi-rs/canvas (MIT, Skia bindings), used ONLY as a local 2D drawing
 * surface. This module is loaded exclusively inside the child process started
 * by ./thumbnailCanvasWorker.js (see ./thumbnail.js); the engine never imports
 * it directly, so a missing/broken native binary can never crash the engine.
 *
 * Inputs: the title string and the path of the bundled font. Nothing else.
 * No imagery, no image decoding, no network, no system fonts: the font is
 * registered from an explicit local path under a private family name, and
 * only drawing primitives (gradients, rectangles, text) are used.
 *
 * Deterministic by construction: no randomness, no clock, no locale-dependent
 * calls in layout; identical (title, font) -> identical layout and PNG bytes in
 * the same supported environment.
 */
import { loadGlyphCoverage, findUnsupportedCodePoints } from './fontGlyphs.js';
import fs from 'node:fs';

const { createCanvas, GlobalFonts } = await import('@napi-rs/canvas');

export const WIDTH = 1280;
export const HEIGHT = 720;
export const FONT_FAMILY = 'YMEThumbBold';

// Safe area: avoids clipping and YouTube's bottom-right duration badge.
export const MARGIN_TOP = 72;
export const MARGIN_BOTTOM = 110;
export const MARGIN_RIGHT = 72;
const ACCENT_BAR_X = 72;
const ACCENT_BAR_W = 14;
const TEXT_X = ACCENT_BAR_X + ACCENT_BAR_W + 34;
export const MAX_TEXT_WIDTH = WIDTH - TEXT_X - MARGIN_RIGHT;
const RULE_GAP = 30;
const RULE_H = 10;
const RULE_W = 240;

export const MAX_LINES = 4;
export const FONT_SIZE_STEPS = [124, 112, 100, 90, 80, 70, 62, 54, 48, 42, 36, 32];
export const MIN_FONT_SIZE = 32;
const LINE_HEIGHT_RATIO = 1.12;
const LINE_GAP = 10;

export const COLORS = {
  gradientFrom: '#0a0f1e',
  gradientTo: '#173152',
  glow: 'rgba(255, 200, 61, 0.14)',
  glowEdge: 'rgba(255, 200, 61, 0)',
  text: '#ffffff',
  textOutline: 'rgba(0, 0, 0, 0.55)',
  accent: '#ffc83d'
};

const STOPWORDS = new Set([
  'about', 'after', 'again', 'being', 'could', 'every', 'first', 'from', 'have', 'into', 'just', 'more',
  'most', 'much', 'only', 'other', 'over', 'should', 'since', 'some', 'still', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'until', 'very',
  'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'whose', 'will', 'with', 'would', 'your'
]);

let fontRegistered = null;

function registerFont(fontPath) {
  if (fontRegistered === fontPath) return;
  const key = GlobalFonts.registerFromPath(fontPath, FONT_FAMILY);
  if (!key || !GlobalFonts.has(FONT_FAMILY)) throw new Error('font_registration_failed');
  fontRegistered = fontPath;
}

/** NFC-normalizes, drops control characters and collapses whitespace. */
export function normalizeTitle(title) {
  return String(title)
    .normalize('NFC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function graphemes(text) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

/**
 * Picks at most one word to emphasize, deterministically and only when the
 * title is long enough for emphasis to mean something (>= 3 words): the first
 * word containing a digit (a number/percentage/year is the usual hook),
 * otherwise the longest non-stopword alphabetic word of >= 6 letters (ties ->
 * earliest). Returns the word index or -1.
 */
export function pickEmphasisIndex(words) {
  if (words.length < 3) return -1;
  const numeric = words.findIndex((w) => /\d/.test(w));
  if (numeric !== -1) return numeric;
  let best = -1;
  let bestLen = 0;
  words.forEach((w, i) => {
    const core = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (core.length < 6 || !/^\p{L}+$/u.test(core) || STOPWORDS.has(core.toLowerCase())) return;
    if (core.length > bestLen) { best = i; bestLen = core.length; }
  });
  return best;
}

/** Greedy wrap of word tokens by measured width. Returns null if any single token cannot fit on a line. */
function wrapTokens(tokens, measure, spaceWidth, maxWidth) {
  const lines = [];
  let line = [];
  let width = 0;
  for (const tok of tokens) {
    const w = measure(tok.text);
    if (w > maxWidth) return null;
    const next = line.length === 0 ? w : width + spaceWidth + w;
    if (next <= maxWidth) { line.push(tok); width = next; } else { lines.push(line); line = [tok]; width = w; }
  }
  if (line.length) lines.push(line);
  return lines;
}

/** Splits any token wider than maxWidth into grapheme chunks that each fit (used only at the minimum font size). */
function breakLongTokens(tokens, measure, maxWidth) {
  const out = [];
  for (const tok of tokens) {
    if (measure(tok.text) <= maxWidth) { out.push(tok); continue; }
    let chunk = '';
    for (const g of graphemes(tok.text)) {
      if (chunk && measure(chunk + g) > maxWidth) { out.push({ text: chunk, emphasized: tok.emphasized }); chunk = g; } else chunk += g;
    }
    if (chunk) out.push({ text: chunk, emphasized: tok.emphasized });
  }
  return out;
}

function blockHeight(lineCount, fontSize) {
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  return lineCount * lineHeight + (lineCount - 1) * LINE_GAP;
}

const SAFE_HEIGHT = HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;

function fits(lineCount, fontSize) {
  return lineCount <= MAX_LINES && blockHeight(lineCount, fontSize) + RULE_GAP + RULE_H <= SAFE_HEIGHT;
}

/**
 * Computes the layout for a title using real glyph metrics from the registered
 * font. Pure given (title, font): no drawing.
 */
export function computeLayout(title, ctx) {
  const text = normalizeTitle(title);
  if (!text) throw new Error('empty_title');
  const words = text.split(' ');
  const emphasisIndex = pickEmphasisIndex(words);
  const baseTokens = words.map((w, i) => ({ text: w, emphasized: i === emphasisIndex }));

  for (const fontSize of FONT_SIZE_STEPS) {
    ctx.font = `${fontSize}px ${FONT_FAMILY}`;
    const measure = (s) => ctx.measureText(s).width;
    const lines = wrapTokens(baseTokens, measure, measure(' '), MAX_TEXT_WIDTH);
    if (lines && fits(lines.length, fontSize)) {
      return { text, fontSize, lines, truncated: false, emphasisWord: emphasisIndex === -1 ? null : words[emphasisIndex] };
    }
  }

  // Nothing fits at any size: minimum size, break over-long words, cap at MAX_LINES and ellipsize.
  const fontSize = MIN_FONT_SIZE;
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  const measure = (s) => ctx.measureText(s).width;
  const spaceWidth = measure(' ');
  const tokens = breakLongTokens(baseTokens, measure, MAX_TEXT_WIDTH);
  let lines = wrapTokens(tokens, measure, spaceWidth, MAX_TEXT_WIDTH);
  let truncated = false;
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    truncated = true;
  }
  if (truncated) {
    const lineWidth = (l) => l.reduce((acc, t, i) => acc + measure(t.text) + (i ? spaceWidth : 0), 0);
    const last = lines[MAX_LINES - 1].map((t) => ({ ...t }));
    for (;;) {
      const tail = last[last.length - 1];
      const candidate = [...last.slice(0, -1), { text: `${tail.text}…`, emphasized: tail.emphasized }];
      if (lineWidth(candidate) <= MAX_TEXT_WIDTH) { lines[MAX_LINES - 1] = candidate; break; }
      const trimmed = graphemes(tail.text).slice(0, -1).join('');
      if (trimmed) last[last.length - 1] = { text: trimmed, emphasized: tail.emphasized };
      else if (last.length > 1) last.pop();
      else { lines[MAX_LINES - 1] = [{ text: '…', emphasized: false }]; break; }
    }
  }
  return { text, fontSize, lines, truncated, emphasisWord: emphasisIndex === -1 ? null : words[emphasisIndex] };
}

function drawBackground(ctx) {
  const g = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  g.addColorStop(0, COLORS.gradientFrom);
  g.addColorStop(1, COLORS.gradientTo);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  // One faint soft highlight, kept off the text column.
  const glow = ctx.createRadialGradient(WIDTH - 170, 190, 0, WIDTH - 170, 190, 360);
  glow.addColorStop(0, COLORS.glow);
  glow.addColorStop(1, COLORS.glowEdge);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

function drawLayout(ctx, layout) {
  const { fontSize, lines } = layout;
  const lineHeight = fontSize * LINE_HEIGHT_RATIO;
  const textBlock = blockHeight(lines.length, fontSize);
  const total = textBlock + RULE_GAP + RULE_H;
  const top = MARGIN_TOP + Math.max(0, (SAFE_HEIGHT - total) / 2);

  // Accent bar spans the text block.
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(ACCENT_BAR_X, Math.round(top), ACCENT_BAR_W, Math.round(textBlock));

  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(4, Math.round(fontSize * 0.07));
  const spaceWidth = ctx.measureText(' ').width;
  lines.forEach((line, row) => {
    const y = Math.round(top + row * (lineHeight + LINE_GAP));
    let x = TEXT_X;
    for (const tok of line) {
      ctx.strokeStyle = COLORS.textOutline;
      ctx.strokeText(tok.text, x, y);
      ctx.fillStyle = tok.emphasized ? COLORS.accent : COLORS.text;
      ctx.fillText(tok.text, x, y);
      x += ctx.measureText(tok.text).width + spaceWidth;
    }
  });

  // Accent rule under the block.
  ctx.fillStyle = COLORS.accent;
  ctx.fillRect(TEXT_X, Math.round(top + textBlock + RULE_GAP), RULE_W, RULE_H);

  return { top, textBlock, total };
}

/**
 * @param {string} title
 * @param {{ fontPath: string }} opts
 * @returns {{ png: Buffer, layout: object, unsupported: number[] }} `png` is null when the
 *   title needs glyphs the bundled font does not contain (never rendered with .notdef boxes).
 */
export function renderThumbnail(title, { fontPath }) {
  const fontBuffer = fs.readFileSync(fontPath);
  const coverage = loadGlyphCoverage(fontBuffer);
  const unsupported = findUnsupportedCodePoints(normalizeTitle(title), coverage);
  if (unsupported.length > 0) return { png: null, layout: null, unsupported };

  registerFont(fontPath);
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext('2d');
  const layout = computeLayout(title, ctx);
  drawBackground(ctx);
  drawLayout(ctx, layout);
  return { png: canvas.toBuffer('image/png'), layout, unsupported: [] };
}

/** Width in px of a laid-out line (tokens joined by single spaces) at `fontSize`, using the real font metrics. */
export function measureLine(line, fontSize) {
  const ctx = createCanvas(WIDTH, HEIGHT).getContext('2d');
  ctx.font = `${fontSize}px ${FONT_FAMILY}`;
  return line.reduce((acc, t, i) => acc + ctx.measureText(t.text).width + (i ? ctx.measureText(' ').width : 0), 0);
}

/** Test/inspection helper: layout only, on a scratch canvas (no PNG). */
export function layoutOnly(title, { fontPath }) {
  registerFont(fontPath);
  const ctx = createCanvas(WIDTH, HEIGHT).getContext('2d');
  return computeLayout(title, ctx);
}
