// Client for the batch worker: ONE child process per video. Never throws for
// worker/model problems (returns { ok:false, fallback:true, reason }).
// Ranking is a SIGNAL only; it is not a rights, factual or safety check.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_IMAGES, MAX_TEXT_CHARS, resolveTimeoutMs } from './sceneRelevance.js';

export const DEFAULT_BATCH_WORKER = fileURLToPath(new URL('./sceneRelevanceBatchWorker.js', import.meta.url));
export const MAX_TEXTS = 64;

export function validateBatchRequest({ texts, images } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error('texts must be a non-empty array');
  if (texts.length > MAX_TEXTS) throw new Error(`at most ${MAX_TEXTS} texts per request`);
  for (const t of texts) {
    if (typeof t !== 'string' || !t.trim()) throw new Error('every text must be a non-empty string');
    if (t.length > MAX_TEXT_CHARS) throw new Error(`text exceeds ${MAX_TEXT_CHARS} characters`);
  }
  if (new Set(texts).size !== texts.length) throw new Error('texts must be unique');
  if (!Array.isArray(images) || images.length === 0) throw new Error('images must be a non-empty array of paths');
  if (images.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per request`);
  for (const p of images) if (typeof p !== 'string' || !p) throw new Error('every image must be a non-empty path string');
  if (new Set(images).size !== images.length) throw new Error('image paths must be unique');
  return { texts: [...texts], images: [...images] };
}

function validMatrix(scores, rows, cols) {
  return Array.isArray(scores) && scores.length === rows && scores.every((r) => Array.isArray(r) && r.length === cols
    && r.every((v) => v === null || Number.isFinite(v)));
}

/**
 * Returns { ok:true, fallback:false, texts, images, scores, errors } where
 * scores[t][i] is the cosine (rounded to 6 dp, like rankEntries) or null for an
 * undecodable image; or { ok:false, fallback:true, reason }.
 */
export function rankSceneBatch(request, { workerPath = DEFAULT_BATCH_WORKER, timeoutMs = resolveTimeoutMs(), env = process.env } = {}) {
  const { texts, images } = validateBatchRequest(request);
  const tag = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inFile = path.join(os.tmpdir(), `scene-batch-in-${tag}.json`);
  const outFile = path.join(os.tmpdir(), `scene-batch-out-${tag}.json`);
  fs.writeFileSync(inFile, JSON.stringify({ texts, images }), 'utf8');
  try {
    execFileSync(process.execPath, [workerPath, inFile, outFile], { stdio: ['ignore', 'ignore', 'pipe'], timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env });
    const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    if (!validMatrix(out.scores, texts.length, images.length)) throw new Error('worker returned an invalid score matrix');
    if (!out.scores.some((row) => row.some((v) => v !== null))) throw new Error('worker scored no images');
    const scores = out.scores.map((row) => row.map((v) => (v === null ? null : Math.round(v * 1e6) / 1e6)));
    return { ok: true, fallback: false, texts, images, scores, errors: Array.isArray(out.errors) ? out.errors : [] };
  } catch (err) {
    const lines = String(err.stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const marked = lines.reverse().find((l) => l.startsWith('SCENE_RELEVANCE_ERROR:'));
    const timedOut = err.code === 'ETIMEDOUT' || err.killed === true;
    const reason = timedOut ? `timed out after ${timeoutMs}ms`
      : marked ? marked.slice('SCENE_RELEVANCE_ERROR:'.length).trim()
      : String(err.message || err).split('\n')[0].slice(0, 300);
    return { ok: false, fallback: true, reason };
  } finally {
    fs.rmSync(inFile, { force: true });
    fs.rmSync(outFile, { force: true });
  }
}
