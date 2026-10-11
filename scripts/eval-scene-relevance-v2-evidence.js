// EVALUATION ONLY (v2). OFFLINE. Makes a FROZEN evaluation recoverable and detects accidental corruption.
// No network, no model, never modifies the evaluation folder, never creates or alters a manifest.
//
//   record  --out <dir outside the evaluation folder>
//       Requires a valid freeze (re-verifies manifest, frozen files, judgments, candidates.json and every image).
//       Copies the freeze evidence (manifest, frozen files, judgments, blind exports, fetch decisions, images/) into <dir>
//       (which must not exist or be empty), writes EVIDENCE-SHA256SUMS.txt (sha256sum format) and EVIDENCE.json, and prints
//       the manifest SHA-256 that the owner must record somewhere this folder and backup cannot reach.
//   verify  --backup <dir> [--expect-manifest-sha256 <64 hex>]
//       Checks the backup against its own sums (accidental corruption), the live evaluation folder against the backup
//       (every evidence file and every image, plus unlisted extra images), and optionally the manifest hash against the
//       value the owner recorded elsewhere. Exit 0 only if everything matches.
//
// A sidecar hash file and a backup that sit where the same person can edit them together prove nothing about deliberate
// tampering: only a manifest SHA-256 kept independently (see FREEZE-EVIDENCE.md) does.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EVAL_DIR, MANIFEST_FILE, FROZEN_FILES, FETCH_DECISIONS_FILE, readJsonStrict, buildItems, loadFrozen, sha256File, stableStringify } from './eval-scene-relevance-v2-lib.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || DEFAULT_EVAL_DIR);
const argv = process.argv.slice(2); const cmd = argv[0];
const val = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const die = (m) => { console.error(`EVIDENCE ${String(cmd).toUpperCase()} REFUSED: ${m}`); process.exit(1); };
const SUMS = 'EVIDENCE-SHA256SUMS.txt'; const META = 'EVIDENCE.json';
const HEX = /^[0-9a-f]{64}$/;
const inside = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Top-level evidence files (exact names) plus every file under images/. Symlinks and special files are refused.
function evidenceFiles(root) {
  const out = [];
  for (const n of fs.readdirSync(root).sort()) {
    const st = fs.lstatSync(path.join(root, n));
    const wanted = [...FROZEN_FILES, MANIFEST_FILE, FETCH_DECISIONS_FILE].includes(n) || /^(judgments|blind-judgments)-[A-Za-z0-9_-]+\.json$/.test(n);
    if (wanted) { if (!st.isFile()) die(`${n} is not a regular file`); out.push(n); }
  }
  const walk = (rel) => { for (const n of fs.readdirSync(path.join(root, rel)).sort()) { const r = `${rel}/${n}`; const st = fs.lstatSync(path.join(root, r)); if (st.isDirectory()) walk(r); else if (st.isFile()) out.push(r); else die(`${r} is not a regular file or folder (symlinks are refused)`); } };
  if (fs.existsSync(path.join(root, 'images'))) { if (!fs.lstatSync(path.join(root, 'images')).isDirectory()) die('images is not a folder'); walk('images'); }
  return out;
}
const parseSums = (text) => { const m = new Map(); for (const line of text.split('\n').filter(Boolean)) { const x = /^([0-9a-f]{64}) \*(.+)$/.exec(line); if (!x || x[2].includes('..') || path.isAbsolute(x[2])) die(`${SUMS}: malformed line`); m.set(x[2], x[1]); } return m; };

