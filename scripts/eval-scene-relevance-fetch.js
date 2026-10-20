// EVALUATION ONLY. Manual, opt-in; not part of `npm test`, not wired into the
// pipeline. Step 1 of 4 for the SigLIP scene-relevance evaluation.
//
// For each scene in eval/scene-relevance/scenes.json: ONE Pixabay search, then
// download a bounded set of candidate photos (default 5) and record provenance
// (Pixabay id, page URL, photographer, tags, dimensions, SHA-256, licence text).
//
// usage:  PIXABAY_API_KEY=... node scripts/eval-scene-relevance-fetch.js [--force]
//   - the key is read from the environment only; it is never printed, logged,
//     written to disk or placed in any report (error text is redacted).
//   - re-running skips scenes already in candidates.json (saves API calls).
//     --force discards candidates.json and starts over.
//   - EVAL_DIR overrides eval/scene-relevance (testing).
//
// The existing PixabayAssetSourceProvider acquires exactly ONE asset per call
// (first hit), so it cannot supply 4-5 candidates per scene. Only its pure
// query-bounding helper is reused; the provider itself is not modified.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boundPixabayQuery } from '../src/providers/asset/PixabayAssetSourceProvider.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || path.join('eval', 'scene-relevance'));
const SEARCH_PER_PAGE = 20;
const CANDIDATES_PER_SCENE = 5;
const DELAY_MS = 700;
const LICENSE = 'Pixabay Content License (as stated by Pixabay at fetch time; not independently verified)';
const force = process.argv.includes('--force');

const key = process.env.PIXABAY_API_KEY;
if (!key) {
  console.error('PIXABAY_API_KEY is not set in the environment. No key, no network calls.');
  process.exit(1);
}
const redact = (s) => String(s ?? '').split(key).join('[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sniffFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// Evenly spaced 0-based positions across the hits that came back.
function pickPositions(n, k) {
  if (n <= k) return [...Array(n).keys()];
  return Array.from({ length: k }, (_, i) => Math.floor((i * n) / k));
}

async function main() {
  const scenesDoc = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'scenes.json'), 'utf8'));
  const candPath = path.join(EVAL_DIR, 'candidates.json');
  const doc = !force && fs.existsSync(candPath)
    ? JSON.parse(fs.readFileSync(candPath, 'utf8'))
    : { endpoint: 'https://pixabay.com/api/', params: { image_type: 'photo', safesearch: 'true', per_page: SEARCH_PER_PAGE }, scenes: {} };
  const save = () => fs.writeFileSync(candPath, JSON.stringify(doc, null, 2));

  let searches = 0;
  for (const scene of scenesDoc.scenes) {
    if (doc.scenes[scene.id]) { console.log(`${scene.id}: already fetched, skipping`); continue; }
    const q = boundPixabayQuery(scene.searchQuery);
    const url = `https://pixabay.com/api/?${new URLSearchParams({ key, q, image_type: 'photo', safesearch: 'true', per_page: String(SEARCH_PER_PAGE) })}`;

    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      console.error(`${scene.id}: network failure: ${redact(err?.message)}. Stopping; re-run to resume.`);
      process.exitCode = 1;
      return;
    }
    searches++;
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (!res.ok) {
      console.error(`${scene.id}: Pixabay returned HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}. Stopping; re-run to resume.`);
      process.exitCode = 1;
      return;
    }
    let data;
    try { data = await res.json(); } catch { console.error(`${scene.id}: response was not valid JSON. Stopping.`); process.exitCode = 1; return; }
    const hits = (Array.isArray(data?.hits) ? data.hits : []).filter((h) => h && (h.largeImageURL || h.webformatURL));
    // distinct Pixabay ids only
    const seen = new Set();
    const distinct = hits.filter((h) => (seen.has(h.id) ? false : seen.add(h.id)));
    console.log(`${scene.id}: "${q}" -> ${distinct.length} usable hits (rate-limit remaining: ${remaining ?? 'n/a'})`);
    if (distinct.length < 4) {
      console.error(`${scene.id}: only ${distinct.length} usable hits; need at least 4. Change searchQuery in scenes.json and re-run.`);
      process.exitCode = 1;
      return;
    }

    const picks = pickPositions(distinct.length, CANDIDATES_PER_SCENE);
    const candidates = [];
    for (let i = 0; i < picks.length; i++) {
      const hit = distinct[picks[i]];
      const candidateId = `${scene.id}-${'ABCDE'[i]}`;
      const imgUrl = hit.largeImageURL || hit.webformatURL;
      await sleep(DELAY_MS);
      let buf;
      try {
        const r = await fetch(imgUrl);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        buf = Buffer.from(await r.arrayBuffer());
      } catch (err) {
        console.error(`${candidateId}: download failed: ${redact(err?.message)}. Stopping; re-run to resume.`);
        process.exitCode = 1;
        return;
      }
      const format = sniffFormat(buf);
      if (buf.length === 0 || !format) {
        console.error(`${candidateId}: downloaded bytes are not a recognised JPEG/PNG/WebP image. Stopping.`);
        process.exitCode = 1;
        return;
      }
      const rel = `images/${scene.id}/${candidateId}.${format}`;
      fs.mkdirSync(path.join(EVAL_DIR, 'images', scene.id), { recursive: true });
      fs.writeFileSync(path.join(EVAL_DIR, ...rel.split('/')), buf);
      candidates.push({
        candidateId,
        sceneId: scene.id,
        searchRank: picks[i] + 1,
        pixabayId: hit.id,
        pageURL: hit.pageURL ?? null,
        photographer: hit.user ?? null,
        tags: hit.tags ?? null,
        pixabayImageWidth: hit.imageWidth ?? null,
        pixabayImageHeight: hit.imageHeight ?? null,
        downloadedFormat: format,
        bytes: buf.length,
        sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        localPath: rel,
        license: LICENSE,
        fetchedAt: new Date().toISOString()
      });
    }
    doc.scenes[scene.id] = { query: q, hitsReturned: distinct.length, candidates };
    save();
    await sleep(DELAY_MS);
  }
  save();
  const total = Object.values(doc.scenes).reduce((n, s) => n + s.candidates.length, 0);
  console.log(`\nDone. ${Object.keys(doc.scenes).length} scenes, ${total} candidate images, ${searches} searches this run.`);
  console.log(`Next: node scripts/eval-scene-relevance-contact-sheet.js`);
}

main();