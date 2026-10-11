// EVALUATION ONLY (v2). Pure, offline logic shared by the v2 scene-relevance
// scripts and their tests: split rules, strict validation, frozen-judgment
// verification, metrics, rule selection, verdict. No network, no model, no
// production imports. Every function fails closed: bad input throws, it is
// never repaired or defaulted into a favourable result.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_EVAL_DIR = path.join('eval', 'scene-relevance-v2');
export const CANDIDATES_PER_SCENE = 8;
export const MIN_CANDIDATES = 6; // fewer downloaded candidates => scene is invalid
export const CANDIDATE_LETTERS = 'ABCDEFGH';
export const TIMING_SCENES = ['A02', 'C03', 'F03']; // calibration-split scenes, fixed in advance
export const ANSWER_KEY_FILE = 'answer-key.json';
export const REVIEW_ASSET_DIR = 'review-assets';
export const CANDIDATES_FILE = 'candidates.json';
export const FROZEN_FILES = ['PREREGISTRATION.md', 'scenes.json', 'negatives.json', CANDIDATES_FILE, ANSWER_KEY_FILE];
export const FETCH_DECISIONS_FILE = 'fetch-owner-decisions.json'; // owner-written; NOT a frozen file (fetch bookkeeping)
export const CONDITION_TYPES = ['visual', 'absence'];

// Fixed before any score exists (see PREREGISTRATION.md section 8). minEligibleHeldOut (12) and
// rule.minPerClass (3) / rule.minAuroc (0.70) are PROVISIONAL SAFEGUARDS chosen in Stage A, not
// statistically validated thresholds; the owner's verdict thresholds are the promising/notPromising blocks.
export const CRITERIA = Object.freeze({
  promising: { top1Pct: 70, pairwisePct: 75, baselineMarginPp: 15, minCategorySuccesses: 1 },
  notPromising: { top1AtMostPct: 45, pairwiseAtMostPct: 60 },
  minEligibleHeldOut: 12,
  rule: { minPerClass: 3, minAuroc: 0.7, statistics: ['topScore', 'gapTop1Top2', 'top1MinusMedian'] }
});

export const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
export const sha256File = (p) => sha256Hex(fs.readFileSync(p));

export function readJsonStrict(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) { throw new Error(`cannot read ${p}: ${e.code || e.message}`); }
  try { return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { throw new Error(`malformed JSON: ${p}`); }
}

// Deterministic serialization: object keys sorted, 2-space indent, trailing newline.
export function stableStringify(v) {
  const sort = (x) => (Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = (m) => { throw new Error(m); };
const isStrArr = (a) => Array.isArray(a) && a.every((x) => typeof x === 'string' && x);

// ---------------------------------------------------------------- split rules
// Stratified: within each category sort scene IDs by sha256(id) (lowercase hex,
// ascending); first 2 = calibration, remaining 3 = held-out.
export function computeSplit(scenes) {
  const byCat = new Map();
  for (const s of scenes) byCat.set(s.category, [...(byCat.get(s.category) || []), s.id]);
  const out = {};
  for (const ids of byCat.values()) {
    [...ids].sort((a, b) => (sha256Hex(a) < sha256Hex(b) ? -1 : 1)).forEach((id, k) => { out[id] = k < 2 ? 'calibration' : 'heldout'; });
  }
  return out;
}

// Near-miss split (fixed BEFORE any score or image existed; no model output is used). Items are stratified by
// conditionType so both condition types appear in calibration and held-out wherever the counts allow:
// within each conditionType sort the near-miss IDs ascending by the lowercase hex SHA-256 of 'nmsplit:' + id
// (tie-breaker if two hashes were ever equal: the ID, ascending); the first floor(n/2) are calibration and the
// rest (the extra item when n is odd) are held-out. The prefix was declared once and not varied.
export const NEAR_MISS_SPLIT_PREFIX = 'nmsplit:';
export function computeNearMissSplit(nearMissItems) {
  const byType = new Map();
  for (const n of nearMissItems) byType.set(n.conditionType, [...(byType.get(n.conditionType) || []), n.id]);
  const key = (id) => sha256Hex(`${NEAR_MISS_SPLIT_PREFIX}${id}`);
  const out = {};
  for (const ids of byType.values()) {
    [...ids].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a < b ? -1 : 1))
      .forEach((id, k) => { out[id] = k < Math.floor(ids.length / 2) ? 'calibration' : 'heldout'; });
  }
  return out;
}

// Cross-category pairings: per split, the 5 scenes with lowest sha256('xneg:'+id)
// are description scenes; image scene = other-category scene with lowest
// sha256('xneg-img:'+d+':'+m). Items numbered XN01.. calibration first.
export function computeCrossPairs(scenes, split = computeSplit(scenes)) {
  const items = [];
  for (const sp of ['calibration', 'heldout']) {
    const ds = scenes.filter((s) => split[s.id] === sp).map((s) => s.id)
      .sort((a, b) => (sha256Hex(`xneg:${a}`) < sha256Hex(`xneg:${b}`) ? -1 : 1)).slice(0, 5);
    for (const d of ds) {
      const cat = scenes.find((s) => s.id === d).category;
      const m = scenes.filter((s) => s.category !== cat).map((s) => s.id)
        .sort((a, b) => (sha256Hex(`xneg-img:${d}:${a}`) < sha256Hex(`xneg-img:${d}:${b}`) ? -1 : 1))[0];
      items.push({ id: `XN${String(items.length + 1).padStart(2, '0')}`, descriptionScene: d, imageScene: m, split: sp });
    }
  }
  return items;
}

// ------------------------------------------------------------- dataset checks
export function validateScenesDoc(doc) {
  if (!isObj(doc) || doc.schema !== 'scene-relevance-v2-scenes' || !Array.isArray(doc.scenes)) fail('scenes.json: wrong schema');
  if (doc.scenes.length !== 30) fail(`scenes.json: expected 30 scenes, found ${doc.scenes.length}`);
  const seen = new Set(); const perCat = {};
  for (const s of doc.scenes) {
    if (!isObj(s) || !/^[A-F]\d{2}$/.test(s.id || '')) fail('scenes.json: bad scene id');
    if (seen.has(s.id)) fail(`scenes.json: duplicate ${s.id}`); seen.add(s.id);
    if (s.category !== s.id[0]) fail(`scenes.json: ${s.id} category mismatch`);
    for (const k of ['description', 'searchQuery', 'visualTarget']) if (typeof s[k] !== 'string' || !s[k].trim()) fail(`scenes.json: ${s.id}.${k} missing`);
    if (s.searchQuery.length > 100) fail(`scenes.json: ${s.id} searchQuery over 100 chars`);
    if (!isStrArr(s.acceptableProxies) || s.acceptableProxies.length === 0) fail(`scenes.json: ${s.id} needs acceptableProxies`);
    perCat[s.category] = (perCat[s.category] || 0) + 1;
  }
  for (const c of 'ABCDEF') if (perCat[c] !== 5) fail(`scenes.json: category ${c} must have 5 scenes`);
  const split = computeSplit(doc.scenes);
  for (const s of doc.scenes) if (s.split !== split[s.id]) fail(`scenes.json: ${s.id} split "${s.split}" does not match the SHA-256 rule ("${split[s.id]}")`);
  return split;
}

