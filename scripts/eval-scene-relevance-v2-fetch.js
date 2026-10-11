// EVALUATION ONLY (v2). NEEDS NETWORK + A PIXABAY KEY. Not run in Stage A, not
// part of `npm test`, not wired into the pipeline.
//
// Staged candidate acquisition for eval/scene-relevance-v2/. One Pixabay search
// per scene, then CANDIDATES_PER_SCENE (8) downloads at fixed evenly spaced
// positions floor(i*n/8). Records query, hit IDs, per-candidate provenance and
// SHA-256, and every download failure. Re-running skips scenes already recorded as ok.
//
// INSUFFICIENT SCENES FAIL CLOSED. A scene with too few usable hits or downloads is recorded as
// status "insufficient" and the run stops. Every later run (any group, any --only, even --dry-run)
// refuses to proceed, BEFORE any network call, while any scene in candidates.json is insufficient or in an
// unrecognised state. The only way forward is an explicit owner decision in
// fetch-owner-decisions.json, bound to the SHA-256 of that exact recorded failure:
//   node scripts/eval-scene-relevance-v2-fetch.js --show-insufficient      (offline; prints each hash and a template)
// An approved retry re-uses the SAME query (a query change needs a new preregistration). Before retrying,
// the old record and its image folder are moved to attemptHistory / images/<scene>.attempt<N>/; nothing is deleted.
//
// usage (Stage B pilot, 3 scenes):
//   PIXABAY_API_KEY=... node scripts/eval-scene-relevance-v2-fetch.js --confirm-stage-approved --only A01,C01,F01
// usage (Stage C):
//   ... --confirm-stage-approved --group positive      (30 searches, 240 downloads)
//   ... --confirm-stage-approved --group nearmiss      (10 searches, 80 downloads)
// Refuses to run without the key AND --confirm-stage-approved. The key is read
// from the environment only and is never printed, logged or written.
// --dry-run prints the plan and makes NO network call (key not required).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { boundPixabayQuery } from '../src/providers/asset/PixabayAssetSourceProvider.js';
import { DEFAULT_EVAL_DIR, CANDIDATES_PER_SCENE, CANDIDATE_LETTERS, MIN_CANDIDATES, FETCH_DECISIONS_FILE, readJsonStrict, validateScenesDoc, validateNegativesDoc, validateFetchDecisions, insufficientGate, archiveInsufficientScene, stableStringify } from './eval-scene-relevance-v2-lib.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || DEFAULT_EVAL_DIR);
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const PER_PAGE = 20; const DELAY_MS = 700;
const LICENSE = 'Pixabay Content License (as stated by Pixabay at fetch time; not independently verified)';

const scenesDoc = readJsonStrict(path.join(EVAL_DIR, 'scenes.json'));
const negDoc = readJsonStrict(path.join(EVAL_DIR, 'negatives.json'));
validateScenesDoc(scenesDoc); validateNegativesDoc(negDoc, scenesDoc);

const group = val('--group'); const only = val('--only')?.split(',').filter(Boolean);
if (!group && !only && !flag('--show-insufficient')) { console.error('Choose --group positive|nearmiss or --only ID,ID,ID.'); process.exit(1); }
if (group && !['positive', 'nearmiss'].includes(group)) { console.error('--group must be positive or nearmiss.'); process.exit(1); }
const universe = [...scenesDoc.scenes.map((s) => ({ id: s.id, query: s.searchQuery, kind: 'positive' })), ...negDoc.nearMiss.items.map((n) => ({ id: n.id, query: n.searchQuery, kind: 'nearmiss' }))];
const plan = only ? only.map((id) => universe.find((u) => u.id === id) || (() => { console.error(`Unknown id ${id}`); process.exit(1); })()) : universe.filter((u) => u.kind === group);
const positions = (n) => (n <= CANDIDATES_PER_SCENE ? [...Array(n).keys()] : Array.from({ length: CANDIDATES_PER_SCENE }, (_, i) => Math.floor((i * n) / CANDIDATES_PER_SCENE)));

// ---- insufficient-scene gate (offline; runs before any network call, including in --dry-run) ----
const candPath = path.join(EVAL_DIR, 'candidates.json');
const decPath = path.join(EVAL_DIR, FETCH_DECISIONS_FILE);
let gate; let candDoc0 = null;
try {
  candDoc0 = fs.existsSync(candPath) ? readJsonStrict(candPath) : null;
  const decisions = fs.existsSync(decPath) ? validateFetchDecisions(readJsonStrict(decPath)) : null;
  gate = insufficientGate(candDoc0, decisions);
} catch (e) { console.error(`FETCH REFUSED: ${e.message}`); process.exit(1); }
if (flag('--show-insufficient')) {
  if (!gate.blocked.length && !gate.approved.length) console.log('No insufficient scenes recorded.');
  for (const b of gate.blocked) console.log(`BLOCKED ${b.sceneId}: ${b.reason}\n  recordSha256 ${b.recordSha256}\n  to approve a retry of the SAME query, add to ${FETCH_DECISIONS_FILE}:\n  {\"sceneId\":\"${b.sceneId}\",\"recordSha256\":\"${b.recordSha256}\",\"decision\":\"retry-same-query\",\"decidedBy\":\"<owner>\",\"decidedAt\":\"<ISO date>\",\"reason\":\"<why>\"}`);
  for (const a of gate.approved) console.log(`APPROVED ${a.sceneId}: retry-same-query by ${a.decision.decidedBy} at ${a.decision.decidedAt}`);
  process.exit(0);
}
if (gate.blocked.length) {
  console.error(`FETCH REFUSED before any network call: ${gate.blocked.length} scene(s) need an owner decision: ${gate.blocked.map((b) => `${b.sceneId} (${b.reason})`).join('; ')}.`);
  console.error(`Run with --show-insufficient, then record an explicit decision in ${FETCH_DECISIONS_FILE}. Nothing was retried or reclassified.`);
  process.exit(1);
}