function record() {
  const out = val('--out'); if (!out) die('--out <dir> is required');
  const dest = path.resolve(out);
  if (inside(EVAL_DIR, dest) || inside(dest, EVAL_DIR)) die('the backup folder must be outside the evaluation folder (and must not contain it)');
  if (fs.existsSync(dest) && (!fs.lstatSync(dest).isDirectory() || fs.readdirSync(dest).length)) die('the backup folder must not exist or must be empty; an existing backup is never overwritten');
  let frozen;
  try { frozen = loadFrozen(EVAL_DIR, buildItems(readJsonStrict(path.join(EVAL_DIR, 'scenes.json')), readJsonStrict(path.join(EVAL_DIR, 'negatives.json')), readJsonStrict(path.join(EVAL_DIR, 'candidates.json')))); }
  catch (e) { die(`the evaluation is not a valid freeze: ${e.message}`); }
  const files = evidenceFiles(EVAL_DIR); const sums = [];
  fs.mkdirSync(dest, { recursive: true });
  for (const rel of files) {
    const from = path.join(EVAL_DIR, ...rel.split('/')); const to = path.join(dest, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    const h = sha256File(to); if (h !== sha256File(from)) die(`copy of ${rel} does not match its source; backup is incomplete`);
    sums.push(`${h} *${rel}`);
  }
  fs.writeFileSync(path.join(dest, SUMS), `${sums.join('\n')}\n`, { flag: 'wx' });
  const meta = { schema: 'scene-relevance-v2-evidence', recordedAt: new Date().toISOString(), manifestSha256: frozen.manifestSha256, candidatesSha256: frozen.manifest.candidateIntegrity.candidatesSha256, imageCount: frozen.manifest.candidateIntegrity.imageCount, fileCount: files.length, note: 'This file sits beside the backup and proves nothing about deliberate tampering. Record manifestSha256 independently (FREEZE-EVIDENCE.md).' };
  fs.writeFileSync(path.join(dest, META), stableStringify(meta), { flag: 'wx' });
  console.log(`Backed up ${files.length} files (${meta.imageCount} candidate images) to ${dest}\nManifest SHA-256 (record this NOW somewhere the evaluation folder and this backup cannot reach):\n  ${frozen.manifestSha256}`);
}

function verify() {
  const b = val('--backup'); if (!b) die('--backup <dir> is required');
  const backup = path.resolve(b); const problems = [];
  if (!fs.existsSync(backup) || !fs.lstatSync(backup).isDirectory()) die('backup folder not found');
  let sums; try { sums = parseSums(fs.readFileSync(path.join(backup, SUMS), 'utf8')); } catch (e) { if (e.code) die(`${SUMS} cannot be read (${e.code})`); throw e; }
  let meta; try { meta = readJsonStrict(path.join(backup, META)); } catch (e) { die(e.message); }
  const backupFiles = evidenceFiles(backup);
  for (const rel of backupFiles) if (!sums.has(rel)) problems.push(`backup has a file not in the sums: ${rel}`);
  for (const [rel, h] of sums) {
    const p = path.join(backup, ...rel.split('/'));
    if (!fs.existsSync(p)) problems.push(`backup file missing: ${rel}`);
    else if (sha256File(p) !== h) problems.push(`backup file corrupted (differs from its recorded sum): ${rel}`);
    const live = path.join(EVAL_DIR, ...rel.split('/'));
    if (!fs.existsSync(live)) problems.push(`evaluation folder is missing: ${rel}`);
    else if (sha256File(live) !== h) problems.push(`evaluation folder differs from the backup: ${rel}`);
  }
  const liveImages = fs.existsSync(path.join(EVAL_DIR, 'images')) ? evidenceFiles(EVAL_DIR).filter((r) => r.startsWith('images/')) : [];
  for (const rel of liveImages) if (!sums.has(rel)) problems.push(`evaluation folder has an image that is not in the backup: ${rel}`);
  const mh = sums.get(MANIFEST_FILE);
  if (!mh) problems.push(`backup has no ${MANIFEST_FILE}`);
  else if (meta.manifestSha256 !== mh) problems.push(`${META} disagrees with the backed-up manifest`);
  const expect = val('--expect-manifest-sha256');
  if (expect !== null) { if (!HEX.test(expect)) die('--expect-manifest-sha256 must be 64 lowercase hex characters'); if (mh !== expect) problems.push(`backed-up manifest SHA-256 ${mh} differs from the independently recorded ${expect}`); const lm = path.join(EVAL_DIR, MANIFEST_FILE); if (!fs.existsSync(lm) || sha256File(lm) !== expect) problems.push('live manifest differs from the independently recorded SHA-256'); }
  else console.log('NOTE: no --expect-manifest-sha256 given; this run cannot detect a manifest and backup edited together.');
  if (problems.length) { for (const p of problems) console.error(`  - ${p}`); die(`${problems.length} problem(s); do NOT run inference`); }
  console.log(`OK: ${sums.size} files match between the backup and the evaluation folder${expect ? '; manifest matches the independently recorded SHA-256' : ''}.`);
}

if (cmd === 'record') record(); else if (cmd === 'verify') verify(); else { console.error('usage: record --out <dir> | verify --backup <dir> [--expect-manifest-sha256 <hex>]'); process.exit(1); }