export function validateNegativesDoc(neg, scenesDoc) {
  if (!isObj(neg) || neg.schema !== 'scene-relevance-v2-negatives') fail('negatives.json: wrong schema');
  const expect = computeCrossPairs(scenesDoc.scenes);
  const got = neg.crossCategory?.items;
  if (!Array.isArray(got) || got.length !== 10) fail('negatives.json: expected 10 cross-category items');
  for (let i = 0; i < 10; i++) {
    const g = got[i]; const e = expect[i];
    if (!g || g.id !== e.id || g.descriptionScene !== e.descriptionScene || g.imageScene !== e.imageScene || g.split !== e.split) fail(`negatives.json: ${e.id} does not match the deterministic pairing rule`);
  }
  const nm = neg.nearMiss?.items;
  if (!Array.isArray(nm) || nm.length !== 10) fail('negatives.json: expected 10 near-miss items');
  nm.forEach((n, i) => {
    if (n.id !== `NM${String(i + 1).padStart(2, '0')}`) fail('negatives.json: near-miss ids must be NM01..NM10');
    for (const k of ['description', 'searchQuery', 'visualTarget']) if (typeof n[k] !== 'string' || !n[k].trim()) fail(`negatives.json: ${n.id}.${k} missing`);
    if (n.searchQuery.length > 100) fail(`negatives.json: ${n.id} searchQuery over 100 chars`);
    if (!['calibration', 'heldout'].includes(n.split)) fail(`negatives.json: ${n.id} bad split`);
    if (!CONDITION_TYPES.includes(n.conditionType)) fail(`negatives.json: ${n.id}.conditionType must be one of ${CONDITION_TYPES.join(', ')}`);
  });
  if (nm.filter((n) => n.split === 'calibration').length !== 5) fail('negatives.json: near-miss split must be 5/5');
  const want = computeNearMissSplit(nm);
  for (const n of nm) if (n.split !== want[n.id]) fail(`negatives.json: ${n.id} split \"${n.split}\" does not match the SHA-256 rule (\"${want[n.id]}\")`);
  for (const t of CONDITION_TYPES) for (const sp of ['calibration', 'heldout']) {
    if (nm.some((n) => n.conditionType === t) && nm.filter((n) => n.conditionType === t).length >= 2 && !nm.some((n) => n.conditionType === t && n.split === sp)) fail(`negatives.json: no ${t} near-miss in ${sp}`);
  }
}

export function validateCandidatesDoc(doc, sceneIds) {
  if (!isObj(doc) || !isObj(doc.scenes)) fail('candidates.json: malformed');
  for (const id of sceneIds) {
    const e = doc.scenes[id];
    if (!e || !Array.isArray(e.candidates)) fail(`candidates.json: no candidates for ${id}`);
    if (e.candidates.length < MIN_CANDIDATES) fail(`candidates.json: ${id} has ${e.candidates.length} candidates (< ${MIN_CANDIDATES})`);
    const ids = new Set();
    for (const c of e.candidates) {
      const m = /^([A-F]\d{2}|NM\d{2})-([A-H])$/.exec(c?.candidateId || '');
      if (!m || m[1] !== id) fail(`candidates.json: bad candidateId in ${id}`);
      if (ids.has(c.candidateId)) fail(`candidates.json: duplicate ${c.candidateId}`); ids.add(c.candidateId);
      if (!Number.isInteger(c.searchRank) || c.searchRank < 1) fail(`candidates.json: ${c.candidateId} bad searchRank`);
      if (!/^[0-9a-f]{64}$/.test(c.sha256 || '')) fail(`candidates.json: ${c.candidateId} bad sha256`);
      if (typeof c.localPath !== 'string' || !c.localPath || c.localPath.includes('..')) fail(`candidates.json: ${c.candidateId} bad localPath`);
    }
  }
}

// Items = the units judged and ranked: 30 positive scenes + 10 cross + 10 near-miss.
export function buildItems(scenesDoc, negDoc, candDoc) {
  const split = validateScenesDoc(scenesDoc); validateNegativesDoc(negDoc, scenesDoc);
  const needed = [...scenesDoc.scenes.map((s) => s.id), ...negDoc.nearMiss.items.map((n) => n.id)];
  validateCandidatesDoc(candDoc, needed);
  const cands = (id) => candDoc.scenes[id].candidates;
  const items = [];
  for (const s of scenesDoc.scenes) items.push({ itemId: s.id, kind: 'positive', split: split[s.id], category: s.category, description: s.description, visualTarget: s.visualTarget, candidateScene: s.id, candidates: cands(s.id) });
  for (const x of negDoc.crossCategory.items) {
    const d = scenesDoc.scenes.find((s) => s.id === x.descriptionScene);
    items.push({ itemId: x.id, kind: 'cross', split: x.split, category: null, description: d.description, visualTarget: d.visualTarget, candidateScene: x.imageScene, candidates: cands(x.imageScene) });
  }
  for (const n of negDoc.nearMiss.items) items.push({ itemId: n.id, kind: 'nearmiss', conditionType: n.conditionType, split: n.split, category: null, description: n.description, visualTarget: n.visualTarget, candidateScene: n.id, candidates: cands(n.id) });
  return items;
}

// ------------------------------------------------------------------ judgments
export function validateJudgments(j, items, label = 'judgments') {
  if (!isObj(j) || j.schema !== 'scene-relevance-v2-judgments') fail(`${label}: wrong or missing schema`);
  if (typeof j.reviewerId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(j.reviewerId)) fail(`${label}: reviewerId must be 1-32 chars of A-Z a-z 0-9 _ -`);
  for (const k of ['aiSuggestedLabels', 'sawModelScoresFirst']) if (typeof j[k] !== 'boolean') fail(`${label}: ${k} must be true or false`);
  if (typeof j.judgedAt !== 'string' || Number.isNaN(Date.parse(j.judgedAt))) fail(`${label}: judgedAt must be an ISO date`);
  if (!isObj(j.items)) fail(`${label}: items missing`);
  const known = new Map(items.map((i) => [i.itemId, new Set(i.candidates.map((c) => c.candidateId))]));
  for (const k of Object.keys(j.items)) if (!known.has(k)) fail(`${label}: unknown item ${k}`);
  for (const [id, ids] of known) {
    const e = j.items[id];
    if (!isObj(e)) fail(`${label}: item ${id} missing`);
    if (e.reviewed !== true) fail(`${label}: item ${id} not reviewed`);
    if (typeof e.noneSuitable !== 'boolean') fail(`${label}: ${id}.noneSuitable must be boolean`);
    if (!isStrArr(e.relevant) || !isStrArr(e.best)) fail(`${label}: ${id} relevant/best must be string arrays`);
    if (new Set(e.relevant).size !== e.relevant.length || new Set(e.best).size !== e.best.length) fail(`${label}: ${id} duplicate candidate ids`);
    for (const c of [...e.relevant, ...e.best]) if (!ids.has(c)) fail(`${label}: ${id} references unknown candidate ${c}`);
    if (e.best.some((b) => !e.relevant.includes(b))) fail(`${label}: ${id} has a best candidate that is not relevant`);
    if (e.noneSuitable && e.relevant.length) fail(`${label}: ${id} is noneSuitable but lists relevant candidates`);
    if (!e.noneSuitable && e.relevant.length === 0) fail(`${label}: ${id} has no relevant candidate and is not marked noneSuitable`);
    if (e.notes !== undefined && typeof e.notes !== 'string') fail(`${label}: ${id}.notes must be a string`);
  }
  return j;
}

