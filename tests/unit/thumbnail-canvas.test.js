import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  generateThumbnail,
  generateThumbnailDetailed,
  generateThumbnailFfmpeg,
  THUMBNAIL_WIDTH,
  THUMBNAIL_HEIGHT,
  MAX_THUMBNAIL_BYTES,
  BUNDLED_FONT_SHA256
} from '../../src/media/thumbnail.js';
import { layoutOnly, measureLine, renderThumbnail, MAX_TEXT_WIDTH, MAX_LINES, MARGIN_TOP, MARGIN_BOTTOM, COLORS } from '../../src/media/thumbnailCanvas.js';
import { loadGlyphCoverage } from '../../src/media/fontGlyphs.js';

/*
 * Focused tests for the @napi-rs/canvas thumbnail worker (Stage A).
 *
 * Platform note: pixel-exact output depends on the Skia build and the bundled
 * font only (no system fonts are used), but determinism is asserted only for
 * "identical input, same environment". No golden hashes are pinned because a
 * different OS/arch binary may rasterize differently.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'media');
const FONT_PATH = path.resolve(SRC_DIR, '..', '..', 'assets', 'fonts', 'DejaVuSans-Bold.ttf');
const WORKER_PATH = path.join(SRC_DIR, 'thumbnailCanvasWorker.js');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-canvas-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function out(name = 'thumb') {
  return path.join(scratch, `${name}-${crypto.randomUUID()}.png`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ihdr(buf) {
  return { signatureOk: buf.subarray(0, 8).equals(PNG_SIGNATURE), width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function ffprobe(file) {
  const o = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name', '-of', 'default=noprint_wrappers=1', file]).toString();
  return { width: Number(/width=(\d+)/.exec(o)?.[1]), height: Number(/height=(\d+)/.exec(o)?.[1]), codec: /codec_name=(\S+)/.exec(o)?.[1] };
}

function assertValidThumbnail(file) {
  const bytes = fs.readFileSync(file);
  const h = ihdr(bytes);
  assert.ok(h.signatureOk, 'PNG signature');
  assert.equal(h.width, THUMBNAIL_WIDTH);
  assert.equal(h.height, THUMBNAIL_HEIGHT);
  assert.ok(bytes.length <= MAX_THUMBNAIL_BYTES, `size ${bytes.length} exceeds the 2MB YouTube API limit`);
  const p = ffprobe(file); // independent decoder
  assert.deepEqual(p, { width: THUMBNAIL_WIDTH, height: THUMBNAIL_HEIGHT, codec: 'png' });
}

async function pixels(pngBuffer) {
  const img = await loadImage(pngBuffer); // Buffer only: no path or URL is ever loaded
  const canvas = createCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return { width: img.width, height: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
}

function luminance(r, g, b) {
  const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function hexLuminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return luminance((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

/** Counts "ink" pixels (bright text/accent) in a rectangle. Background gradient luminance stays well below 0.45. */
function inkCount({ width, data }, x0, y0, x1, y1) {
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if (luminance(data[i], data[i + 1], data[i + 2]) > 0.45) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- 1. valid PNG

test('canvas renderer produces a decodable 1280x720 PNG under the YouTube 2MB API limit', async () => {
  const file = out();
  const result = generateThumbnailDetailed('Why 50% of AI Startups Fail: The Real Reason', file);
  assert.equal(result.renderer, 'canvas');
  assert.equal(result.fallbackReason, null);
  assertValidThumbnail(file);

  const px = await pixels(fs.readFileSync(file));
  assert.equal(px.width, THUMBNAIL_WIDTH);
  assert.equal(px.height, THUMBNAIL_HEIGHT);
  assert.ok(inkCount(px, 0, 0, px.width, px.height) > 5000, 'image must contain visible text/accent pixels, not just a background');
});

test('generateThumbnail keeps its (title, outputPath) contract and returns the output path', () => {
  const file = out();
  assert.equal(generateThumbnail('Contract Check', file), file);
  assertValidThumbnail(file);
});

test('text and accent colors have strong contrast against the gradient (WCAG >= 7:1 against the lightest background stop)', () => {
  const bg = Math.max(hexLuminance(COLORS.gradientFrom), hexLuminance(COLORS.gradientTo));
  for (const fg of [COLORS.text, COLORS.accent]) {
    const ratio = (hexLuminance(fg) + 0.05) / (bg + 0.05);
    assert.ok(ratio >= 7, `${fg} contrast ${ratio.toFixed(2)}`);
  }
});

// ---------------------------------------------------- 2. wrapping and fitting

function assertLayoutFits(layout) {
  assert.ok(layout.lines.length >= 1 && layout.lines.length <= MAX_LINES, `${layout.lines.length} lines`);
  for (const line of layout.lines) {
    const w = measureLine(line, layout.fontSize);
    assert.ok(w <= MAX_TEXT_WIDTH + 0.5, `line "${line.map((t) => t.text).join(' ')}" is ${w}px > ${MAX_TEXT_WIDTH}px`);
  }
}

test('short, long and extreme titles all wrap and fit; longer titles get smaller type', () => {
  const short = layoutOnly('Short Title', { fontPath: FONT_PATH });
  const long = layoutOnly('This is a considerably longer video title that will need to wrap across several lines to stay readable', { fontPath: FONT_PATH });
  const extreme = layoutOnly('word '.repeat(80).trim(), { fontPath: FONT_PATH });
  for (const l of [short, long, extreme]) assertLayoutFits(l);
  assert.equal(short.lines.length, 1);
  assert.ok(short.fontSize > long.fontSize, 'long title must use a smaller font than a short one');
  assert.equal(short.truncated, false);
  assert.equal(long.truncated, false);
  assert.equal(extreme.truncated, true);
  assert.equal(extreme.lines.length, MAX_LINES);
  const lastLine = extreme.lines.at(-1);
  assert.ok(lastLine.at(-1).text.endsWith('…'), 'overflowing titles end in an ellipsis, never an overflow');
});

test('a single over-long word is broken to fit instead of overflowing the canvas', () => {
  const layout = layoutOnly('Supercalifragilisticexpialidocious'.repeat(3), { fontPath: FONT_PATH });
  assertLayoutFits(layout);
  assert.ok(layout.lines.length > 1);
});

test('rendered ink never enters the safe-area margins (top, bottom/duration-badge strip, right, left)', async () => {
  const titles = [
    'Short Title',
    'This is a considerably longer video title that will need to wrap across several lines to stay readable',
    'word '.repeat(80).trim(),
    'Supercalifragilisticexpialidocious'.repeat(3)
  ];
  for (const title of titles) {
    const { png } = renderThumbnail(title, { fontPath: FONT_PATH });
    const px = await pixels(png);
    assert.equal(inkCount(px, 0, 0, px.width, MARGIN_TOP - 2), 0, `top margin: ${title.slice(0, 30)}`);
    assert.equal(inkCount(px, 0, THUMBNAIL_HEIGHT - MARGIN_BOTTOM + 2, px.width, px.height), 0, `bottom margin: ${title.slice(0, 30)}`);
    assert.equal(inkCount(px, px.width - 60, 0, px.width, px.height), 0, `right margin: ${title.slice(0, 30)}`);
    assert.equal(inkCount(px, 0, 0, 60, px.height), 0, `left margin: ${title.slice(0, 30)}`);
  }
});

test('emphasis: a number is highlighted when present; short titles get none', () => {
  assert.equal(layoutOnly('Why 50% of AI Startups Fail', { fontPath: FONT_PATH }).emphasisWord, '50%');
  assert.equal(layoutOnly('The Economics of Semiconductor Packaging', { fontPath: FONT_PATH }).emphasisWord, 'Semiconductor');
  assert.equal(layoutOnly('Two Words', { fontPath: FONT_PATH }).emphasisWord, null);
  assert.equal(layoutOnly('a b c d e', { fontPath: FONT_PATH }).emphasisWord, null);
});

// ------------------------------------------------------- 3. special characters

test('special characters survive layout verbatim and render through the canvas path', () => {
  const title = `Colons: 100% "double" 'single' back\\slash <b> & ; \u2019 \u201cquoted\u201d`;
  const layout = layoutOnly(title, { fontPath: FONT_PATH });
  assert.equal(layout.lines.map((l) => l.map((t) => t.text).join(' ')).join(' '), title, 'no character was dropped, escaped or substituted');
  const file = out();
  const r = generateThumbnailDetailed(title, file);
  assert.equal(r.renderer, 'canvas', r.fallbackReason ?? '');
  assertValidThumbnail(file);
});

// ------------------------------------------------------- 4. unicode, CJK, emoji

test('glyph support is verified from the bundled font itself, not inferred from render success', () => {
  const coverage = loadGlyphCoverage(fs.readFileSync(FONT_PATH));
  for (const ch of ['é', 'Ü', 'Д', 'Ω', '—', '…', '\u2019', '%', ':']) assert.equal(coverage.has(ch.codePointAt(0)), true, `font should contain ${ch}`);
  for (const ch of ['日', 'テ', '한', '中']) assert.equal(coverage.has(ch.codePointAt(0)), false, `bundled font has no CJK glyph for ${ch}`);
  // DejaVu ships MONOCHROME outlines for some emoticons; color emoji are not supported.
  assert.equal(coverage.has(0x1f600), true);
  assert.equal(coverage.has(0x1f9d1), false, 'newer emoji beyond the font\'s coverage must be reported as unsupported');
});

test('Latin-extended, Cyrillic and Greek titles render through the canvas path', () => {
  for (const title of ['Déjà vu — Ünïcödé Tëst', 'Привет мир: 5 советов', 'Ωμέγα και Άλφα 2026']) {
    const file = out();
    const r = generateThumbnailDetailed(title, file);
    assert.equal(r.renderer, 'canvas', `${title}: ${r.fallbackReason}`);
    assertValidThumbnail(file);
  }
});

test('CJK is NOT supported by the bundled font: the canvas worker declines and the FFmpeg fallback takes over', () => {
  // LIMITATION (not a claim of support): the FFmpeg fallback uses the same bundled font, so CJK
  // characters still render as missing-glyph boxes there, exactly as before this change.
  const file = out();
  const r = generateThumbnailDetailed('Déjà vu — 日本語テスト', file);
  assert.equal(r.renderer, 'ffmpeg');
  assert.match(r.fallbackReason, /^UNSUPPORTED_GLYPHS/);
  assertValidThumbnail(file);
});

test('monochrome emoticon glyphs present in the font render; distinct emoji produce distinct pixels', () => {
  const a = out();
  const b = out();
  assert.equal(generateThumbnailDetailed('Launch \u{1F600} Day', a).renderer, 'canvas');
  assert.equal(generateThumbnailDetailed('Launch \u{1F601} Day', b).renderer, 'canvas');
  assert.notEqual(sha256(a), sha256(b));
});

// ------------------------------------------------------------- 5. determinism

test('deterministic: identical input produces byte-identical output across separate worker processes', () => {
  const title = 'Determinism Check: 3 Reasons It Matters';
  const hashes = [0, 1, 2].map(() => { const f = out(); generateThumbnail(title, f); return sha256(f); });
  assert.equal(new Set(hashes).size, 1);
  const other = out();
  generateThumbnail('A Different Title Entirely', other);
  assert.notEqual(sha256(other), hashes[0]);
});

test('pinned font checksum matches the bundled font file', () => {
  assert.equal(sha256(FONT_PATH), BUNDLED_FONT_SHA256);
});

// ---------------------------------------- 6. timeout / crash / missing binary

function fixtureWorker(name, source) {
  const file = path.join(scratch, `${name}-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(file, source);
  return file;
}

function assertFellBackTo(result, file, reasonPattern) {
  assert.equal(result.renderer, 'ffmpeg');
  assert.match(result.fallbackReason, reasonPattern);
  assertValidThumbnail(file);
}

test('worker timeout is bounded and falls back to FFmpeg', () => {
  const file = out();
  const worker = fixtureWorker('hang', 'setInterval(() => {}, 1000);');
  const started = Date.now();
  const r = generateThumbnailDetailed('Timeout Case', file, { workerScript: worker, timeoutMs: 600 });
  assert.ok(Date.now() - started < 15_000, 'must not wait beyond the bound by a wide margin');
  assertFellBackTo(r, file, /^WORKER_TIMEOUT/);
});

test('worker crash (killed by signal / non-zero exit / uncaught exception) falls back to FFmpeg', () => {
  const cases = {
    killed: "process.kill(process.pid, 'SIGKILL'); setInterval(() => {}, 1000);",
    exit3: 'process.exit(3);',
    uncaught: "throw new Error('boom');"
  };
  for (const [name, src] of Object.entries(cases)) {
    const file = out(name);
    const r = generateThumbnailDetailed('Crash Case', file, { workerScript: fixtureWorker(name, src), timeoutMs: 10_000 });
    assertFellBackTo(r, file, /^WORKER_CRASHED/);
  }
});

test('missing worker script falls back to FFmpeg', () => {
  const file = out();
  const r = generateThumbnailDetailed('Missing Worker', file, { workerScript: path.join(scratch, 'does-not-exist.mjs') });
  assertFellBackTo(r, file, /^WORKER_CRASHED/);
});

test('malformed or lying worker output is rejected and falls back to FFmpeg', () => {
  const tiny = createCanvas(640, 360).toBuffer('image/png');
  const huge = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8), (() => { const b = Buffer.alloc(8); b.writeUInt32BE(THUMBNAIL_WIDTH, 0); b.writeUInt32BE(THUMBNAIL_HEIGHT, 4); return b; })(), Buffer.alloc(MAX_THUMBNAIL_BYTES + 10)]);
  const okLine = (extra = '') => `JSON.stringify({ ok: true, renderer: 'napi-rs-canvas', width: 1280, height: 720, bytes: 10, sha256: '${'0'.repeat(64)}'${extra} })`;
  const writeAndClaim = (buf, name) => {
    const f = path.join(scratch, name);
    fs.writeFileSync(f, buf);
    return f;
  };
  const validFile = writeAndClaim(renderThumbnail('Valid But Mismatched', { fontPath: FONT_PATH }).png, 'valid.png');
  const tinyFile = writeAndClaim(tiny, 'tiny.png');
  const hugeFile = writeAndClaim(huge, 'huge.png');
  const cases = [
    ['notjson', "console.log('definitely not json');", /^WORKER_OUTPUT_MALFORMED/],
    ['empty', '/* prints nothing */', /^WORKER_OUTPUT_MALFORMED/],
    ['wrongfields', "console.log(JSON.stringify({ ok: true, width: 1, height: 1 }));", /^WORKER_OUTPUT_MALFORMED/],
    ['nofile', `console.log(${okLine()});`, /^WORKER_OUTPUT_MISSING/],
    ['garbage', `import fs from 'node:fs'; const o = JSON.parse(fs.readFileSync(0, 'utf8')).outputPath; fs.writeFileSync(o, 'not a png'); console.log(${okLine()});`, /^OUTPUT_INVALID/],
    ['wrongdims', `import fs from 'node:fs'; const o = JSON.parse(fs.readFileSync(0, 'utf8')).outputPath; fs.copyFileSync(${JSON.stringify(tinyFile)}, o); console.log(${okLine()});`, /^OUTPUT_INVALID/],
    ['checksummismatch', `import fs from 'node:fs'; const o = JSON.parse(fs.readFileSync(0, 'utf8')).outputPath; fs.copyFileSync(${JSON.stringify(validFile)}, o); console.log(${okLine()});`, /^OUTPUT_INVALID: file does not match/],
    ['oversize', `import fs from 'node:fs'; const o = JSON.parse(fs.readFileSync(0, 'utf8')).outputPath; fs.copyFileSync(${JSON.stringify(hugeFile)}, o); console.log(${okLine()});`, /^OUTPUT_INVALID/],
    ['failurereport', "console.log(JSON.stringify({ ok: false, reason: 'RENDER_FAILED', detail: 'simulated' })); process.exit(1);", /^RENDER_FAILED/]
  ];
  for (const [name, src, pattern] of cases) {
    const file = out(name);
    const r = generateThumbnailDetailed('Lying Worker', file, { workerScript: fixtureWorker(name, src) });
    assertFellBackTo(r, file, pattern);
  }
});

test('missing/unloadable native binary: the REAL worker reports CANVAS_UNAVAILABLE and the engine falls back', () => {
  // Copy the real worker and renderer to a directory and point the renderer's canvas import at a
  // module that cannot be resolved -- the same failure mode as a missing or unloadable native binary.
  const dir = fs.mkdtempSync(path.join(scratch, 'nobinary-'));
  for (const f of ['thumbnailCanvasWorker.js', 'fontGlyphs.js']) fs.copyFileSync(path.join(SRC_DIR, f), path.join(dir, f));
  const canvasSrc = fs.readFileSync(path.join(SRC_DIR, 'thumbnailCanvas.js'), 'utf8');
  const broken = canvasSrc.replace("import('@napi-rs/canvas')", "import('@napi-rs/canvas-binary-that-does-not-exist')");
  assert.notEqual(broken, canvasSrc, 'fixture replacement must have applied');
  fs.writeFileSync(path.join(dir, 'thumbnailCanvas.js'), broken);

  const file = out();
  const r = generateThumbnailDetailed('No Binary', file, { workerScript: path.join(dir, 'thumbnailCanvasWorker.js') });
  assertFellBackTo(r, file, /^CANVAS_UNAVAILABLE/);
});

test('THUMBNAIL_RENDERER=ffmpeg bypass: forced renderer option skips the canvas worker', () => {
  const file = out();
  const r = generateThumbnailDetailed('Forced FFmpeg', file, { renderer: 'ffmpeg' });
  assertFellBackTo(r, file, /^RENDERER_FORCED_FFMPEG/);
});

test('if the canvas worker AND the FFmpeg fallback both fail, the error still surfaces to the caller (existing best-effort handler)', () => {
  const impossible = path.join(scratch, 'no-such-dir', 'x.png');
  assert.throws(() => generateThumbnail('Both Fail', impossible));
});

test('empty and non-string titles still throw before any worker is started', () => {
  assert.throws(() => generateThumbnail('', out()), /non_empty_title/);
  assert.throws(() => generateThumbnail('   ', out()), /non_empty_title/);
  assert.throws(() => generateThumbnail(null, out()));
});

// ------------------------------------------------- 7. remote sources rejected

function runWorkerRaw(stdin) {
  const run = spawnSync(process.execPath, [WORKER_PATH], { input: stdin, encoding: 'utf8', timeout: 20_000 });
  let msg = null;
  try { msg = JSON.parse(run.stdout.trim().split('\n').at(-1)); } catch { /* leave null */ }
  return { status: run.status, msg };
}

const goodRequest = (overrides = {}) => ({ version: 1, title: 'Remote Rejection', outputPath: path.join(scratch, `remote-${crypto.randomUUID()}.png`), fontPath: FONT_PATH, ...overrides });

test('worker rejects image sources, remote URLs, relative paths and unknown fields; nothing is written', () => {
  const rejected = [
    goodRequest({ imageUrl: 'https://example.com/background.png' }),
    goodRequest({ backgroundImage: '/etc/hostname' }),
    goodRequest({ src: 'http://example.com/a.png' }),
    goodRequest({ fontPath: 'https://example.com/font.ttf' }),
    goodRequest({ fontPath: 'file:///usr/share/fonts/x.ttf' }),
    goodRequest({ fontPath: 'ftp://example.com/font.ttf' }),
    goodRequest({ fontPath: 'data:font/ttf;base64,AAAA' }),
    goodRequest({ outputPath: 'https://example.com/upload.png' }),
    goodRequest({ outputPath: 'relative/out.png' }),
    goodRequest({ fontPath: 'assets/fonts/DejaVuSans-Bold.ttf' }),
    goodRequest({ version: 2 }),
    goodRequest({ title: '' }),
    goodRequest({ title: 42 })
  ];
  for (const req of rejected) {
    const { status, msg } = runWorkerRaw(JSON.stringify(req));
    assert.equal(status, 1, JSON.stringify(req));
    assert.equal(msg?.ok, false);
    assert.equal(msg?.reason, 'INPUT_REJECTED', JSON.stringify(req));
    if (path.isAbsolute(req.outputPath ?? '')) assert.equal(fs.existsSync(req.outputPath), false, 'rejected request must not write output');
  }
  for (const raw of ['not json', '[]', 'null', '']) {
    const { status, msg } = runWorkerRaw(raw);
    assert.equal(status, 1);
    assert.equal(msg?.reason, 'INPUT_REJECTED');
  }
});

test('worker accepts a well-formed local request (control for the rejection cases)', () => {
  const req = goodRequest();
  const { status, msg } = runWorkerRaw(JSON.stringify(req));
  assert.equal(status, 0);
  assert.equal(msg.ok, true);
  assert.equal(msg.sha256, sha256(req.outputPath));
});

test('renderer and worker source reference no image-loading or network API', () => {
  const forbidden = /\bloadImage\b|\bnew\s+Image\b|\bfetch\s*\(|XMLHttpRequest|node:https?\b|from\s+['"]https?['"]|require\(\s*['"]https?['"]\s*\)|node:net\b|node:dns\b|node:dgram\b|WebSocket/;
  for (const f of ['thumbnailCanvas.js', 'thumbnailCanvasWorker.js', 'fontGlyphs.js']) {
    const src = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    assert.doesNotMatch(src, forbidden, `${f} must not load images or touch the network`);
  }
});

// ------------------------------------------- FFmpeg fallback stays functional

test('the preserved FFmpeg renderer still works on its own and yields a valid thumbnail', () => {
  const file = out();
  assert.equal(generateThumbnailFfmpeg('FFmpeg Fallback: 100% "intact"', file), file);
  assertValidThumbnail(file);
});
