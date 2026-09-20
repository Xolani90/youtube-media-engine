import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { runMediaProduction } from '../../src/media/pipeline.js';
import { scriptBodyToNarrationText } from '../../src/media/scriptText.js';

// Drives the REAL runMediaProduction() (real ffmpeg render, real
// ffprobe validation, real caption segmentation) without SQLite and
// without espeak-ng:
//   - storage is a small in-memory fake exposing the same synchronous
//     get/all/run/transaction surface the pipeline uses, so this test
//     runs even where better-sqlite3's native binary cannot load;
//   - `espeak-ng` on PATH is a recording stand-in that captures the exact
//     text argument the pipeline hands to the narrator and emits a valid
//     WAV via ffmpeg. This verifies the narration INPUT contract; it does
//     not verify espeak-ng's own speech synthesis.

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
const skipReason =
  process.platform === 'win32' ? 'requires a POSIX shell for the espeak-ng stand-in'
  : !hasFfmpeg ? 'requires ffmpeg/ffprobe on PATH'
  : false;

const nowISO = () => new Date().toISOString();

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `script-contract-${label}-`));
}

function installEspeakStandIn() {
  const binDir = tmpDir('bin');
  const capture = path.join(binDir, 'captured-narration-text.txt');
  const shim = path.join(binDir, 'espeak-ng');
  // argv: -w <output.wav> <text>
  fs.writeFileSync(shim, [
    '#!/bin/sh',
    'printf "%s" "$3" > "$ESPEAK_CAPTURE"',
    'ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=3" -f wav -y "$2"',
    ''
  ].join('\n'));
  fs.chmodSync(shim, 0o755);
  const previous = { PATH: process.env.PATH, ESPEAK_CAPTURE: process.env.ESPEAK_CAPTURE };
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;
  process.env.ESPEAK_CAPTURE = capture;
  return {
    capture,
    captured: () => (fs.existsSync(capture) ? fs.readFileSync(capture, 'utf8') : null),
    restore() {
      process.env.PATH = previous.PATH;
      if (previous.ESPEAK_CAPTURE === undefined) delete process.env.ESPEAK_CAPTURE;
      else process.env.ESPEAK_CAPTURE = previous.ESPEAK_CAPTURE;
    }
  };
}