// ------------------------------------------------ candidate + image integrity
// The freeze binds (a) the exact candidates.json bytes (it is in FROZEN_FILES) and (b) the SHA-256 of every
// evaluated image's BYTES, stored in the manifest as candidateIntegrity: { candidatesSha256, imageCount,
// images: { <sha256>: [{ candidateId, sceneId }] } } (one image can sit under several candidates). A filename or
// path is never trusted: only the hash of the bytes read from disk counts. Nothing here repairs or regenerates a
// hash; any difference throws. The manifest is not reviewer-facing, and no image bytes are stored in it.
const HEX64 = /^[0-9a-f]{64}$/;
export const sceneIdOfCandidate = (candidateId) => candidateId.slice(0, candidateId.lastIndexOf('-'));

export function uniqueCandidates(items) {
  const out = new Map();
  for (const it of items) for (const c of it.candidates) {
    const prev = out.get(c.candidateId);
    if (prev && (prev.sha256 !== c.sha256 || prev.localPath !== c.localPath)) fail(`candidate ${c.candidateId} is described inconsistently across items`);
    out.set(c.candidateId, c);
  }
  return out;
}

function imageBytesSha(evalDir, c) {
  const root = path.resolve(evalDir); const p = path.resolve(root, ...String(c.localPath).split('/'));
  if (path.isAbsolute(c.localPath) || (p !== root && !p.startsWith(root + path.sep))) fail(`image path for ${c.candidateId} leaves the evaluation folder`);
  if (!fs.existsSync(p)) fail(`image file missing for ${c.candidateId}`);
  return sha256File(p);
}

// Hashes every evaluated image from disk and requires it to equal the sha256 recorded in candidates.json.
export function buildCandidateIntegrity(evalDir, items, candidatesSha256) {
  if (!HEX64.test(candidatesSha256 || '')) fail('candidatesSha256 must be a SHA-256 hex digest');
  const images = {}; let n = 0;
  for (const c of [...uniqueCandidates(items).values()].sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1))) {
    const h = imageBytesSha(evalDir, c);
    if (h !== c.sha256) fail(`image bytes for ${c.candidateId} do not match the sha256 in candidates.json`);
    (images[h] ||= []).push({ candidateId: c.candidateId, sceneId: sceneIdOfCandidate(c.candidateId) }); n++;
  }
  return { candidatesSha256, imageCount: n, images };
}

export function validateCandidateIntegrity(ci) {
  if (!isObj(ci)) fail('manifest: candidateIntegrity is missing (a freeze must record candidate and image hashes)');
  if (!HEX64.test(ci.candidatesSha256 || '')) fail('manifest: candidateIntegrity.candidatesSha256 missing or malformed');
  if (!isObj(ci.images) || !Number.isInteger(ci.imageCount) || ci.imageCount < 1) fail('manifest: candidateIntegrity.images missing or empty');
  const seen = new Set(); let n = 0;
  for (const [h, list] of Object.entries(ci.images)) {
    if (!HEX64.test(h) || !Array.isArray(list) || list.length === 0) fail('manifest: candidateIntegrity has a malformed image entry');
    for (const e of list) {
      if (!isObj(e) || typeof e.candidateId !== 'string' || typeof e.sceneId !== 'string' || sceneIdOfCandidate(e.candidateId) !== e.sceneId) fail('manifest: candidateIntegrity has an inconsistent candidate/scene mapping');
      if (seen.has(e.candidateId)) fail(`manifest: candidateIntegrity lists ${e.candidateId} twice`);
      seen.add(e.candidateId); n++;
    }
  }
  if (n !== ci.imageCount) fail('manifest: candidateIntegrity.imageCount does not match its entries');
  return ci;
}

// Re-hashes candidates.json and every image now on disk against the frozen record. Throws on ANY difference
// (changed or missing manifest, changed/missing/extra/unlisted image).
export function verifyCandidateIntegrity(evalDir, items, ci) {
  validateCandidateIntegrity(ci);
  const cp = path.join(evalDir, CANDIDATES_FILE);
  if (!fs.existsSync(cp) || sha256File(cp) !== ci.candidatesSha256) fail(`${CANDIDATES_FILE} changed after freezing (hash mismatch)`);
  const frozen = new Map();
  for (const [h, list] of Object.entries(ci.images)) for (const e of list) frozen.set(e.candidateId, h);
  const cands = uniqueCandidates(items);
  for (const [id, c] of cands) {
    const want = frozen.get(id);
    if (!want) fail(`candidate ${id} is not in the frozen image record`);
    if (c.sha256 !== want) fail(`candidate ${id}: candidates.json hash differs from the frozen image record`);
    if (imageBytesSha(evalDir, c) !== want) fail(`image bytes changed after freezing: ${id}`);
  }
  if (frozen.size !== cands.size) fail('the frozen image record lists candidates that are not part of the current evaluation');
  return true;
}

export const candidateIntegritySha256 = (ci) => sha256Hex(stableStringify(ci));

export function validateManifest(m) {
  if (!isObj(m) || m.schema !== 'scene-relevance-v2-judgments-manifest') fail('manifest: wrong schema');
  if (typeof m.frozenAt !== 'string' || Number.isNaN(Date.parse(m.frozenAt))) fail('manifest: frozenAt missing');
  if (!isObj(m.frozenFiles) || !isObj(m.judgmentFiles) || typeof m.primaryReviewer !== 'string') fail('manifest: malformed');
  for (const f of FROZEN_FILES) if (!/^[0-9a-f]{64}$/.test(m.frozenFiles[f] || '')) fail(`manifest: missing hash for ${f}`);
  const ci = validateCandidateIntegrity(m.candidateIntegrity);
  if (ci.candidatesSha256 !== m.frozenFiles[CANDIDATES_FILE]) fail(`manifest: candidateIntegrity does not match the frozen hash of ${CANDIDATES_FILE}`);
  if (!Object.keys(m.judgmentFiles).length) fail('manifest: no judgment files');
  for (const [f, h] of Object.entries(m.judgmentFiles)) if (!/^judgments-[A-Za-z0-9_-]+\.json$/.test(f) || !/^[0-9a-f]{64}$/.test(h)) fail(`manifest: bad entry ${f}`);
  return m;
}

