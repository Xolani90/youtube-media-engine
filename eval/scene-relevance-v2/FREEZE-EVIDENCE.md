# Freeze lifecycle and evidence procedure (v2)

Not a frozen file: it is not hashed by the freeze. It documents tooling behaviour; the preregistration (section 13) refers to it.

## Lifecycle and what the tooling enforces

1. **Collect** (network, Pixabay key): `scripts/eval-scene-relevance-v2-fetch.js`.
2. **Review** (offline): contact sheet creates `answer-key.json`; the reviewer exports `blind-judgments-<id>.json`.
3. **Freeze** (offline): `scripts/eval-scene-relevance-v2-freeze.js` writes `judgments-manifest.json`, once.
4. **Run** (local model folder): `scripts/eval-scene-relevance-v2-run.js` writes `results.json`, once.
5. **Report**: `report.js --select-rule`, then `report.js`.

**Fetch guard.** The fetch script refuses every mode (also `--dry-run` and `--show-insufficient`) before it reads anything,
touches the network or writes a file, if the folder shows any of: `judgments-manifest.json` (frozen); freeze-era files without a
manifest (`judgments-*.json`, `results.json`, `frozen-rule.json`, `metrics.json`, `REPORT.md`: inconsistent); a manifest-like
name that is not exactly the manifest, or a folder that cannot be listed (ambiguous); `answer-key.json`, `blind-judgments-*.json`,
`contact-sheet.html` or `review-assets/` (review started: candidates are already bound to a key). Names are matched
case-insensitively. The guard is re-checked before every write, so a freeze created mid-run stops the run. The archive step for an
owner-approved insufficient-scene retry carries the same guard. No script ever removes or replaces a freeze.

**A new evaluation** (different queries, scenes, candidates or model) is a separate lifecycle: a new evaluation folder
(`EVAL_DIR=...`), its own preregistration and its own freeze. To abandon a freeze, leave the old folder intact and start the new one
beside it; do not delete `judgments-manifest.json` to make fetching work.

## Model pin

`run.js` hashes the actual bytes of `onnx/text_model_quantized.onnx` and `onnx/vision_model_quantized.onnx` and compares them with
`PINNED_MODEL` in the lib (revision `4649052661e53c7000355844105f8a1792088239`, hashes from `THIRD_PARTY_NOTICES.md`) before any
inference, again before every worker call, and again after the run. A missing, unreadable, symlinked or different file refuses (or
aborts) the run without writing `results.json`. `results.json` carries the verified identity and the report rejects a missing,
different, override-pinned or only-before/only-after-verified identity. The revision itself is enforced only through the file hashes
(the model folder carries no revision metadata). `config.json`, `preprocessor_config.json` and `tokenizer.json` have no recorded
hashes in the repository, so they are observed (recorded as `unpinnedFilesObserved`) but NOT enforced. This pins the tested
files; it is not a licence determination.

## Making the freeze recoverable

Do this once, immediately after `freeze.js` succeeds and before `run.js`.

1. **Record the manifest hash independently.** `freeze.js` binds `candidates.json`, every image hash, the preregistration, scenes,
   negatives, the answer key and the judgments, so the SHA-256 of `judgments-manifest.json` anchors the whole freeze. Write it
   somewhere the person who can edit this folder cannot also edit: a pushed git commit message or signed tag in a repository whose
   history others hold, an e-mail to a second person, or a printed note. Do not rely on a file next to the manifest.
2. **Back up outside the folder:**
   `node scripts/eval-scene-relevance-v2-evidence.js record --out <path outside eval/scene-relevance-v2>`
   It re-verifies the freeze, copies the manifest, frozen files, judgments, blind exports, fetch decisions and `images/` (which are
   git-ignored, so git does not hold them), and writes `EVIDENCE-SHA256SUMS.txt` (`sha256sum -c` format) and `EVIDENCE.json`.
   Keep a second copy on separate media.
3. **Verify before inference, and again after any restore or move:**
   `node scripts/eval-scene-relevance-v2-evidence.js verify --backup <path> --expect-manifest-sha256 <the independently recorded hash>`
   Exit 0 only if the backup matches its own sums, the evaluation folder matches the backup (no changed, missing or extra image)
   and the manifest matches the independently recorded hash. Without `--expect-manifest-sha256` it still catches accidental
   damage but says so.

## What this does and does not protect

* Accidental corruption of the manifest, an image or the backup is detected (hash mismatch).
* **A sidecar hash file, `EVIDENCE.json` and a backup that one person can edit together do not prevent deliberate tampering**: an
  editor can change the manifest, the backup copy and the sums consistently, and `verify` without an independent hash will pass
  (a test demonstrates this). Only a manifest SHA-256 held where that person cannot rewrite it (step 1) defeats it, and only
  while that record itself is trustworthy.
* The owner must preserve independently: the manifest SHA-256; a second copy of `images/` and `candidates.json` on separate
  media; the commit hash of the code that ran; and the model files' pinned hashes (already in `THIRD_PARTY_NOTICES.md`).
* `run.js` does not itself require that `verify` was run; running it is a manual step in this procedure.
