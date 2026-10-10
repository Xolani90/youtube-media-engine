// Scene-relevance ranker: pure helpers + a client that runs the ranking in a
// CHILD PROCESS (src/media/sceneRelevanceWorker.js). Same isolation shape as
// narration.js -> kokoroWorker.js. Nothing here touches the DB, providers,
// gates or the F5-01 provisioning claim, and nothing in the pipeline imports
// this module yet (fixture-only proof task).
//
// Ranking is a SIGNAL only: it is not a rights, factual or safety check.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_WORKER = fileURLToPath(new URL('./sceneRelevanceWorker.js', import.meta.url));
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_IMAGES = 64;
export const MAX_TEXT_CHARS = 2000;

export function validateRankRequest({ text, images } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('scene text must be a non-empty string');
  if (text.length > MAX_TEXT_CHARS) throw new Error(`scene text exceeds ${MAX_TEXT_CHARS} characters`);
  if (!Array.isArray(images) || images.length === 0) throw new Error('images must be a non-empty array of paths');
  if (images.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per request`);
  for (const p of images) if (typeof p !== 'string' || !p) throw new Error('every image must be a non-empty path string');
  if (new Set(images).size !== images.length) throw new Error('image paths must be unique');
  return { text: text.trim(), images: [...images] };
}

export function resolveTimeoutMs(env = process.env) {
  const raw = env.SCENE_RELEVANCE_TIMEOUT_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('SCENE_RELEVANCE_TIMEOUT_MS must be a positive number');
  return n;
}

export function cosine(a, b) {
  if (a.length !== b.length || a.length === 0) throw new Error('embedding length mismatch');
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) throw new Error('zero-norm embedding');
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Deterministic ranking. entries: [{ path, score }]. Highest score first;
 * ties keep input order. Scores are rounded to 6 dp so float noise between
 * identical runs cannot reorder near-equal candidates.
 */
export function rankEntries(entries) {
  return entries
    .map((e, i) => ({ path: e.path, score: Math.round(e.score * 1e6) / 1e6, _i: i }))
    .sort((x, y) => (y.score - x.score) || (x._i - y._i))
    .map(({ path: p, score }, rank) => ({ path: p, score, rank }));
}

/** Fallback = current behaviour: caller's original order, no scoring. */
export function fallbackResult(images, reason) {
  return { ok: false, fallback: true, reason, ranking: images.map((p, rank) => ({ path: p, score: null, rank })) };
}

/**
 * Rank candidate images against scene text. NEVER throws for worker/model
 * problems: returns the fallback shape so callers keep existing behaviour.
 * (Invalid requests still throw -- that is a caller bug, not a runtime fault.)
 */
export function rankSceneImages(request, { workerPath = DEFAULT_WORKER, timeoutMs = resolveTimeoutMs(), env = process.env } = {}) {
  const { text, images } = validateRankRequest(request);
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inFile = path.join(os.tmpdir(), `scene-rel-in-${tag}.json`);
  const outFile = path.join(os.tmpdir(), `scene-rel-out-${tag}.json`);
  fs.writeFileSync(inFile, JSON.stringify({ text, images }), 'utf8');
  try {
    execFileSync(process.execPath, [workerPath, inFile, outFile], { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env });
    const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (!Array.isArray(out.scores)) throw new Error('worker output missing scores');
    const failed = Array.isArray(out.errors) ? out.errors : [];
    const scored = out.scores.filter((s) => images.includes(s.path) && Number.isFinite(s.score));
    if (scored.length === 0) throw new Error('worker scored no images');
    // Undecodable images are reported, ranked last in input order.
    const ranked = rankEntries(scored);
    const rest = images.filter((p) => !scored.some((s) => s.path === p))
      .map((p, i) => ({ path: p, score: null, rank: ranked.length + i }));
    return { ok: true, fallback: false, ranking: [...ranked, ...rest], errors: failed };
  } catch (err) {
    const lines = String(err.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const marked = lines.reverse().find((l) => l.startsWith('SCENE_RELEVANCE_ERROR:'));
    const timedOut = err.code === 'ETIMEDOUT' || err.killed === true;
    const reason = timedOut ? `timed out after ${timeoutMs}ms`
      : marked ? marked.slice('SCENE_RELEVANCE_ERROR:'.length).trim()
      : String(err.message || err).split('\n')[0].slice(0, 300);
    return fallbackResult(images, reason);
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}