// Verifies the frozen manifest against the files on disk. Never rewrites anything.
export function loadFrozen(evalDir, items) {
  const mp = path.join(evalDir, 'judgments-manifest.json');
  if (!fs.existsSync(mp)) fail('judgments-manifest.json is missing: judgments are not frozen (run the freeze script first)');
  const manifest = validateManifest(readJsonStrict(mp));
  for (const [f, h] of Object.entries(manifest.frozenFiles)) {
    if (!fs.existsSync(path.join(evalDir, f)) || sha256File(path.join(evalDir, f)) !== h) fail(`${f} changed after freezing (hash mismatch)`);
  }
  const judgments = {};
  for (const [f, h] of Object.entries(manifest.judgmentFiles)) {
    const p = path.join(evalDir, f);
    if (!fs.existsSync(p)) fail(`${f} is missing`);
    if (sha256File(p) !== h) fail(`${f} changed after freezing (hash mismatch)`);
    const j = validateJudgments(readJsonStrict(p), items, f);
    if (f !== `judgments-${j.reviewerId}.json`) fail(`${f}: file name does not match reviewerId ${j.reviewerId}`);
    judgments[j.reviewerId] = j;
  }
  if (!judgments[manifest.primaryReviewer]) fail('primary reviewer has no frozen judgments file');
  verifyCandidateIntegrity(evalDir, items, manifest.candidateIntegrity);
  return { manifest, manifestSha256: sha256File(mp), judgments };
}

// ------------------------------------------------- freeze lifecycle guard (fetch)
export const MANIFEST_FILE = 'judgments-manifest.json';

// Classifies the evaluation folder from directory entries alone (names are compared case-insensitively, as on
// Windows). Nothing is parsed, repaired or removed. Only 'clean' allows candidate collection:
//   frozen        judgments-manifest.json exists (valid or not, file or directory)
//   inconsistent  freeze-era artefacts (judgments, results, rule, report) exist WITHOUT the manifest
//   ambiguous     the folder cannot be listed, or a manifest-like name that is not exactly the manifest exists
//   review-started  the answer key, a blind export or the contact sheet exists: candidates are already bound to a review
export function freezeState(evalDir) {
  let names;
  try { names = fs.readdirSync(evalDir); } catch (e) {
    if (e.code === 'ENOENT') return { state: 'clean', reasons: [] };
    return { state: 'ambiguous', reasons: [`cannot list ${evalDir}: ${e.code || e.message}`] };
  }
  const lower = names.map((n) => n.toLowerCase());
  const has = (re) => lower.filter((n) => re.test(n));
  if (lower.includes(MANIFEST_FILE)) return { state: 'frozen', reasons: [`${MANIFEST_FILE} exists`] };
  const manifestLike = has(/^judgments-manifest/);
  if (manifestLike.length) return { state: 'ambiguous', reasons: [`unexpected manifest-like entries: ${manifestLike.join(', ')}`] };
  const residue = has(/^(judgments-.+\.json|results\.json|frozen-rule\.json|metrics\.json|report\.md)$/);
  if (residue.length) return { state: 'inconsistent', reasons: [`freeze-era files exist without ${MANIFEST_FILE}: ${residue.join(', ')}`] };
  const review = has(/^(answer-key\.json|blind-judgments-.+\.json|contact-sheet\.html|review-assets)$/);
  if (review.length) return { state: 'review-started', reasons: [`review artefacts exist: ${review.join(', ')}`] };
  return { state: 'clean', reasons: [] };
}

// Throws unless candidate collection is still allowed. Every fetch-side write path calls this first.
export function assertFetchAllowed(evalDir) {
  const { state, reasons } = freezeState(evalDir);
  if (state === 'clean') return true;
  fail(`evaluation folder state is "${state}" (${reasons.join('; ')}). Fetching, archiving and rewriting candidates are refused. A freeze is never removed or replaced; a new evaluation needs its own evaluation folder and preregistration (see FREEZE-EVIDENCE.md).`);
}

// ------------------------------------------------------------ pinned model identity
// Values come from the repository's existing pinned evidence (THIRD_PARTY_NOTICES.md "Pinned artifacts" and
// PREREGISTRATION.md section 12); a test checks both documents still agree with these constants. Only the two ONNX
// files have recorded hashes. The model folder carries no revision metadata, so the revision is enforced only through
// those hashes (they match the Hugging Face X-Linked-ETag for that revision, per the notices). The tokenizer, config and
// preprocessor files have NO recorded hashes in the repository and are therefore not pinned here.
export const PINNED_MODEL = Object.freeze({
  repo: 'Xenova/siglip-base-patch16-224',
  revision: '4649052661e53c7000355844105f8a1792088239',
  files: Object.freeze({
    'onnx/text_model_quantized.onnx': 'ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2',
    'onnx/vision_model_quantized.onnx': 'ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058'
  })
});
export const UNPINNED_MODEL_FILES = ['config.json', 'preprocessor_config.json', 'tokenizer.json']; // observed, never enforced

export function validatePins(p) {
  if (!isObj(p) || typeof p.repo !== 'string' || !p.repo || !/^[0-9a-f]{40}$/.test(p.revision || '') || !isObj(p.files) || !Object.keys(p.files).length) fail('model pins: malformed (repo, 40-hex revision and a non-empty files map are required)');
  for (const [rel, h] of Object.entries(p.files)) if (!/^[A-Za-z0-9_./-]+$/.test(rel) || rel.split('/').includes('..') || path.isAbsolute(rel) || !HEX64.test(h)) fail(`model pins: bad entry ${rel}`);
  return p;
}

function hashFileStream(p) {
  const h = crypto.createHash('sha256'); const fd = fs.openSync(p, 'r');
  try { const buf = Buffer.allocUnsafe(1 << 20); let n; let bytes = 0; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) { h.update(buf.subarray(0, n)); bytes += n; } return { sha256: h.digest('hex'), bytes }; }
  finally { fs.closeSync(fd); }
}

export const modelIdentitySha256 = (pins, hashes) => sha256Hex(stableStringify({ repo: pins.repo, revision: pins.revision, files: hashes }));

export function buildModelIdentityRecord(pins, files, { pinSource = 'repository', verifiedBeforeInference = true, verifiedAfterInference = false } = {}) {
  const hashes = Object.fromEntries(Object.entries(files).map(([rel, f]) => [rel, f.sha256]));
  return { schema: 'scene-relevance-v2-model-identity', repo: pins.repo, revision: pins.revision, revisionBasis: 'enforced only through the pinned file hashes; the model folder carries no revision metadata', pinSource, files, identitySha256: modelIdentitySha256(pins, hashes), verifiedBeforeInference, verifiedAfterInference };
}