function makeFixtureImage(dir) {
  const location = path.join(dir, 'a.png');
  execFileSync('ffmpeg', ['-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=1', '-frames:v', '1', '-y', location], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return location;
}

function makeFakeStorage({ body, imagePath }) {
  const contentVersion = { id: 'cv-1', content_brief_id: 'brief-1', script_id: 'script-1', state: 'PRODUCED' };
  const script = { id: 'script-1', content_brief_id: 'brief-1', version: 1, body };
  const brief = { id: 'brief-1', working_title: 'Octopus hearts' };
  const production = { id: 'prod-1', content_version_id: 'cv-1', script_id: 'script-1' };
  const asset = { id: 'asset-1', asset_type: 'image', location: imagePath, checksum: null, verification_status: 'VERIFIED' };
  const decisions = [];
  let mediaArtifact = null;
  // A4 (bounded-retry governance): Media Production consults and, on its named
  // failure outcomes, writes stage_retry_state. Modelled minimally here so the
  // fake keeps whitelisting every query the stage issues.
  let retryState = null;

  const storage = {
    decisions,
    get mediaArtifact() { return mediaArtifact; },
    get retryState() { return retryState; },
    get(sql, params = []) {
      if (/FROM stage_retry_state WHERE subject_id/.test(sql)) return retryState && retryState.subject_id === params[0] && retryState.stage === params[1] ? retryState : undefined;
      if (/FROM content_versions WHERE content_brief_id/.test(sql)) return contentVersion;
      if (/FROM scripts WHERE id/.test(sql)) return script;
      if (/FROM content_briefs WHERE id/.test(sql)) return brief;
      if (/FROM productions WHERE (content_version_id|id)/.test(sql)) return production;
      if (/FROM media_artifacts WHERE content_version_id/.test(sql)) return mediaArtifact ?? undefined;
      if (/FROM media_artifacts WHERE id/.test(sql)) return mediaArtifact ?? undefined;
      throw new Error(`fake storage: unexpected get(): ${sql}`);
    },
    all(sql) {
      if (/FROM assets\s+JOIN asset_usages/.test(sql)) return [asset];
      if (/FROM asset_usages WHERE content_version_id/.test(sql)) return [{ asset_id: asset.id, usage_context: 'b-roll' }];
      throw new Error(`fake storage: unexpected all(): ${sql}`);
    },
    run(sql, params = []) {
      if (/INSERT INTO stage_retry_state/.test(sql)) {
        const [id, subject_id, stage, last_failure_reason] = params;
        retryState = { id, subject_id, stage, cycle_number: 1, attempt_count: 1, quarantined_at: null, last_failure_reason };
        return;
      }
      if (/INSERT INTO decision_log/.test(sql)) {
        decisions.push({ decision: params[4], reason: params[5], subjectType: params[2], subjectId: params[3] });
        return;
      }
      if (/INSERT INTO media_artifacts/.test(sql)) {
        const [id, production_id, content_version_id, render_spec_json, render_spec_checksum, narration_path,
          narration_duration_seconds, artifact_path, artifact_checksum, duration_seconds] = params;
        mediaArtifact = { id, production_id, content_version_id, render_spec_json, render_spec_checksum,
          narration_path, narration_duration_seconds, artifact_path, artifact_checksum, duration_seconds };
        return;
      }
      throw new Error(`fake storage: unexpected run(): ${sql}`);
    },
    transaction(fn) { return fn(); }
  };
  return storage;
}

// A persisted script body exactly as src/script/pipeline.js builds it.
const structuredBody = JSON.stringify({
  hook: 'Did you know octopuses have three hearts?',
  narrative: 'A short story about cephalopods',
  sections: [
    { heading: 'The hearts', content: 'Two pump blood to the gills, one to the body.', claim_ids: ['c1'] },
    { heading: 'Why it matters', content: 'Cold water carries less oxygen.', claim_ids: ['c2'] }
  ],
  counterpoints: 'Some sources dispute the exact figures.',
  conclusion: 'Nature is strange.',
  call_to_action: null
});

const JSON_SYNTAX = /[{}[\]]|":|\\"|claim_ids|"hook"/;

test('Tests 4+5: structured script -> narration receives prose, captions are prose, real render still succeeds', { skip: skipReason }, () => {
  const espeak = installEspeakStandIn();
  try {
    const imagePath = makeFixtureImage(tmpDir('assets'));
    const storage = makeFakeStorage({ body: structuredBody, imagePath });
    const artifactsDir = tmpDir('media');

    const result = runMediaProduction({ storage, contentBriefId: 'brief-1', artifactsDir });

    // Test 5: the existing media pipeline contract still holds (real ffmpeg render + ffprobe validation).
    assert.equal(result.outcome, 'RENDERED', `unexpected outcome ${result.outcome} (${result.reason ?? ''})`);
    assert.ok(fs.existsSync(result.mediaArtifact.artifact_path));
    assert.ok(fs.statSync(result.mediaArtifact.artifact_path).size > 0);
    assert.ok(storage.decisions.some((d) => d.decision === 'RENDERED'));

    // Test 4: the narrator received the converted prose, never the serialized body.
    const narrated = espeak.captured();
    assert.equal(narrated, scriptBodyToNarrationText(structuredBody));
    assert.notEqual(narrated, structuredBody);
    assert.ok(!JSON_SYNTAX.test(narrated), `narration input contains JSON syntax: ${narrated}`);

    // Captions in the persisted render spec are prose derived from the SAME text.
    const spec = JSON.parse(result.mediaArtifact.render_spec_json);
    assert.ok(spec.captions.length > 0);
    const captionText = spec.captions.map((c) => c.text ?? c.caption ?? '').join(' ');
    assert.ok(!JSON_SYNTAX.test(captionText), `captions contain JSON syntax: ${captionText}`);
    assert.ok(captionText.includes('Did you know octopuses have three hearts?'));
    assert.ok(captionText.includes('Nature is strange.'));
    assert.equal(spec.captions.map((c) => c.text ?? c.caption).join(' ').replace(/\s+/g, ' '),
      narrated.replace(/\s+/g, ' ').trim());
  } finally {
    espeak.restore();
  }
});

test('plain-prose (seeded/legacy) script bodies still reach narration unchanged and render', { skip: skipReason }, () => {
  const espeak = installEspeakStandIn();
  try {
    const prose = 'This is a short narration script for the test video.';
    const storage = makeFakeStorage({ body: prose, imagePath: makeFixtureImage(tmpDir('assets')) });
    const result = runMediaProduction({ storage, contentBriefId: 'brief-1', artifactsDir: tmpDir('media') });
    assert.equal(result.outcome, 'RENDERED');
    assert.equal(espeak.captured(), prose);
  } finally {
    espeak.restore();
  }
});

test('a malformed stored script fails explicitly: nothing is narrated, captioned or rendered', { skip: skipReason }, () => {
  const espeak = installEspeakStandIn();
  try {
    const storage = makeFakeStorage({ body: '{"hook":"truncated', imagePath: makeFixtureImage(tmpDir('assets')) });
    const artifactsDir = tmpDir('media');
    const result = runMediaProduction({ storage, contentBriefId: 'brief-1', artifactsDir });

    assert.equal(result.outcome, 'NARRATION_FAILED');
    assert.equal(result.reason, 'SCRIPT_BODY_MALFORMED_JSON');
    assert.equal(result.mediaArtifact, null);
    assert.equal(espeak.captured(), null, 'the narrator must never be invoked with a malformed script body');
    assert.deepEqual(fs.readdirSync(artifactsDir), [], 'no artifact directory or file may be created');
    assert.equal(storage.mediaArtifact, null);
    assert.ok(storage.decisions.some(
      (d) => d.decision === 'NARRATION_FAILED' && d.reason === 'script_body_contract_violation_SCRIPT_BODY_MALFORMED_JSON'
    ));
    // A4: a malformed stored body is deterministic (same body every run), so this named
    // NARRATION_FAILED outcome consumes NO retry budget and writes no retry state.
    assert.equal(result.attempt, undefined);
    assert.deepEqual(result.retryDisposition, {
      eligible: false, nature: 'DETERMINISTIC', basis: 'script_body_contract_violation_SCRIPT_BODY_MALFORMED_JSON'
    });
    assert.equal(storage.retryState, null);
  } finally {
    espeak.restore();
  }
});