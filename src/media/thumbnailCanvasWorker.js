// Thumbnail canvas worker. Run as a CHILD PROCESS by src/media/thumbnail.js --
// never imported by the engine -- so a missing/crashing native binary cannot
// take the engine down (same isolation pattern as kokoroWorker.js).
//
// Contract (one JSON object on stdin, one JSON line on stdout):
//   stdin : {"version":1,"title":string,"outputPath":string,"fontPath":string}
//           Exactly these four keys; anything else (an image URL, a background
//           image, ...) is rejected. outputPath and fontPath must be local
//           absolute paths: no URL schemes, no remote resources.
//   stdout: {"ok":true,"renderer":"napi-rs-canvas","width":1280,"height":720,"bytes":N,"sha256":"<hex>"}
//        or {"ok":false,"reason":"<CODE>","detail":"<short text>"}   (exit code 1)
// Reason codes: INPUT_REJECTED, CANVAS_UNAVAILABLE, UNSUPPORTED_GLYPHS, RENDER_FAILED, OUTPUT_TOO_LARGE.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CONTRACT_VERSION = 1;
const ALLOWED_KEYS = ['version', 'title', 'outputPath', 'fontPath'];
const MAX_TITLE_CHARS = 2000;
// YouTube thumbnails.set: maximum file size 2MB (developers.google.com/youtube/v3/docs/thumbnails/set).
export const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const URL_SCHEME = /^[a-z][a-z0-9+.-]+:\/\//i; // a Windows drive letter ("C:\") is one char before ':' and never matches

function finish(result, code = 0) {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
}

function fail(reason, detail) {
  finish({ ok: false, reason, detail: String(detail ?? '').replace(/\s+/g, ' ').slice(0, 300) }, 1);
}

function parseInput() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (err) {
    return { error: `stdin is not valid JSON (${err.message})` };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'input must be a JSON object' };
  const extra = Object.keys(raw).filter((k) => !ALLOWED_KEYS.includes(k));
  if (extra.length > 0) return { error: `unexpected input field(s): ${extra.join(', ')}` };
  if (raw.version !== CONTRACT_VERSION) return { error: `unsupported contract version ${raw.version}` };
  if (typeof raw.title !== 'string' || raw.title.trim() === '' || raw.title.length > MAX_TITLE_CHARS) return { error: 'title must be a non-empty string' };
  for (const key of ['outputPath', 'fontPath']) {
    const value = raw[key];
    if (typeof value !== 'string' || value === '') return { error: `${key} must be a non-empty string` };
    if (URL_SCHEME.test(value)) return { error: `${key} must be a local path, not a URL` };
    if (!path.isAbsolute(value)) return { error: `${key} must be an absolute local path` };
  }
  return { input: raw };
}

async function main() {
  const { input, error } = parseInput();
  if (error) return fail('INPUT_REJECTED', error);

  let renderer;
  try {
    renderer = await import('./thumbnailCanvas.js');
  } catch (err) {
    return fail('CANVAS_UNAVAILABLE', err?.message ?? err);
  }

  try {
    const { png, unsupported } = renderer.renderThumbnail(input.title, { fontPath: input.fontPath });
    if (png === null) {
      return fail('UNSUPPORTED_GLYPHS', `bundled font lacks: ${unsupported.slice(0, 8).map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')}`);
    }
    if (png.length > MAX_OUTPUT_BYTES) return fail('OUTPUT_TOO_LARGE', `${png.length} bytes exceeds ${MAX_OUTPUT_BYTES}`);
    fs.writeFileSync(input.outputPath, png);
    return finish({
      ok: true,
      renderer: 'napi-rs-canvas',
      width: renderer.WIDTH,
      height: renderer.HEIGHT,
      bytes: png.length,
      sha256: crypto.createHash('sha256').update(png).digest('hex')
    });
  } catch (err) {
    return fail('RENDER_FAILED', err?.message ?? err);
  }
}

await main();