// Hashes the ACTUAL bytes of every pinned file and compares with the pins. Throws (so inference never starts) if a file
// is missing, unreadable, not a regular file (symlinks and directories are refused), or has a different hash.
export function verifyModelIdentity(modelDir, pins = PINNED_MODEL, opts = {}) {
  validatePins(pins);
  if (typeof modelDir !== 'string' || !modelDir) fail('model directory is not set');
  const root = path.resolve(modelDir);
  let st; try { st = fs.lstatSync(root); } catch (e) { fail(`model directory cannot be read: ${e.code || e.message}`); }
  if (!st.isDirectory()) fail('model path is not a directory');
  const files = {};
  for (const [rel, want] of Object.entries(pins.files)) {
    const p = path.join(root, ...rel.split('/'));
    let s; try { s = fs.lstatSync(p); } catch (e) { fail(`pinned model file missing or unreadable: ${rel} (${e.code || e.message})`); }
    if (!s.isFile()) fail(`pinned model file is not a regular file (symlinks and directories are refused): ${rel}`);
    let r; try { r = hashFileStream(p); } catch (e) { fail(`pinned model file cannot be read: ${rel} (${e.code || e.message})`); }
    if (r.sha256 !== want) fail(`pinned model file ${rel} has SHA-256 ${r.sha256}, expected ${want}; inference refused`);
    if (r.bytes !== s.size) fail(`pinned model file ${rel} changed while it was being verified`);
    files[rel] = { sha256: r.sha256, bytes: r.bytes };
  }
  return buildModelIdentityRecord(pins, files, opts);
}

// What the REPORT checks: the recorded identity must equal the repository pins, must come from the repository pins (not a
// test override), and must say it was verified before AND after inference. A hash merely recorded is not enough.
export function validateModelIdentityRecord(rec, pins = PINNED_MODEL) {
  if (!isObj(rec) || rec.schema !== 'scene-relevance-v2-model-identity') fail('results.json: model identity record is missing (the run did not verify the pinned model files)');
  if (rec.pinSource !== 'repository') fail(`results.json: model identity was checked against ${JSON.stringify(rec.pinSource)} pins, not the repository pins`);
  if (rec.repo !== pins.repo || rec.revision !== pins.revision) fail('results.json: model repo or revision differs from the pinned evidence');
  if (!isObj(rec.files) || Object.keys(rec.files).sort().join('|') !== Object.keys(pins.files).sort().join('|')) fail('results.json: recorded model files differ from the pinned file set');
  const hashes = {};
  for (const [rel, want] of Object.entries(pins.files)) {
    const f = rec.files[rel];
    if (!isObj(f) || f.sha256 !== want) fail(`results.json: recorded SHA-256 for ${rel} differs from the pinned value`);
    if (!Number.isInteger(f.bytes) || f.bytes < 1) fail(`results.json: recorded size for ${rel} is invalid`);
    hashes[rel] = f.sha256;
  }
  if (rec.identitySha256 !== modelIdentitySha256(pins, hashes)) fail('results.json: model identity digest is inconsistent with its files');
  if (rec.verifiedBeforeInference !== true || rec.verifiedAfterInference !== true) fail('results.json: model files were not verified both before and after inference');
  return rec;
}

// -------------------------------------------------------------------- results
export function validateResults(r, items) {
  if (!isObj(r) || r.schema !== 'scene-relevance-v2-results' || !isObj(r.meta) || !Array.isArray(r.items)) fail('results.json: wrong schema');
  const byId = new Map(items.map((i) => [i.itemId, i]));
  const seen = new Set();
  for (const rec of r.items) {
    const it = byId.get(rec?.itemId);
    if (!it) fail(`results.json: unknown item ${rec?.itemId}`);
    if (seen.has(rec.itemId)) fail(`results.json: duplicate item ${rec.itemId}`); seen.add(rec.itemId);
    if (typeof rec.ok !== 'boolean' || !Number.isFinite(rec.ms) || rec.ms < 0 || !Array.isArray(rec.ranking)) fail(`results.json: ${rec.itemId} malformed`);
    const expect = new Set(it.candidates.map((c) => c.candidateId));
    if (rec.ranking.length !== expect.size) fail(`results.json: ${rec.itemId} ranking size mismatch`);
    const ids = new Set();
    for (const x of rec.ranking) {
      if (!expect.has(x.candidateId) || ids.has(x.candidateId)) fail(`results.json: ${rec.itemId} bad or duplicate candidate ${x.candidateId}`);
      ids.add(x.candidateId);
      if (x.score !== null && !(typeof x.score === 'number' && Number.isFinite(x.score))) fail(`results.json: ${rec.itemId}/${x.candidateId} malformed score`);
    }
    if (rec.ok && !rec.ranking.some((x) => x.score !== null)) fail(`results.json: ${rec.itemId} marked ok with no scores`);
  }
  for (const id of byId.keys()) if (!seen.has(id)) fail(`results.json: item ${id} has no result`);
  return r;
}

// ------------------------------------------------------------------- metrics
// Worst-case tie handling: among equal scores, candidates NOT in `good` come
// first, so a tie at the top only counts as a success if every tied top
// candidate is good.
export function orderWorstCase(scored, good) {
  return [...scored].sort((a, b) => (b.score - a.score) || ((good.has(a.candidateId) ? 1 : 0) - (good.has(b.candidateId) ? 1 : 0)) || (a.candidateId < b.candidateId ? -1 : 1));
}

export const pct = (n, d) => (d === 0 ? 'n/a' : `${n}/${d} (${Math.round((1000 * n) / d) / 10}%)`);

// Per-scene outcome for one positive item under one reviewer's judgments.
export function sceneOutcome(item, rec, j) {
  const rel = new Set(j.relevant); const best = new Set(j.best);
  const out = { itemId: item.itemId, eligible: rel.size > 0, noneSuitable: j.noneSuitable, modelFailed: !rec.ok, top1: false, top3: false, bestDen: best.size > 0, bestFirst: false, pairHalves: 0, pairTotal: 0, baselineTop1: false, baselineAvailable: false, tiedAtTop: false };
  const nonRel = item.candidates.map((c) => c.candidateId).filter((id) => !rel.has(id));
  out.pairTotal = rel.size * nonRel.length;
  const first = [...item.candidates].sort((a, b) => a.searchRank - b.searchRank)[0];
  if (first.searchRank === 1) { out.baselineAvailable = true; out.baselineTop1 = rel.has(first.candidateId); }
  if (!rec.ok) return out;
  const scored = rec.ranking.filter((x) => x.score !== null);
  const worst = orderWorstCase(scored, rel);
  out.top1 = worst.length > 0 && rel.has(worst[0].candidateId);
  out.top3 = worst.slice(0, 3).some((x) => rel.has(x.candidateId));
  out.tiedAtTop = scored.filter((x) => x.score === worst[0]?.score).length > 1;
  if (best.size) out.bestFirst = best.has(orderWorstCase(scored, best)[0]?.candidateId);
  const sc = new Map(scored.map((x) => [x.candidateId, x.score]));
  for (const a of rel) for (const b of nonRel) {
    if (!sc.has(a) || !sc.has(b)) continue; // unscored pair counts as wrong (0)
    out.pairHalves += sc.get(a) > sc.get(b) ? 2 : sc.get(a) === sc.get(b) ? 1 : 0;
  }
  return out;
}