if (flag('--dry-run')) {
  console.log(`DRY RUN: ${plan.length} searches, up to ${plan.length * CANDIDATES_PER_SCENE} downloads. No network call made.`);
  for (const p of plan) console.log(`  ${p.id}: "${boundPixabayQuery(p.query)}"`);
  process.exit(0);
}
if (!flag('--confirm-stage-approved')) { console.error('Refusing to run: pass --confirm-stage-approved only after the owner has approved this stage.'); process.exit(1); }
const key = process.env.PIXABAY_API_KEY;
if (!key) { console.error('PIXABAY_API_KEY is not set. No key, no network calls.'); process.exit(1); }
const redact = (s) => String(s ?? '').split(key).join('[REDACTED]');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sniffFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

async function main() {
  const doc = candDoc0 ?? { schema: 'scene-relevance-v2-candidates', endpoint: 'https://pixabay.com/api/', params: { image_type: 'photo', safesearch: 'true', per_page: PER_PAGE }, scenes: {} };
  const save = () => fs.writeFileSync(candPath, stableStringify(doc));
  let searches = 0; let downloads = 0;
  for (const a of gate.approved) {
    if (!plan.some((p) => p.id === a.sceneId)) continue;
    const n = archiveInsufficientScene(doc, a.sceneId, a.decision, EVAL_DIR); save();
    console.log(`${a.sceneId}: owner-approved retry (same query); previous attempt preserved as attempt ${n}`);
  }
  for (const p of plan) {
    if (doc.scenes[p.id]) { console.log(`${p.id}: already fetched, skipping`); continue; }
    const q = boundPixabayQuery(p.query);
    let res;
    try { res = await fetch(`https://pixabay.com/api/?${new URLSearchParams({ key, q, image_type: 'photo', safesearch: 'true', per_page: String(PER_PAGE) })}`); }
    catch (err) { console.error(`${p.id}: network failure: ${redact(err?.message)}. Stopping; re-run resumes.`); process.exitCode = 1; return; }
    searches++;
    if (!res.ok) { console.error(`${p.id}: Pixabay HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}. Stopping; re-run resumes.`); process.exitCode = 1; return; }
    let data; try { data = await res.json(); } catch { console.error(`${p.id}: response was not JSON. Stopping.`); process.exitCode = 1; return; }
    const seen = new Set();
    const hits = (Array.isArray(data?.hits) ? data.hits : []).filter((h) => h && (h.largeImageURL || h.webformatURL) && !seen.has(h.id) && seen.add(h.id));
    console.log(`${p.id}: "${q}" -> ${hits.length} usable hits`);
    if (hits.length < MIN_CANDIDATES) {
      doc.scenes[p.id] = { query: q, hitsReturned: hits.length, hitPixabayIds: hits.map((h) => h.id), candidates: [], failures: [], status: 'insufficient', insufficientReason: 'too_few_hits', recordedAt: new Date().toISOString() };
      save();
      console.error(`${p.id}: only ${hits.length} usable hits (< ${MIN_CANDIDATES}). Recorded as insufficient; stopping. The owner must decide (no silent query change).`); process.exitCode = 1; return;
    }
    const picks = positions(hits.length);
    const candidates = []; const failures = [];
    for (let i = 0; i < picks.length; i++) {
      const hit = hits[picks[i]]; const candidateId = `${p.id}-${CANDIDATE_LETTERS[i]}`;
      await sleep(DELAY_MS);
      let buf;
      try { const r = await fetch(hit.largeImageURL || hit.webformatURL); if (!r.ok) throw new Error(`HTTP ${r.status}`); buf = Buffer.from(await r.arrayBuffer()); downloads++; }
      catch (err) { failures.push({ candidateId, searchRank: picks[i] + 1, stage: 'download', error: redact(err?.message) }); console.error(`${candidateId}: download failed (recorded)`); continue; }
      const format = sniffFormat(buf);
      if (!buf.length || !format) { failures.push({ candidateId, searchRank: picks[i] + 1, stage: 'format', error: 'not a JPEG/PNG/WebP image' }); console.error(`${candidateId}: bad image bytes (recorded)`); continue; }
      const rel = `images/${p.id}/${candidateId}.${format}`;
      fs.mkdirSync(path.join(EVAL_DIR, 'images', p.id), { recursive: true });
      fs.writeFileSync(path.join(EVAL_DIR, ...rel.split('/')), buf);
      candidates.push({ candidateId, sceneId: p.id, searchRank: picks[i] + 1, pixabayId: hit.id, pageURL: hit.pageURL ?? null, photographer: hit.user ?? null, tags: hit.tags ?? null, downloadedFormat: format, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), localPath: rel, license: LICENSE, fetchedAt: new Date().toISOString() });
    }
    doc.scenes[p.id] = { query: q, hitsReturned: hits.length, hitPixabayIds: hits.map((h) => h.id), candidates, failures, status: candidates.length >= MIN_CANDIDATES ? 'ok' : 'insufficient', ...(candidates.length >= MIN_CANDIDATES ? {} : { insufficientReason: 'too_few_downloads', recordedAt: new Date().toISOString() }) };
    save();
    if (candidates.length < MIN_CANDIDATES) { console.error(`${p.id}: only ${candidates.length} candidates downloaded (< ${MIN_CANDIDATES}). Recorded as insufficient; stopping for the owner.`); process.exitCode = 1; return; }
    await sleep(DELAY_MS);
  }
  console.log(`\nDone: ${searches} searches, ${downloads} downloads this run.`);
}
main();