export function aggregatePositives(outcomes, scenes) {
  const el = outcomes.filter((o) => o.eligible);
  const sum = (f) => el.filter(f).length;
  const cats = {};
  for (const s of scenes) cats[s.category] ||= { scenes: 0, successes: 0 };
  const catOf = new Map(scenes.map((s) => [s.itemId ?? s.id, s.category]));
  for (const o of outcomes) { cats[catOf.get(o.itemId)].scenes++; if (o.eligible && o.top1) cats[catOf.get(o.itemId)].successes++; }
  return {
    scenes: outcomes.length, eligible: el.length, noneSuitable: outcomes.filter((o) => o.noneSuitable).length,
    top1: sum((o) => o.top1), top3: sum((o) => o.top3), tiedAtTop: sum((o) => o.tiedAtTop),
    bestDen: sum((o) => o.bestDen), bestFirst: sum((o) => o.bestDen && o.bestFirst),
    pairHalves: el.reduce((a, o) => a + o.pairHalves, 0), pairTotal: el.reduce((a, o) => a + o.pairTotal, 0),
    baselineTop1: sum((o) => o.baselineTop1), baselineMissing: el.filter((o) => !o.baselineAvailable).length,
    modelFailedEligible: sum((o) => o.modelFailed), modelFailedAll: outcomes.filter((o) => o.modelFailed).length,
    categories: cats
  };
}

// Integer-only comparisons so float rounding cannot flip a verdict.
export function decide(agg) {
  const C = CRITERIA; const why = []; const n = agg.eligible;
  if (agg.baselineMissing > 0) return { verdict: 'INVALID', why: [`the Pixabay-first baseline is unavailable for ${agg.baselineMissing} scene(s) (no candidate with search rank 1)`] };
  if (n === 0) return { verdict: 'INCONCLUSIVE', why: ['zero eligible held-out scenes (none had a relevant candidate), so no rate can be computed'] };
  if (n < C.minEligibleHeldOut) return { verdict: 'INCONCLUSIVE', why: [`only ${n} eligible held-out scenes (< ${C.minEligibleHeldOut} preregistered minimum)`] };
  if (agg.pairTotal === 0) return { verdict: 'INCONCLUSIVE', why: ['no relevant/non-relevant pairs exist, so pairwise accuracy is undefined'] };
  const top1Ok = agg.top1 * 100 >= C.promising.top1Pct * n;
  const pairOk = agg.pairHalves * 100 >= C.promising.pairwisePct * 2 * agg.pairTotal;
  const marginOk = (agg.top1 - agg.baselineTop1) * 100 >= C.promising.baselineMarginPp * n;
  const catEntries = Object.entries(agg.categories);
  const covOk = catEntries.every(([, v]) => v.successes >= C.promising.minCategorySuccesses);
  const t1Floor = agg.top1 * 100 <= C.notPromising.top1AtMostPct * n;
  const pwFloor = agg.pairHalves * 100 <= C.notPromising.pairwiseAtMostPct * 2 * agg.pairTotal;
  const noBetter = agg.top1 <= agg.baselineTop1;
  if (top1Ok && pairOk && marginOk && covOk) return { verdict: 'PROMISING', why: ['all four held-out criteria pass'] };
  if (t1Floor || pwFloor || noBetter) {
    if (t1Floor) why.push(`top-1 ${pct(agg.top1, n)} is at or below ${C.notPromising.top1AtMostPct}%`);
    if (pwFloor) why.push(`pairwise ${pct(agg.pairHalves / 2, agg.pairTotal)} is at or below ${C.notPromising.pairwiseAtMostPct}%`);
    if (noBetter) why.push(`top-1 (${agg.top1}/${n}) is no better than the Pixabay-first baseline (${agg.baselineTop1}/${n})`);
    return { verdict: 'NOT PROMISING', why };
  }
  if (!top1Ok) why.push(`top-1 ${pct(agg.top1, n)} below ${C.promising.top1Pct}%`);
  if (!pairOk) why.push(`pairwise ${pct(agg.pairHalves / 2, agg.pairTotal)} below ${C.promising.pairwisePct}%`);
  if (!marginOk) why.push(`top-1 is less than ${C.promising.baselineMarginPp} points above the baseline (${agg.top1}/${n} vs ${agg.baselineTop1}/${n})`);
  if (!covOk) why.push(`category coverage failed in: ${catEntries.filter(([, v]) => v.successes < 1).map(([k]) => k).join(', ')}`);
  return { verdict: 'INCONCLUSIVE', why: ['between the preregistered thresholds: ' + why.join('; ')] };
}

// --------------------------------------------- unsuitable-set detection (rule)
export function itemStats(ranking) {
  const s = ranking.filter((x) => x.score !== null).map((x) => x.score).sort((a, b) => b - a);
  if (s.length < 2) return null;
  const mid = s.length >> 1; const median = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return { topScore: r6(s[0]), gapTop1Top2: r6(s[0] - s[1]), top1MinusMedian: r6(s[0] - median) };
}

export function auroc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const p of pos) for (const q of neg) w += p > q ? 1 : p === q ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

// Classifies each item for the suitable/unsuitable test under the primary reviewer.
export function detectionItems(items, results, j) {
  const rec = new Map(results.items.map((r) => [r.itemId, r]));
  const out = { suitable: [], unsuitable: [], contaminated: [], modelFailed: [] };
  for (const it of items) {
    const e = j.items[it.itemId]; const r = rec.get(it.itemId);
    if (it.kind !== 'positive' && e.relevant.length > 0) { out.contaminated.push(it.itemId); continue; }
    const stats = r.ok ? itemStats(r.ranking) : null;
    if (!stats) { out.modelFailed.push(it.itemId); continue; }
    (e.noneSuitable ? out.unsuitable : out.suitable).push({ itemId: it.itemId, kind: it.kind, split: it.split, stats });
  }
  return out;
}

// Reporting groups for negative sets. Absence/negation near-misses ("empty", "no one") are kept apart from
// ordinary near-misses so a negation weakness is never folded into a claim about ordinary scene relevance.
export const DETECTION_GROUPS = ['positive', 'cross', 'nearmiss', 'absence'];
export const detectionGroupOf = (item) => (item.kind === 'nearmiss' ? (item.conditionType === 'absence' ? 'absence' : 'nearmiss') : item.kind);

// Items DESIGNED per group and split (before any exclusion), so denominators are visible even when items drop out.
export function designedCounts(items) {
  const out = {};
  for (const g of DETECTION_GROUPS) out[g] = { calibration: 0, heldout: 0 };
  for (const it of items) out[detectionGroupOf(it)][it.split]++;
  return out;
}

// Splits a detectionItems() result into the headline set (everything except absence items) and the absence set.
export function partitionDetection(det, items) {
  const g = new Map(items.map((i) => [i.itemId, detectionGroupOf(i)]));
  const pick = (pred) => ({
    suitable: det.suitable.filter((x) => pred(g.get(x.itemId))), unsuitable: det.unsuitable.filter((x) => pred(g.get(x.itemId))),
    contaminated: det.contaminated.filter((id) => pred(g.get(id))), modelFailed: det.modelFailed.filter((id) => pred(g.get(id)))
  });
  return { headline: pick((x) => x !== 'absence'), absence: pick((x) => x === 'absence') };
}

// Preregistered rule selection. CALIBRATION items only.
export function selectRule(cal) {
  const R = CRITERIA.rule; const base = { counts: { suitable: cal.suitable.length, unsuitable: cal.unsuitable.length } };
  if (cal.suitable.length < R.minPerClass || cal.unsuitable.length < R.minPerClass) return { ...base, status: 'none', reason: `calibration has ${cal.suitable.length} suitable and ${cal.unsuitable.length} unsuitable items (need >= ${R.minPerClass} of each)` };
  const table = R.statistics.map((s) => ({ statistic: s, auroc: auroc(cal.suitable.map((x) => x.stats[s]), cal.unsuitable.map((x) => x.stats[s])) }));
  let pick = table[0]; for (const t of table) if (t.auroc > pick.auroc) pick = t;
  if (pick.auroc < R.minAuroc) return { ...base, status: 'none', table, reason: `best calibration AUROC ${pick.auroc.toFixed(3)} (${pick.statistic}) is below the preregistered floor ${R.minAuroc}` };
  const vals = [...new Set([...cal.suitable, ...cal.unsuitable].map((x) => x.stats[pick.statistic]))].sort((a, b) => a - b);
  let best = null;
  for (let i = 0; i + 1 < vals.length; i++) {
    const thr = Math.round(((vals[i] + vals[i + 1]) / 2) * 1e6) / 1e6;
    const tpr = cal.suitable.filter((x) => x.stats[pick.statistic] >= thr).length / cal.suitable.length;
    const tnr = cal.unsuitable.filter((x) => x.stats[pick.statistic] < thr).length / cal.unsuitable.length;
    const bal = (tpr + tnr) / 2;
    if (!best || bal > best.bal + 1e-12 || (Math.abs(bal - best.bal) <= 1e-12 && thr > best.thr)) best = { thr, bal };
  }
  if (!best) return { ...base, status: 'none', table, reason: 'no distinct statistic values to place a threshold between' };
  return { ...base, status: 'selected', statistic: pick.statistic, threshold: best.thr, calibrationBalancedAccuracy: best.bal, calibrationAuroc: pick.auroc, table };
}

export function evaluateRule(rule, held) {
  const acc = (x) => x.stats[rule.statistic] >= rule.threshold;
  return {
    auroc: auroc(held.suitable.map((x) => x.stats[rule.statistic]), held.unsuitable.map((x) => x.stats[rule.statistic])),
    falseRejection: { count: held.suitable.filter((x) => !acc(x)).length, of: held.suitable.length },
    falseAcceptance: { count: held.unsuitable.filter(acc).length, of: held.unsuitable.length }
  };
}

// ------------------------------------------------- fetch: insufficient-scene gate
// A scene the fetch recorded as insufficient (too few hits or too few downloads) is NEVER skipped or retried
// silently. The owner records an explicit decision in fetch-owner-decisions.json, bound to the SHA-256 of the exact
// recorded failure, so an old decision cannot approve a later failure. Only 'retry-same-query' exists: a different
// query changes scenes.json/negatives.json and needs a new preregistration, not a fetch decision.
export const recordSha256 = (rec) => sha256Hex(stableStringify(rec));

export function validateFetchDecisions(doc) {
  if (!isObj(doc) || doc.schema !== 'scene-relevance-v2-fetch-owner-decisions' || !Array.isArray(doc.decisions)) fail(`${FETCH_DECISIONS_FILE}: wrong schema`);
  const seen = new Set();
  for (const d of doc.decisions) {
    if (!isObj(d) || typeof d.sceneId !== 'string' || !/^([A-F]\d{2}|NM\d{2})$/.test(d.sceneId)) fail(`${FETCH_DECISIONS_FILE}: bad sceneId`);
    if (!/^[0-9a-f]{64}$/.test(d.recordSha256 || '')) fail(`${FETCH_DECISIONS_FILE}: ${d.sceneId} bad recordSha256`);
    if (d.decision !== 'retry-same-query') fail(`${FETCH_DECISIONS_FILE}: ${d.sceneId} decision must be "retry-same-query" (a query change needs a new preregistration)`);
    for (const k of ['decidedBy', 'reason']) if (typeof d[k] !== 'string' || !d[k].trim()) fail(`${FETCH_DECISIONS_FILE}: ${d.sceneId}.${k} is required`);
    if (typeof d.decidedAt !== 'string' || Number.isNaN(Date.parse(d.decidedAt))) fail(`${FETCH_DECISIONS_FILE}: ${d.sceneId}.decidedAt must be an ISO date`);
    const key = `${d.sceneId}:${d.recordSha256}`; if (seen.has(key)) fail(`${FETCH_DECISIONS_FILE}: duplicate decision for ${d.sceneId}`); seen.add(key);
  }
  return doc;
}

// Pure check over EVERY scene recorded in candidates.json. blocked => the whole fetch run must stop before any network call.
export function insufficientGate(candDoc, decisionsDoc) {
  const blocked = []; const approved = [];
  for (const [sceneId, rec] of Object.entries(candDoc?.scenes ?? {})) {
    const sha = recordSha256(rec);
    if (rec?.status === 'ok' && Array.isArray(rec.candidates) && rec.candidates.length >= MIN_CANDIDATES) continue;
    const why = rec?.status === 'insufficient' ? `recorded as insufficient (${rec.insufficientReason ?? 'reason not recorded'})` : `unrecognised state (status ${JSON.stringify(rec?.status)})`;
    const d = decisionsDoc?.decisions?.find((x) => x.sceneId === sceneId && x.recordSha256 === sha);
    if (d && rec?.status === 'insufficient') approved.push({ sceneId, recordSha256: sha, decision: d });
    else blocked.push({ sceneId, recordSha256: sha, reason: why });
  }
  return { blocked, approved };
}

// Moves an approved scene's record (and its image folder) into attemptHistory so nothing collected is lost,
// then removes it from scenes so the retry starts clean. Candidate files are renamed, never deleted or overwritten.
export function archiveInsufficientScene(candDoc, sceneId, decision, evalDir, now = new Date().toISOString()) {
  assertFetchAllowed(evalDir); // defence in depth: never rename or rewrite anything once a freeze (or review) exists
  const rec = candDoc.scenes[sceneId];
  if (rec?.status !== 'insufficient') fail(`${sceneId}: only an insufficient scene can be archived for retry`);
  if (decision.recordSha256 !== recordSha256(rec)) fail(`${sceneId}: owner decision does not match the recorded failure`);
  candDoc.attemptHistory ??= {}; candDoc.attemptHistory[sceneId] ??= [];
  const n = candDoc.attemptHistory[sceneId].length + 1;
  const from = path.join(evalDir, 'images', sceneId); const toRel = `images/${sceneId}.attempt${n}`; const to = path.join(evalDir, ...toRel.split('/'));
  if (fs.existsSync(to)) fail(`${toRel} already exists; refusing to overwrite an archived attempt`);
  const archived = { ...rec, candidates: rec.candidates.map((c) => ({ ...c, localPath: String(c.localPath).replace(`images/${sceneId}/`, `${toRel}/`) })) };
  if (fs.existsSync(from)) fs.renameSync(from, to);
  candDoc.attemptHistory[sceneId].push({ attempt: n, archivedAt: now, ownerDecision: decision, recordSha256: decision.recordSha256, record: archived });
  delete candDoc.scenes[sceneId];
  return n;
}

// ---------------------------------------------------- reviewer agreement, timing
export function cohenKappa(a, b) {
  if (a.length !== b.length || a.length === 0) return { status: 'undefined', reason: 'no common labels' };
  const n = a.length; let agree = 0; let a1 = 0; let b1 = 0;
  for (let i = 0; i < n; i++) { if (a[i] === b[i]) agree++; if (a[i]) a1++; if (b[i]) b1++; }
  const po = agree / n; const pe = (a1 / n) * (b1 / n) + ((n - a1) / n) * ((n - b1) / n);
  if (pe === 1) return { status: 'undefined', reason: 'expected agreement is 1 (a reviewer used one label throughout)', agree, n };
  return { status: 'ok', kappa: (po - pe) / (1 - pe), agree, n };
}

export function agreementBetween(items, jA, jB) {
  const a = []; const b = [];
  for (const it of items) for (const c of it.candidates) {
    a.push(jA.items[it.itemId].relevant.includes(c.candidateId)); b.push(jB.items[it.itemId].relevant.includes(c.candidateId));
  }
  return cohenKappa(a, b);
}

export function estimateLoadVsInference(timing) {
  const rows = (timing || []).filter((t) => t && t.oneImageMs?.length && t.allImagesMs?.length && t.images > 1);
  if (!rows.length) return null;
  const mean = (x) => x.reduce((p, q) => p + q, 0) / x.length;
  const m1 = mean(rows.flatMap((t) => t.oneImageMs));
  const perImage = mean(rows.map((t) => (mean(t.allImagesMs) - mean(t.oneImageMs)) / (t.images - 1)));
  return { scenes: rows.map((t) => t.sceneId), meanOneImageMs: Math.round(m1), perImageMs: Math.round(perImage), fixedLoadMs: Math.round(m1 - perImage) };
}

export const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// ------------------------------------------------------- blind sheet answer key
// The reviewer-facing sheet shows ONLY random opaque IDs. This key (kept OUT of
// the reviewer's folder) is the sole link from opaque IDs back to item and
// candidate IDs. It is created once with crypto randomness, never regenerated,
// hashed at freeze time, and used to translate the reviewer's blind export.
// Item order and in-item candidate order are the order stored here (random, not
// derivable from any public ID). Each (item, candidate) pair gets its own opaque
// candidate ID because cross-category items reuse another scene's photos.
const OPAQUE_ITEM = /^i[0-9a-f]{12}$/;
const OPAQUE_CAND = /^c[0-9a-f]{16}$/;
export const BLIND_JUDGMENTS_SCHEMA = 'scene-relevance-v2-blind-judgments';

export function buildAnswerKey(items, rng = { int: (n) => crypto.randomInt(0, n), hex: (b) => crypto.randomBytes(b).toString('hex') }) {
  const shuffle = (a) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = rng.int(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; };
  const used = new Set(); const fresh = (prefix, bytes) => { for (;;) { const v = prefix + rng.hex(bytes); if (!used.has(v)) { used.add(v); return v; } } };
  return {
    schema: 'scene-relevance-v2-answer-key', version: 1, keyId: rng.hex(8), createdAt: new Date().toISOString(),
    items: shuffle(items).map((it) => ({ opaqueItemId: fresh('i', 6), itemId: it.itemId, candidates: shuffle(it.candidates).map((c) => ({ opaqueCandidateId: fresh('c', 8), candidateId: c.candidateId })) }))
  };
}

// Strict check that a stored key still describes exactly the current items.
export function validateAnswerKey(key, items) {
  if (!isObj(key) || key.schema !== 'scene-relevance-v2-answer-key' || key.version !== 1) fail('answer-key.json: wrong schema');
  if (!/^[0-9a-f]{16}$/.test(key.keyId || '')) fail('answer-key.json: bad keyId');
  if (!Array.isArray(key.items) || key.items.length !== items.length) fail('answer-key.json: item count does not match the current evaluation items');
  const byId = new Map(items.map((i) => [i.itemId, i])); const seenItems = new Set(); const seenOpaque = new Set();
  for (const k of key.items) {
    const it = byId.get(k?.itemId);
    if (!it || seenItems.has(k.itemId)) fail('answer-key.json: unknown or duplicate item');
    seenItems.add(k.itemId);
    if (!OPAQUE_ITEM.test(k.opaqueItemId || '') || seenOpaque.has(k.opaqueItemId)) fail('answer-key.json: bad or duplicate opaque item id');
    seenOpaque.add(k.opaqueItemId);
    const want = new Set(it.candidates.map((c) => c.candidateId)); const got = new Set();
    if (!Array.isArray(k.candidates) || k.candidates.length !== want.size) fail(`answer-key.json: candidate set differs for ${k.itemId}`);
    for (const c of k.candidates) {
      if (!want.has(c?.candidateId) || got.has(c.candidateId)) fail(`answer-key.json: candidate set differs for ${k.itemId}`);
      got.add(c.candidateId);
      if (!OPAQUE_CAND.test(c.opaqueCandidateId || '') || seenOpaque.has(c.opaqueCandidateId)) fail('answer-key.json: bad or duplicate opaque candidate id');
      seenOpaque.add(c.opaqueCandidateId);
    }
  }
  return key;
}

// Opaque (reviewer) export -> canonical judgments. Fails closed on anything
// unknown, missing or from a different key; the result is then checked by
// validateJudgments exactly like a hand-written canonical file.
export function translateBlindJudgments(blind, key, label = 'blind judgments') {
  if (!isObj(blind) || blind.schema !== BLIND_JUDGMENTS_SCHEMA) fail(`${label}: wrong or missing schema`);
  if (blind.keyId !== key.keyId) fail(`${label}: made with a different answer key (${blind.keyId} vs ${key.keyId}); judgments are never remapped`);
  if (!isObj(blind.items)) fail(`${label}: items missing`);
  const known = new Map(key.items.map((k) => [k.opaqueItemId, k]));
  for (const o of Object.keys(blind.items)) if (!known.has(o)) fail(`${label}: unknown item id`);
  const items = {};
  for (const [o, k] of known) {
    const e = blind.items[o];
    if (!isObj(e)) fail(`${label}: an item is missing`);
    const back = new Map(k.candidates.map((c) => [c.opaqueCandidateId, c.candidateId]));
    const conv = (a, what) => { if (!isStrArr(a)) fail(`${label}: ${k.itemId} ${what} must be string arrays`); return a.map((x) => back.get(x) ?? fail(`${label}: ${k.itemId} references an unknown candidate`)); };
    items[k.itemId] = { reviewed: e.reviewed, relevant: conv(e.relevant, 'relevant'), best: conv(e.best, 'best'), noneSuitable: e.noneSuitable, notes: e.notes ?? '' };
  }
  return { schema: 'scene-relevance-v2-judgments', reviewerId: blind.reviewerId, judgedAt: blind.judgedAt, aiSuggestedLabels: blind.aiSuggestedLabels, sawModelScoresFirst: blind.sawModelScoresFirst, answerKeyId: key.keyId, items };
}
