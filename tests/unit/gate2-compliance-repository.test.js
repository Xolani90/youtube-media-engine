import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../../src/config/index.js';
import { Gate2ComplianceRepository } from '../../src/compliance/repository.js';
import { verifyGate2Pass } from '../../src/compliance/verify.js';
import { loadGate2Policy, Gate2PolicyLoadError, POLICY_LOAD_FAILURE_CODE } from '../../src/compliance/policy.js';
import { evaluateGate2, resolveGate2Context } from '../../src/compliance/evaluator.js';
import { runFinalCompliance } from '../../src/compliance/pipeline.js';
import { NON_AUTHORIZING, OUTCOME, RESULT, RULE, REQUIRED_RULE_IDS } from '../../src/compliance/constants.js';
import { runPublication } from '../../src/publication/pipeline.js';
import { OUTCOME as PUBLICATION_OUTCOME } from '../../src/publication/constants.js';
import { prepareGate2Evidence, runGate2 } from '../helpers/gate2.js';
import {
  withGate2Fixture, recordVerification, sha256Hex, tableCounts, uuid, MEDIA_BYTES
} from '../helpers/gate2-rule-fixture.js';

/**
 * ADR-0032 Gate 2 Batch 4: compliance-record persistence and exact PASS
 * binding (sections 9, 10, 11, 13 and 15).
 *
 * Everything here runs against a REAL migrated SQLite database, the REAL
 * repository, the REAL evaluator / verifier / final-compliance stage, a REAL
 * media file and a REAL on-disk policy pack. Nothing is mocked. The only
 * indirection is that config.gate2PolicyPath points at a temporary COPY of
 * the repository's config/gate2_policy.json (restored afterwards), so a test
 * can edit "the policy file" without touching the repository's own file.
 *
 * Reuses the Batch 3 fixture (tests/helpers/gate2-rule-fixture.js) and the
 * existing stage helper (tests/helpers/gate2.js). No production file is
 * changed by this batch.
 */

// ------------------------------------------------------------------ policy file plumbing

const ORIGINAL_POLICY_PATH = config.gate2PolicyPath;
const REAL_POLICY_TEXT = fs.readFileSync(ORIGINAL_POLICY_PATH, 'utf8');
const V1 = JSON.parse(REAL_POLICY_TEXT).version;
const V2 = '2.0.0';
let policyDir;
let policyFile;

const writePolicy = (overrides = {}) => fs.writeFileSync(policyFile, JSON.stringify({ ...JSON.parse(REAL_POLICY_TEXT), ...overrides }, null, 2));
const writeRawPolicy = (text) => fs.writeFileSync(policyFile, text);

// ------------------------------------------------------------------ fixture helpers

const CHANGED_BYTES = Buffer.from('gate2-changed-final-media-bytes-v2');
const C1 = sha256Hex(MEDIA_BYTES);
const C2 = sha256Hex(CHANGED_BYTES);

const repoOf = (fx) => new Gate2ComplianceRepository(fx.storage);
const rows = (fx, contentVersionId = fx.contentVersionId) => repoOf(fx).getAll(contentVersionId);
const verify = (fx, contentVersionId = fx.contentVersionId) => verifyGate2Pass(fx.storage, contentVersionId);
const stateOf = (fx, contentVersionId = fx.contentVersionId) =>
  fx.storage.get('SELECT state FROM content_versions WHERE id = ?', [contentVersionId]).state;

/**
 * Real Gate 2 PASS for the fixture through the real final-compliance stage
 * (PRODUCED -> FINAL_COMPLIANCE). Also guards every negative test below: the
 * baseline PASS must be authorizing before anything is changed.
 */
async function withPassedFixture(fn, options) {
  await withGate2Fixture(async (fx) => {
    const stage = runGate2(fx.storage, fx.contentVersionId);
    assert.equal(stage.outcome, OUTCOME.PASS, 'fixture must reach a real Gate 2 PASS');
    assert.equal(stage.resultingState, 'FINAL_COMPLIANCE');
    const pass = repoOf(fx).getNewest(fx.contentVersionId);
    assert.equal(pass.decision, RESULT.PASS);
    const baseline = verify(fx);
    assert.equal(baseline.authorizing, true, 'baseline PASS must be authorizing before any change');
    return fn(fx, pass);
  }, options);
}

/**
 * Appends one more record through the REAL repository, with the binding and
 * evidence taken from the REAL evaluator's current view. For a non-PASS
 * decision, one rule result is set to that decision so the row is internally
 * honest. (The real stage would also move state on REVIEW/BLOCK; appending
 * directly keeps the state FINAL_COMPLIANCE so the newest-record rule itself
 * is what the verifier is exercised on.)
 */
function appendRecord(fx, decision, { contentVersionId = fx.contentVersionId, binding, ruleIds, createdAt } = {}) {
  const policy = loadGate2Policy();
  const ev = evaluateGate2(fx.storage, contentVersionId);
  const ruleResults = decision === RESULT.PASS
    ? ev.ruleResults
    : ev.ruleResults.map((r) => (r.rule_id === RULE.ASSET_RIGHTS ? { ...r, result: decision, reason: `test_${decision}` } : r));
  return repoOf(fx).append({
    contentVersionId,
    decision,
    policyVersion: policy.version,
    ruleIds: ruleIds ?? policy.ruleIds,
    ruleResults,
    binding: binding ?? ev.binding,
    evidence: ev.evidence,
    createdAt
  });
}

function assertNonAuthorizing(result, reason, detail) {
  assert.equal(result.authorizing, false, `expected non-authorizing (${reason}), got authorizing`);
  assert.equal(result.reason, reason);
  if (detail !== undefined) assert.equal(result.detail, detail);
}

/** A stale PASS is merely non-authorizing: no state change, no new record, old row untouched. */
function assertOnlyNonAuthorizing(fx, before) {
  assert.equal(stateOf(fx), 'FINAL_COMPLIANCE', 'a stale PASS must not change the item state');
  assert.deepEqual(rows(fx), before, 'the persisted history must be unchanged');
}

const repointContentScript = (fx, scriptId) =>
  fx.storage.run('UPDATE content_versions SET script_id = ? WHERE id = ?', [scriptId, fx.contentVersionId]);
const setMediaChecksum = (fx, checksum) =>
  fx.storage.run('UPDATE media_artifacts SET artifact_checksum = ? WHERE id = ?', [checksum, fx.mediaArtifactId]);

/** The real publication boundary, with a provider stand-in that fails loudly if reached. SIMULATION denies authorization unconditionally. */
async function publicationAttempt(fx) {
  const providerCalls = [];
  const adapter = {
    publish: async (...args) => {
      providerCalls.push(args);
      throw new Error('provider must never be reached by a Batch 4 test');
    }
  };
  const result = await runPublication({ storage: fx.storage, contentBriefId: fx.contentBriefId, adapter, mode: 'SIMULATION' });
  const publications = fx.storage.get('SELECT COUNT(*) AS c FROM publications').c;
  return { result, providerCalls, publications };
}

// ------------------------------------------------------------------ suite

describe('ADR-0032 Gate 2 compliance persistence and exact PASS binding (Batch 4)', () => {
  before(() => {
    policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-batch4-policy-'));
    policyFile = path.join(policyDir, 'gate2_policy.json');
    config.gate2PolicyPath = policyFile;
  });
  beforeEach(() => writeRawPolicy(REAL_POLICY_TEXT));
  after(() => {
    config.gate2PolicyPath = ORIGINAL_POLICY_PATH;
    fs.rmSync(policyDir, { recursive: true, force: true });
  });

  test('the temporary policy copy is the real v1 pack and the loader reads it fresh (guards every policy test)', () => {
    assert.equal(config.gate2PolicyPath, policyFile);
    assert.deepEqual(loadGate2Policy(), { version: V1, ruleIds: REQUIRED_RULE_IDS.slice().sort() });
    writePolicy({ version: V2 });
    assert.equal(loadGate2Policy().version, V2);
  });

  // ---------------------------------------------------------------- 1. PASS persistence

  describe('1. PASS persistence', () => {
    test('a real Gate 2 PASS persists every ADR-0032 s9 binding, the policy binding and the evidence references', async () => {
      await withGate2Fixture((fx) => {
        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.PASS);

        const stored = rows(fx);
        assert.equal(stored.length, 1);
        const [rec] = stored;
        assert.deepEqual(stage.record, rec, 'the stage result is the persisted row');

        // identity / decision / provenance fields required by the migration
        assert.ok(Number.isInteger(rec.seq) && rec.seq >= 1);
        assert.match(rec.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        assert.equal(rec.created_at, new Date(rec.created_at).toISOString());
        assert.equal(rec.decision, 'PASS');
        assert.equal(rec.content_version_id, fx.contentVersionId);

        // content / script / production / media / metadata bindings (independent expectations)
        assert.equal(rec.bound_content_script_id, fx.scriptId);
        assert.equal(rec.bound_script_id, fx.scriptId);
        assert.equal(rec.bound_script_version, 1);
        assert.equal(rec.bound_production_script_id, fx.scriptId);
        assert.equal(rec.bound_media_artifact_id, fx.mediaArtifactId);
        assert.equal(rec.bound_artifact_checksum, sha256Hex(fs.readFileSync(fx.mediaPath)));
        assert.equal(rec.bound_working_title, 'A Real Final Title');
        assert.equal(rec.bound_viewer_promise, 'You will understand the topic');
        assert.equal(
          rec.bound_metadata_json,
          JSON.stringify({ working_title: 'A Real Final Title', viewer_promise: 'You will understand the topic' })
        );

        // policy binding: pack version + the exact evaluated rule-ID set
        assert.equal(rec.policy_version, V1);
        assert.deepEqual(JSON.parse(rec.rule_ids_json), ['GC-001', 'GC-002', 'GC-003', 'GC-004', 'GC-005']);

        // per-rule results, by reference to the five rules
        const results = JSON.parse(rec.rule_results_json);
        assert.deepEqual(results.map((r) => [r.rule_id, r.result]), [
          ['GC-001', 'PASS'], ['GC-002', 'PASS'], ['GC-003', 'PASS'], ['GC-004', 'PASS'], ['GC-005', 'PASS']
        ]);

        // evidence: references only
        assert.deepEqual(JSON.parse(rec.evidence_json), {
          asset_verifications: [],
          decision_log: {
            script_generation_id: fx.scriptGenerationId,
            brief_generation_id: fx.briefGenerationId,
            claim_extractions: []
          },
          media: { media_artifact_id: fx.mediaArtifactId, artifact_checksum: C1 }
        });
      });
    });

    test('the table refuses a PASS missing any required binding; REVIEW/BLOCK rows may carry partial bindings', async () => {
      await withGate2Fixture((fx) => {
        const policy = loadGate2Policy();
        const ev = evaluateGate2(fx.storage, fx.contentVersionId);
        const args = (decision, binding) => ({
          contentVersionId: fx.contentVersionId, decision, policyVersion: policy.version, ruleIds: policy.ruleIds,
          ruleResults: ev.ruleResults, binding, evidence: ev.evidence
        });
        const bindingKeys = [
          'contentScriptId', 'scriptId', 'scriptVersion', 'productionScriptId', 'mediaArtifactId',
          'artifactChecksum', 'workingTitle', 'viewerPromise', 'metadataJson'
        ];
        for (const key of bindingKeys) {
          assert.notEqual(ev.binding[key], null, `fixture must resolve ${key}`);
          assert.throws(
            () => repoOf(fx).append(args('PASS', { ...ev.binding, [key]: null })),
            (err) => err.code === 'SQLITE_CONSTRAINT_CHECK',
            `a PASS without ${key} must be rejected`
          );
        }
        assert.equal(rows(fx).length, 0, 'no rejected PASS may leave a row behind');

        // Non-PASS decisions record whichever bindings could be resolved (even none).
        const review = repoOf(fx).append(args('REVIEW', {}));
        const block = repoOf(fx).append(args('BLOCK', {}));
        assert.equal(review.bound_media_artifact_id, null);
        assert.equal(block.bound_artifact_checksum, null);
        assert.equal(rows(fx).length, 2);

        // And a complete PASS is accepted.
        const pass = repoOf(fx).append(args('PASS', ev.binding));
        assert.equal(pass.decision, 'PASS');
      });
    });
  });

  // ---------------------------------------------------------------- 2. append-only enforcement

  describe('2. append-only enforcement (real SQLite triggers)', () => {
    test('the migration installed both append-only triggers on the table', async () => {
      await withGate2Fixture((fx) => {
        const triggers = fx.storage
          .all(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'gate2_compliance_records' ORDER BY name`)
          .map((t) => t.name);
        assert.deepEqual(triggers, ['gate2_compliance_records_no_delete', 'gate2_compliance_records_no_update']);
      });
    });

    test('UPDATE of a compliance record is rejected, for PASS, REVIEW and BLOCK rows, and the rows are unchanged', async () => {
      await withPassedFixture((fx) => {
        appendRecord(fx, RESULT.REVIEW);
        appendRecord(fx, RESULT.BLOCK);
        const before = rows(fx);
        assert.equal(before.length, 3);
        for (const row of before) {
          for (const sql of [
            `UPDATE gate2_compliance_records SET decision = 'BLOCK' WHERE id = ?`,
            `UPDATE gate2_compliance_records SET decision = 'PASS' WHERE id = ?`,
            `UPDATE gate2_compliance_records SET bound_artifact_checksum = 'tampered' WHERE id = ?`,
            `UPDATE gate2_compliance_records SET policy_version = '9.9.9' WHERE id = ?`,
            `UPDATE gate2_compliance_records SET rule_ids_json = '[]' WHERE id = ?`
          ]) {
            assert.throws(() => fx.storage.run(sql, [row.id]), /gate2_compliance_records is append-only: UPDATE is not permitted/);
          }
        }
        assert.throws(
          () => fx.storage.run(`UPDATE gate2_compliance_records SET decision = 'BLOCK'`),
          /append-only: UPDATE is not permitted/,
          'an unfiltered UPDATE is rejected too'
        );
        assert.deepEqual(rows(fx), before);
      });
    });

    test('DELETE of a compliance record is rejected, for PASS, REVIEW and BLOCK rows, and the rows remain', async () => {
      await withPassedFixture((fx) => {
        appendRecord(fx, RESULT.REVIEW);
        appendRecord(fx, RESULT.BLOCK);
        const before = rows(fx);
        for (const row of before) {
          assert.throws(
            () => fx.storage.run('DELETE FROM gate2_compliance_records WHERE id = ?', [row.id]),
            /gate2_compliance_records is append-only: DELETE is not permitted/
          );
        }
        assert.throws(() => fx.storage.run('DELETE FROM gate2_compliance_records'), /append-only: DELETE is not permitted/);
        assert.deepEqual(rows(fx), before);
        assert.equal(verify(fx).reason, NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, 'the newest (BLOCK) record still controls');
      });
    });

    test('the repository exposes no update or delete API: records can only be appended and read', () => {
      const methods = Object.getOwnPropertyNames(Gate2ComplianceRepository.prototype).filter((m) => m !== 'constructor');
      assert.deepEqual(methods.sort(), ['append', 'getAll', 'getNewest']);
    });
  });

  // ---------------------------------------------------------------- 3. current-record selection

  describe('3. current-record selection (newest by seq)', () => {
    test('older PASS, newer REVIEW: the current record is the REVIEW and the PASS does not authorize', async () => {
      await withPassedFixture((fx, pass) => {
        const review = appendRecord(fx, RESULT.REVIEW);
        assert.ok(review.seq > pass.seq);
        const current = repoOf(fx).getNewest(fx.contentVersionId);
        assert.equal(current.id, review.id);
        assert.equal(current.decision, RESULT.REVIEW);
        const result = verify(fx);
        assertNonAuthorizing(result, NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, 'newest_REVIEW');
        assert.equal(result.record.id, review.id);
      });
    });

    test('older PASS, newer BLOCK: the current record is the BLOCK and the PASS does not authorize', async () => {
      await withPassedFixture((fx, pass) => {
        const block = appendRecord(fx, RESULT.BLOCK);
        assert.ok(block.seq > pass.seq);
        const current = repoOf(fx).getNewest(fx.contentVersionId);
        assert.equal(current.id, block.id);
        assert.equal(current.decision, RESULT.BLOCK);
        const result = verify(fx);
        assertNonAuthorizing(result, NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, 'newest_BLOCK');
        assert.equal(result.record.id, block.id);
      });
    });

    test('older REVIEW, newer PASS: the current record is the newer PASS and, with a valid binding, it authorizes', async () => {
      await withGate2Fixture((fx) => {
        const review = appendRecord(fx, RESULT.REVIEW); // item is still PRODUCED
        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.PASS);
        const all = rows(fx);
        assert.deepEqual(all.map((r) => r.decision), ['REVIEW', 'PASS']);
        const current = repoOf(fx).getNewest(fx.contentVersionId);
        assert.equal(current.id, all[1].id);
        assert.ok(current.seq > review.seq);
        const result = verify(fx);
        assert.equal(result.authorizing, true);
        assert.equal(result.record.id, current.id);
      });
    });

    test('a newer PASS with an invalid binding is the current record and does NOT fall back to an older valid PASS', async () => {
      await withPassedFixture((fx, olderValid) => {
        const ev = evaluateGate2(fx.storage, fx.contentVersionId);
        const newerInvalid = appendRecord(fx, RESULT.PASS, { binding: { ...ev.binding, artifactChecksum: sha256Hex('not-the-media') } });
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).id, newerInvalid.id);
        const result = verify(fx);
        assertNonAuthorizing(result, NON_AUTHORIZING.BOUND_CHECKSUM_MISMATCH);
        assert.equal(result.record.id, newerInvalid.id);
        assert.notEqual(result.record.id, olderValid.id);
      });
    });

    test('recency follows insertion order (seq), never created_at: an older-inserted row with a later timestamp is not current', async () => {
      await withPassedFixture((fx, pass) => {
        // PASS (timestamp: now) then REVIEW stamped in 1999: the REVIEW is still newest.
        const review = appendRecord(fx, RESULT.REVIEW, { createdAt: '1999-01-01T00:00:00.000Z' });
        assert.ok(review.created_at < pass.created_at);
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).id, review.id);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, 'newest_REVIEW');
      });
      await withGate2Fixture((fx) => {
        // REVIEW stamped in 2099 first, then a real PASS (timestamp: now): the PASS is newest.
        const review = appendRecord(fx, RESULT.REVIEW, { createdAt: '2099-01-01T00:00:00.000Z' });
        runGate2(fx.storage, fx.contentVersionId);
        const current = repoOf(fx).getNewest(fx.contentVersionId);
        assert.equal(current.decision, RESULT.PASS);
        assert.ok(current.created_at < review.created_at);
        assert.equal(verify(fx).authorizing, true);
      });
    });

    test('recency is deterministic when timestamps collide: the last appended row is always the newest and seq is strictly increasing', async () => {
      await withGate2Fixture((fx) => {
        const sameInstant = '2030-06-01T12:00:00.000Z';
        const decisions = [RESULT.PASS, RESULT.REVIEW, RESULT.BLOCK];
        let previousSeq = 0;
        for (let i = 0; i < 25; i += 1) {
          const appended = appendRecord(fx, decisions[i % 3], { createdAt: sameInstant });
          assert.ok(appended.seq > previousSeq, 'seq must be strictly increasing');
          previousSeq = appended.seq;
          assert.equal(repoOf(fx).getNewest(fx.contentVersionId).id, appended.id);
        }
        const all = rows(fx);
        assert.deepEqual(all.map((r) => r.seq), [...all.map((r) => r.seq)].sort((a, b) => a - b));
        assert.equal(new Set(all.map((r) => r.created_at)).size, 1);
      });
    });
  });

  // ---------------------------------------------------------------- 4. exact content-version binding

  describe('4. exact content-version binding', () => {
    test("content version A's PASS does not authorize content version B, through the real persistence and verification path", async () => {
      await withPassedFixture(async (fx, passA) => {
        // B: a separate, fully valid content version in the SAME database, in FINAL_COMPLIANCE,
        // with its own real media file -- the ONLY thing it lacks is a compliance record of its own.
        const other = fx.addOtherContentVersion();
        fs.writeFileSync(path.join(fx.dir, 'other.mp4'), CHANGED_BYTES);
        // Reuse the fixture's existing research project (same opportunity_id
        // as A's brief) rather than letting prepareGate2Evidence insert a
        // second research_projects row for that opportunity_id, which the
        // table's UNIQUE constraint rejects.
        fx.storage.run('UPDATE content_briefs SET research_project_id = ? WHERE id = ?', [fx.researchProjectId, other.briefId]);
        prepareGate2Evidence(fx.storage, other.contentVersionId);
        fx.storage.run(`UPDATE content_versions SET state = 'FINAL_COMPLIANCE' WHERE id = ?`, [other.contentVersionId]);

        assert.equal(repoOf(fx).getNewest(other.contentVersionId), null, "A's record is not visible as B's current record");
        assertNonAuthorizing(verify(fx, other.contentVersionId), NON_AUTHORIZING.NO_COMPLIANCE_RECORD);
        assert.equal(verify(fx).authorizing, true, 'A itself is unaffected');

        // B must be evaluated in its own right; that appends B's OWN record and leaves A's untouched.
        const stageB = runGate2(fx.storage, other.contentVersionId);
        assert.equal(stageB.outcome, OUTCOME.PASS);
        const passB = repoOf(fx).getNewest(other.contentVersionId);
        assert.notEqual(passB.id, passA.id);
        assert.equal(passB.content_version_id, other.contentVersionId);
        assert.equal(passB.bound_media_artifact_id, other.mediaArtifactId);
        assert.equal(verify(fx, other.contentVersionId).authorizing, true);
        assert.deepEqual(rows(fx), [passA], "A's history is untouched");
      });
    });

    test("a record for B that carries A's binding values is persisted but does not authorize B (binding is by value, not by row)", async () => {
      await withPassedFixture((fx) => {
        const bindingOfA = evaluateGate2(fx.storage, fx.contentVersionId).binding;
        const other = fx.addOtherContentVersion();
        fs.writeFileSync(path.join(fx.dir, 'other.mp4'), CHANGED_BYTES);
        // See the sibling test above: reuse A's research project so
        // prepareGate2Evidence doesn't collide on opportunity_id's UNIQUE
        // constraint.
        fx.storage.run('UPDATE content_briefs SET research_project_id = ? WHERE id = ?', [fx.researchProjectId, other.briefId]);
        prepareGate2Evidence(fx.storage, other.contentVersionId);
        fx.storage.run(`UPDATE content_versions SET state = 'FINAL_COMPLIANCE' WHERE id = ?`, [other.contentVersionId]);

        const forgedForB = appendRecord(fx, RESULT.PASS, { contentVersionId: other.contentVersionId, binding: bindingOfA });
        assert.equal(forgedForB.content_version_id, other.contentVersionId);
        assert.equal(repoOf(fx).getNewest(other.contentVersionId).id, forgedForB.id);
        assertNonAuthorizing(verify(fx, other.contentVersionId), NON_AUTHORIZING.CONTENT_BINDING_MISMATCH);
        assert.equal(verify(fx).authorizing, true, 'A remains authorizing');
      });
    });
  });

  // ---------------------------------------------------------------- 5. script binding

  describe('5. script binding', () => {
    test('changing the applicable current script identity S1 -> S2 makes the persisted PASS stale / non-authorizing, without rebinding or new state', async () => {
      await withPassedFixture((fx, pass) => {
        const before = rows(fx);
        const s2 = fx.addScript(2);
        repointContentScript(fx, s2);

        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.CONTENT_BINDING_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);
        const persisted = repoOf(fx).getNewest(fx.contentVersionId);
        assert.equal(persisted.bound_content_script_id, fx.scriptId, 'no silent rebinding to S2');
        assert.equal(persisted.bound_script_id, fx.scriptId);
        assert.equal(persisted.id, pass.id);
      });
    });

    test("changing the production's script identity makes the PASS non-authorizing", async () => {
      await withPassedFixture((fx) => {
        const before = rows(fx);
        const s2 = fx.addScript(2);
        fx.storage.run('UPDATE productions SET script_id = ? WHERE id = ?', [s2, fx.productionId]);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.PRODUCTION_SCRIPT_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);
      });
    });

    test('a persisted PASS whose bound script id is not the current script row is non-authorizing', async () => {
      await withPassedFixture((fx) => {
        const s2 = fx.addScript(2);
        const ev = evaluateGate2(fx.storage, fx.contentVersionId);
        appendRecord(fx, RESULT.PASS, { binding: { ...ev.binding, scriptId: s2 } });
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.SCRIPT_BINDING_MISMATCH);
      });
    });
  });

  // ---------------------------------------------------------------- 6. script version binding

  describe('6. script version binding (scripts.version is part of the existing binding)', () => {
    test('same script identity + same version -> valid', async () => {
      await withPassedFixture((fx, pass) => {
        const script = fx.storage.get('SELECT id, version FROM scripts WHERE id = ?', [fx.scriptId]);
        assert.equal(pass.bound_script_id, script.id);
        assert.equal(pass.bound_script_version, script.version);
        assert.equal(verify(fx).authorizing, true);
      });
    });

    test('same script identity + changed version -> stale / non-authorizing, with the persisted version untouched', async () => {
      await withPassedFixture((fx) => {
        const before = rows(fx);
        fx.storage.run('UPDATE scripts SET version = 2 WHERE id = ?', [fx.scriptId]);
        assert.equal(fx.storage.get('SELECT id FROM content_versions WHERE id = ? AND script_id = ?', [fx.contentVersionId, fx.scriptId]).id, fx.contentVersionId, 'identity is unchanged');
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.SCRIPT_BINDING_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).bound_script_version, 1);
      });
    });
  });

  // ---------------------------------------------------------------- 7. media identity binding

  describe('7. media identity binding', () => {
    test('changing the applicable media artifact identity alone (same file, same checksum) makes the PASS non-authorizing', async () => {
      await withPassedFixture((fx, pass) => {
        const before = rows(fx);
        const newMediaId = uuid();
        fx.storage.run('UPDATE media_artifacts SET id = ? WHERE id = ?', [newMediaId, fx.mediaArtifactId]);
        const media = resolveGate2Context(fx.storage, fx.contentVersionId).media;
        assert.equal(media.id, newMediaId);
        assert.equal(media.artifact_checksum, C1, 'the checksum and file are unchanged: identity alone is enough');
        assert.equal(sha256Hex(fs.readFileSync(fx.mediaPath)), C1);

        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.MEDIA_ARTIFACT_IDENTITY_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).bound_media_artifact_id, pass.bound_media_artifact_id);
      });
    });
  });

  // ---------------------------------------------------------------- 8. media checksum binding

  describe('8. media checksum binding (ADR-0032 s15 five-step media check)', () => {
    test('control: with a fresh PASS the real publication boundary is satisfied and stops only at SIMULATION authorization', async () => {
      await withPassedFixture(async (fx) => {
        const { result, providerCalls, publications } = await publicationAttempt(fx);
        assert.equal(result.outcome, PUBLICATION_OUTCOME.AUTHORIZATION_DENIED);
        assert.notEqual(result.outcome, PUBLICATION_OUTCOME.GATE2_NOT_AUTHORIZING);
        assert.equal(providerCalls.length, 0);
        assert.equal(publications, 0);
      });
    });

    test('media row checksum changed C1 -> C2 while the file is unchanged: stale; the publication boundary refuses', async () => {
      await withPassedFixture(async (fx) => {
        const before = rows(fx);
        setMediaChecksum(fx, C2);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.MEDIA_CHECKSUM_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);

        const { result, providerCalls, publications } = await publicationAttempt(fx);
        assert.equal(result.outcome, PUBLICATION_OUTCOME.GATE2_NOT_AUTHORIZING);
        assert.equal(result.reason, NON_AUTHORIZING.MEDIA_CHECKSUM_MISMATCH);
        assert.equal(providerCalls.length, 0);
        assert.equal(publications, 0);
      });
    });

    test('file bytes changed after the PASS (file hashes to C2; media row and PASS still C1): stale; the publication boundary refuses', async () => {
      await withPassedFixture(async (fx) => {
        const before = rows(fx);
        fs.writeFileSync(fx.mediaPath, CHANGED_BYTES);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.MEDIA_CHECKSUM_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);

        const { result, providerCalls, publications } = await publicationAttempt(fx);
        assert.equal(result.outcome, PUBLICATION_OUTCOME.GATE2_NOT_AUTHORIZING);
        assert.equal(result.reason, NON_AUTHORIZING.MEDIA_CHECKSUM_MISMATCH);
        assert.equal(providerCalls.length, 0);
        assert.equal(publications, 0);
      });
    });

    test('file AND media row both moved to C2 (internally consistent) but the PASS is bound to C1: stale; the publication boundary refuses', async () => {
      await withPassedFixture(async (fx, pass) => {
        const before = rows(fx);
        fs.writeFileSync(fx.mediaPath, CHANGED_BYTES);
        setMediaChecksum(fx, C2);
        assert.equal(pass.bound_artifact_checksum, C1);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.BOUND_CHECKSUM_MISMATCH);
        assertOnlyNonAuthorizing(fx, before);

        const { result, providerCalls, publications } = await publicationAttempt(fx);
        assert.equal(result.outcome, PUBLICATION_OUTCOME.GATE2_NOT_AUTHORIZING);
        assert.equal(result.reason, NON_AUTHORIZING.BOUND_CHECKSUM_MISMATCH);
        assert.equal(providerCalls.length, 0);
        assert.equal(publications, 0);
      });
    });

    test('media file removed after the PASS: non-authorizing (MEDIA_FILE_MISSING)', async () => {
      await withPassedFixture((fx) => {
        const before = rows(fx);
        fs.rmSync(fx.mediaPath);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.MEDIA_FILE_MISSING);
        assertOnlyNonAuthorizing(fx, before);
      });
    });
  });

  // ---------------------------------------------------------------- 9. policy version binding

  describe('9. policy version binding', () => {
    test('a PASS under policy V1 is non-authorizing once the pack is V2; V1 is not silently treated as current; nothing is re-evaluated', async () => {
      await withPassedFixture((fx, pass) => {
        assert.equal(pass.policy_version, V1);
        const before = rows(fx);
        const countsBefore = tableCounts(fx.storage);

        writePolicy({ version: V2 });

        assert.equal(loadGate2Policy().version, V2, 'a fresh policy read observes V2');
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.POLICY_VERSION_MISMATCH, `bound_${V1}_current_${V2}`);
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).policy_version, V1, 'the persisted binding is still V1');
        assertOnlyNonAuthorizing(fx, before);
        assert.deepEqual(tableCounts(fx.storage), countsBefore, 'no automatic global re-evaluation, no new rows anywhere');
      });
    });

    test('an unusable policy pack accepts no existing PASS: verification throws a deterministic policy-load failure and fabricates nothing', async () => {
      await withPassedFixture((fx) => {
        const before = rows(fx);
        const countsBefore = tableCounts(fx.storage);

        fs.rmSync(policyFile);
        assert.throws(() => verify(fx), (err) => err instanceof Gate2PolicyLoadError && err.code === POLICY_LOAD_FAILURE_CODE.MISSING);

        writeRawPolicy('{ not valid json');
        assert.throws(() => verify(fx), (err) => err instanceof Gate2PolicyLoadError && err.code === POLICY_LOAD_FAILURE_CODE.MALFORMED);

        assertOnlyNonAuthorizing(fx, before);
        assert.deepEqual(tableCounts(fx.storage), countsBefore);
      });
    });
  });

  // ---------------------------------------------------------------- 10. rule-ID binding

  describe('10. rule-ID binding', () => {
    test('a PASS carrying the exact current rule-ID set authorizes', async () => {
      await withPassedFixture((fx, pass) => {
        assert.equal(pass.rule_ids_json, JSON.stringify(['GC-001', 'GC-002', 'GC-003', 'GC-004', 'GC-005']));
        assert.equal(verify(fx).authorizing, true);
      });
    });

    test('a persisted PASS whose rule-ID set is missing, extended, substituted or duplicated does not authorize', async () => {
      const wrongSets = {
        'missing GC-005': ['GC-001', 'GC-002', 'GC-003', 'GC-004'],
        'extra GC-006': ['GC-001', 'GC-002', 'GC-003', 'GC-004', 'GC-005', 'GC-006'],
        'GC-005 substituted by GC-006 (same size)': ['GC-001', 'GC-002', 'GC-003', 'GC-004', 'GC-006'],
        'duplicated GC-001 (same size)': ['GC-001', 'GC-001', 'GC-002', 'GC-003', 'GC-004']
      };
      for (const [label, ruleIds] of Object.entries(wrongSets)) {
        await withPassedFixture((fx) => {
          appendRecord(fx, RESULT.PASS, { ruleIds });
          assertNonAuthorizing(verify(fx), NON_AUTHORIZING.RULE_ID_SET_MISMATCH);
          assert.ok(label);
        });
      }
    });

    test('a persisted PASS whose rule_ids_json cannot be parsed does not authorize', async () => {
      await withPassedFixture((fx, pass) => {
        // Plain INSERT..SELECT (an append), copying the valid PASS with only rule_ids_json corrupted.
        fx.storage.run(
          `INSERT INTO gate2_compliance_records
            (id, content_version_id, decision, policy_version, rule_ids_json, rule_results_json,
             bound_content_script_id, bound_script_id, bound_script_version, bound_production_script_id,
             bound_media_artifact_id, bound_artifact_checksum, bound_working_title, bound_viewer_promise,
             bound_metadata_json, evidence_json, created_at)
           SELECT ?, content_version_id, decision, policy_version, 'not-json', rule_results_json,
             bound_content_script_id, bound_script_id, bound_script_version, bound_production_script_id,
             bound_media_artifact_id, bound_artifact_checksum, bound_working_title, bound_viewer_promise,
             bound_metadata_json, evidence_json, created_at
           FROM gate2_compliance_records WHERE id = ?`,
          [uuid(), pass.id]
        );
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.RULE_ID_SET_MISMATCH, 'unparseable_bound_rule_ids');
      });
    });

    test('a changed or unsupported rule set in the policy pack is a policy-load failure: the existing PASS is not accepted and nothing is written or transitioned', async () => {
      const invalidPacks = {
        'missing rule': REQUIRED_RULE_IDS.slice(1).map((id) => ({ id, name: id })),
        'extra rule': [...REQUIRED_RULE_IDS.map((id) => ({ id, name: id })), { id: 'GC-006', name: 'EXTRA' }],
        'substituted rule': [...REQUIRED_RULE_IDS.slice(0, 4), 'GC-006'].map((id) => ({ id, name: id }))
      };
      for (const [label, rules] of Object.entries(invalidPacks)) {
        // beforeEach only resets the policy file once per `test`, not once
        // per loop iteration, so each iteration must restore the valid V1
        // pack itself before withPassedFixture relies on it to establish
        // the baseline PASS.
        writeRawPolicy(REAL_POLICY_TEXT);
        await withPassedFixture((fx) => {
          const before = rows(fx);
          const countsBefore = tableCounts(fx.storage);
          writePolicy({ rules });

          assert.throws(
            () => verify(fx),
            (err) => err instanceof Gate2PolicyLoadError && err.code === POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET,
            label
          );
          assertOnlyNonAuthorizing(fx, before);
          assert.deepEqual(tableCounts(fx.storage), countsBefore, `${label}: verification writes nothing`);

          // The real stage surfaces the same failure: no PASS, no REVIEW/BLOCK, no transition, no compliance record.
          const stage = runFinalCompliance({ storage: fx.storage, contentBriefId: fx.contentBriefId });
          assert.equal(stage.outcome, OUTCOME.POLICY_LOAD_FAILURE);
          assert.equal(stage.reason, POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET);
          assertOnlyNonAuthorizing(fx, before);
        });
      }
    });
  });

  // ---------------------------------------------------------------- 11. REVIEW / BLOCK override PASS (real stage)

  describe('11. a newer REVIEW/BLOCK overrides an older PASS; the older PASS stays immutable (real stage path)', () => {
    test('PASS -> REVIEW: the stage appends a REVIEW, the PASS row is untouched, and nothing authorizes', async () => {
      await withPassedFixture((fx, pass) => {
        const passSnapshot = { ...pass };
        fx.addAsset('UNVERIFIED'); // attached, no asset_verifications record -> GC-002 REVIEW

        // Stale, but merely non-authorizing: no BLOCK / NEEDS_REVIEW / FAILED / new state yet.
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.EVIDENCE_REFERENCES_INVALID, 'asset_verification_not_verified');
        assert.equal(stateOf(fx), 'FINAL_COMPLIANCE');
        assert.equal(rows(fx).length, 1);

        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.REVIEW);
        assert.equal(stage.resultingState, 'NEEDS_REVIEW');

        const all = rows(fx);
        assert.equal(all.length, 2, 'append-only: the PASS is still there');
        assert.deepEqual(all[0], passSnapshot, 'the old PASS row is byte-for-byte unchanged');
        assert.equal(all[1].decision, RESULT.REVIEW);
        assert.ok(all[1].seq > all[0].seq);
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).id, all[1].id);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.STATE_NOT_FINAL_COMPLIANCE, 'state_NEEDS_REVIEW');

        // Even if state were (illegitimately) put back, the newest record alone still refuses.
        fx.storage.run(`UPDATE content_versions SET state = 'FINAL_COMPLIANCE' WHERE id = ?`, [fx.contentVersionId]);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, 'newest_REVIEW');
      });
    });

    test('PASS -> BLOCK: the stage appends a BLOCK, the PASS row is untouched, and nothing authorizes', async () => {
      await withPassedFixture((fx, pass) => {
        const passSnapshot = { ...pass };
        const assetId = fx.addAsset('UNVERIFIED');
        recordVerification(fx.storage, assetId, 'DISPUTED');

        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.BLOCK);
        assert.equal(stage.resultingState, 'BLOCKED');

        const all = rows(fx);
        assert.equal(all.length, 2);
        assert.deepEqual(all[0], passSnapshot);
        assert.equal(all[1].decision, RESULT.BLOCK);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.STATE_NOT_FINAL_COMPLIANCE, 'state_BLOCKED');

        fx.storage.run(`UPDATE content_versions SET state = 'FINAL_COMPLIANCE' WHERE id = ?`, [fx.contentVersionId]);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, 'newest_BLOCK');
      });
    });

    test('the old PASS cannot be deleted or edited to undo the override', async () => {
      await withPassedFixture((fx, pass) => {
        appendRecord(fx, RESULT.REVIEW);
        assert.throws(() => fx.storage.run('DELETE FROM gate2_compliance_records WHERE id = ?', [pass.id]), /DELETE is not permitted/);
        assert.throws(() => fx.storage.run(`UPDATE gate2_compliance_records SET decision = 'REVIEW' WHERE id = ?`, [pass.id]), /UPDATE is not permitted/);
        assert.deepEqual(rows(fx)[0], pass);
      });
    });
  });

  // ---------------------------------------------------------------- 12. fresh PASS remains authorizing

  describe('12. a fresh PASS remains authorizing', () => {
    test('every current fact matches the newest PASS -> authorizing (checked independently of the verifier), and the stage reports ALREADY_VALID without appending', async () => {
      await withPassedFixture((fx, pass) => {
        const ctx = resolveGate2Context(fx.storage, fx.contentVersionId);
        const policy = loadGate2Policy();

        assert.equal(pass.decision, RESULT.PASS);
        assert.equal(pass.content_version_id, ctx.contentVersion.id);
        assert.equal(pass.bound_content_script_id, ctx.contentVersion.script_id);
        assert.equal(pass.bound_script_id, ctx.script.id);
        assert.equal(pass.bound_script_version, ctx.script.version);
        assert.equal(pass.bound_production_script_id, ctx.production.script_id);
        assert.equal(pass.bound_media_artifact_id, ctx.media.id);
        assert.equal(pass.bound_artifact_checksum, ctx.media.artifact_checksum);
        assert.equal(pass.bound_artifact_checksum, sha256Hex(fs.readFileSync(ctx.media.artifact_path)));
        assert.equal(pass.policy_version, policy.version);
        assert.deepEqual(JSON.parse(pass.rule_ids_json), policy.ruleIds);

        const result = verify(fx);
        assert.equal(result.authorizing, true);
        assert.equal(result.record.id, pass.id);

        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.ALREADY_VALID);
        assert.equal(stage.transitioned, false);
        assert.deepEqual(rows(fx), [pass]);
      });
    });

    test('after a policy change, a fresh evaluation appends a new PASS bound to V2 (no same-state transition); the V1 PASS row is untouched', async () => {
      await withPassedFixture((fx, passV1) => {
        writePolicy({ version: V2 });
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.POLICY_VERSION_MISMATCH);

        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.PASS);
        assert.equal(stage.transitioned, false);
        assert.equal(stateOf(fx), 'FINAL_COMPLIANCE');

        const all = rows(fx);
        assert.equal(all.length, 2);
        assert.deepEqual(all[0], passV1);
        assert.equal(all[1].policy_version, V2);
        assert.ok(all[1].seq > passV1.seq);
        const result = verify(fx);
        assert.equal(result.authorizing, true);
        assert.equal(result.record.id, all[1].id);
      });
    });

    test('after a legitimate media change, a fresh evaluation appends a new PASS bound to C2; the C1 PASS row is untouched', async () => {
      await withPassedFixture((fx, passC1) => {
        fs.writeFileSync(fx.mediaPath, CHANGED_BYTES);
        setMediaChecksum(fx, C2);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.BOUND_CHECKSUM_MISMATCH);

        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.outcome, OUTCOME.PASS);
        assert.equal(stage.transitioned, false);

        const all = rows(fx);
        assert.equal(all.length, 2);
        assert.deepEqual(all[0], passC1);
        assert.equal(all[0].bound_artifact_checksum, C1);
        assert.equal(all[1].bound_artifact_checksum, C2);
        assert.equal(verify(fx).authorizing, true);
      });
    });
  });

  // ---------------------------------------------------------------- 13. no automatic rebinding

  describe('13. no automatic rebinding: changing current values never mutates the persisted PASS', () => {
    const mutations = [
      {
        name: 'applicable script identity S1 -> S3',
        reason: NON_AUTHORIZING.CONTENT_BINDING_MISMATCH,
        apply: (fx, c) => repointContentScript(fx, c.s3),
        revert: (fx) => repointContentScript(fx, fx.scriptId)
      },
      {
        name: 'script version 1 -> 2',
        reason: NON_AUTHORIZING.SCRIPT_BINDING_MISMATCH,
        apply: (fx) => fx.storage.run('UPDATE scripts SET version = 2 WHERE id = ?', [fx.scriptId]),
        revert: (fx) => fx.storage.run('UPDATE scripts SET version = 1 WHERE id = ?', [fx.scriptId])
      },
      {
        name: 'media artifact identity',
        reason: NON_AUTHORIZING.MEDIA_ARTIFACT_IDENTITY_MISMATCH,
        apply: (fx, c) => fx.storage.run('UPDATE media_artifacts SET id = ? WHERE id = ?', [c.otherMediaId, fx.mediaArtifactId]),
        revert: (fx, c) => fx.storage.run('UPDATE media_artifacts SET id = ? WHERE id = ?', [fx.mediaArtifactId, c.otherMediaId])
      },
      {
        name: 'media bytes and checksum C1 -> C2',
        reason: NON_AUTHORIZING.BOUND_CHECKSUM_MISMATCH,
        apply: (fx) => { fs.writeFileSync(fx.mediaPath, CHANGED_BYTES); setMediaChecksum(fx, C2); },
        revert: (fx) => { fs.writeFileSync(fx.mediaPath, MEDIA_BYTES); setMediaChecksum(fx, C1); }
      },
      {
        name: 'policy version V1 -> V2',
        reason: NON_AUTHORIZING.POLICY_VERSION_MISMATCH,
        apply: () => writePolicy({ version: V2 }),
        revert: () => writeRawPolicy(REAL_POLICY_TEXT)
      }
    ];

    for (const m of mutations) {
      test(`${m.name}: the persisted record is unchanged, non-authorizing while changed, authorizing again when restored`, async () => {
        await withPassedFixture((fx, pass) => {
          const context = { s3: fx.addScript(3), otherMediaId: uuid() };
          const before = rows(fx);

          m.apply(fx, context);
          assertNonAuthorizing(verify(fx), m.reason);
          evaluateGate2(fx.storage, fx.contentVersionId); // a fresh read-only evaluation must not rebind either
          assert.deepEqual(rows(fx), before, 'the historical record is not rebound to the changed value');
          assert.equal(stateOf(fx), 'FINAL_COMPLIANCE');

          m.revert(fx, context);
          const restored = verify(fx);
          assert.equal(restored.authorizing, true, 'the very same PASS is authorizing again: it was never invalidated in storage');
          assert.equal(restored.record.id, pass.id);
          assert.equal(restored.record.seq, pass.seq);
          assert.deepEqual(rows(fx), before);
        });
      });
    }
  });

  // ---------------------------------------------------------------- 14. read-only verification

  describe('14. verification is read-only', () => {
    const scenarios = [
      { name: 'authorizing PASS', setup: () => {}, expectAuthorizing: true },
      { name: 'newest record is REVIEW', setup: (fx) => appendRecord(fx, RESULT.REVIEW) },
      { name: 'script identity changed', setup: (fx) => repointContentScript(fx, fx.addScript(2)) },
      { name: 'media checksum mismatch', setup: (fx) => { fs.writeFileSync(fx.mediaPath, CHANGED_BYTES); } },
      { name: 'policy version changed', setup: () => writePolicy({ version: V2 }) },
      { name: 'evidence references changed', setup: (fx) => { fx.addAsset('UNVERIFIED'); } },
      { name: 'unusable policy pack', setup: () => writeRawPolicy('{ broken'), expectThrows: true }
    ];

    for (const s of scenarios) {
      test(`${s.name}: verifyGate2Pass inserts, updates and deletes nothing (table counts, compliance rows and item state unchanged)`, async () => {
        await withPassedFixture((fx) => {
          s.setup(fx);
          const countsBefore = tableCounts(fx.storage);
          const complianceBefore = rows(fx);
          const contentVersionBefore = fx.storage.get('SELECT * FROM content_versions WHERE id = ?', [fx.contentVersionId]);

          let first;
          let second;
          if (s.expectThrows) {
            assert.throws(() => verify(fx), Gate2PolicyLoadError);
            assert.throws(() => verify(fx), Gate2PolicyLoadError);
          } else {
            first = verify(fx);
            second = verify(fx);
            assert.equal(first.authorizing, s.expectAuthorizing === true);
            assert.deepEqual(second, first, 'repeated verification is stable');
          }

          assert.deepEqual(tableCounts(fx.storage), countsBefore, 'no table gained or lost a row');
          assert.deepEqual(rows(fx), complianceBefore);
          assert.deepEqual(fx.storage.get('SELECT * FROM content_versions WHERE id = ?', [fx.contentVersionId]), contentVersionBefore);
        });
      });
    }
  });

  // ---------------------------------------------------------------- 16. PRODUCED-origin REVIEW / BLOCK (Batch 5, B3)

  describe('16. a PRODUCED item: REVIEW -> NEEDS_REVIEW and BLOCK -> BLOCKED, persisted and transitioned together (ADR-0032 s11)', () => {
    test('PRODUCED + overall REVIEW: the compliance record is persisted and the item transitions PRODUCED -> NEEDS_REVIEW', async () => {
      await withGate2Fixture((fx) => {
        // The fixture starts at PRODUCED with no compliance history at all.
        assert.equal(stateOf(fx), 'PRODUCED');
        assert.equal(rows(fx).length, 0);
        // GC-002 REVIEW: an applicable asset with no asset_verifications record.
        fx.addAsset('UNVERIFIED');

        const stage = runGate2(fx.storage, fx.contentVersionId);

        assert.equal(stage.outcome, OUTCOME.REVIEW);
        assert.equal(stage.decision, RESULT.REVIEW);
        assert.equal(stage.transitioned, true);
        assert.equal(stage.resultingState, 'NEEDS_REVIEW');
        assert.equal(stateOf(fx), 'NEEDS_REVIEW');

        const all = rows(fx);
        assert.equal(all.length, 1, 'exactly one record was appended');
        assert.equal(all[0].decision, RESULT.REVIEW);
        assert.equal(all[0].content_version_id, fx.contentVersionId);
        // A REVIEW row may carry partial bindings, but never a PASS binding set.
        assert.equal(repoOf(fx).getNewest(fx.contentVersionId).id, all[0].id);
        // No PASS exists, so nothing authorizes.
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.STATE_NOT_FINAL_COMPLIANCE, 'state_NEEDS_REVIEW');
      });
    });

    test('PRODUCED + overall BLOCK: the compliance record is persisted and the item transitions PRODUCED -> BLOCKED', async () => {
      await withGate2Fixture((fx) => {
        assert.equal(stateOf(fx), 'PRODUCED');
        assert.equal(rows(fx).length, 0);
        // GC-002 BLOCK: the authoritative append-only history says DISPUTED.
        const assetId = fx.addAsset('UNVERIFIED');
        recordVerification(fx.storage, assetId, 'DISPUTED');

        const stage = runGate2(fx.storage, fx.contentVersionId);

        assert.equal(stage.outcome, OUTCOME.BLOCK);
        assert.equal(stage.decision, RESULT.BLOCK);
        assert.equal(stage.transitioned, true);
        assert.equal(stage.resultingState, 'BLOCKED');
        assert.equal(stateOf(fx), 'BLOCKED');

        const all = rows(fx);
        assert.equal(all.length, 1);
        assert.equal(all[0].decision, RESULT.BLOCK);
        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.STATE_NOT_FINAL_COMPLIANCE, 'state_BLOCKED');
      });
    });

    test('the compliance record and the state transition commit together: if the transition cannot be written, NO compliance record survives', async () => {
      await withGate2Fixture((fx) => {
        fx.addAsset('UNVERIFIED'); // -> overall REVIEW, so a real transition is attempted

        // Test-only guard installed on THIS temporary database: it makes the
        // content_versions UPDATE inside the stage's transaction fail. Nothing
        // in production is changed; this only forces the failure branch so the
        // rollback can be observed.
        fx.storage.run(`CREATE TRIGGER test_block_cv_update BEFORE UPDATE ON content_versions
                        BEGIN SELECT RAISE(ABORT, 'test: state transition cannot be written'); END`);

        const countsBefore = tableCounts(fx.storage);
        assert.throws(() => runGate2(fx.storage, fx.contentVersionId), /state transition cannot be written/);

        // The append happened BEFORE the failing UPDATE inside the same
        // transaction, so it must have been rolled back with it.
        assert.equal(rows(fx).length, 0, 'no compliance record survived the failed transition');
        assert.equal(stateOf(fx), 'PRODUCED', 'the item state is unchanged');
        assert.deepEqual(tableCounts(fx.storage), countsBefore, 'no table gained or lost a row');

        // With the guard removed, the identical evaluation commits both together.
        fx.storage.run('DROP TRIGGER test_block_cv_update');
        const stage = runGate2(fx.storage, fx.contentVersionId);
        assert.equal(stage.resultingState, 'NEEDS_REVIEW');
        assert.equal(stateOf(fx), 'NEEDS_REVIEW');
        assert.equal(rows(fx).length, 1, 'exactly one record -- the rolled-back attempt left nothing behind');
        assert.equal(rows(fx)[0].decision, RESULT.REVIEW);
      });
    });
  });

  // ---------------------------------------------------------------- 17. multi-provider publication: PUBLISHED content_versions

  describe('17. a PUBLISHED content_version (a different provider\'s own attempt; multi-provider publication)', () => {
    test('PUBLISHED + a currently-valid PASS is authorizing, identically to FINAL_COMPLIANCE, with every other check still enforced', async () => {
      await withPassedFixture((fx, pass) => {
        // Simulate provider A's confirmed success having already moved this
        // content_version on, exactly as ../src/publication/pipeline.js does
        // (FINAL_COMPLIANCE -> PUBLISHED) -- the compliance record itself is
        // untouched by that transition.
        fx.storage.run(`UPDATE content_versions SET state = 'PUBLISHED' WHERE id = ?`, [fx.contentVersionId]);

        const result = verify(fx);
        assert.equal(result.authorizing, true, 'a currently-valid PASS still authorizes once PUBLISHED');
        assert.equal(result.record.id, pass.id);

        // Read-only, same as every other verification: no row inserted/updated,
        // no re-transition, PUBLISHED is left exactly as it is.
        assert.equal(rows(fx).length, 1);
        assert.equal(stateOf(fx), 'PUBLISHED');
      });
    });

    test('PUBLISHED + a stale checksum (media re-rendered after publication) is non-authorizing, exactly as it would be from FINAL_COMPLIANCE', async () => {
      await withPassedFixture((fx) => {
        fx.storage.run(`UPDATE content_versions SET state = 'PUBLISHED' WHERE id = ?`, [fx.contentVersionId]);
        setMediaChecksum(fx, sha256Hex(Buffer.from('a-different-re-rendered-file')));

        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.MEDIA_CHECKSUM_MISMATCH);
        assert.equal(stateOf(fx), 'PUBLISHED', 'a non-authorizing check never reverts or transitions PUBLISHED');
      });
    });

    test('PUBLISHED + a newer REVIEW/BLOCK superseding the PASS is non-authorizing (a later compliance re-run invalidated it)', async () => {
      await withPassedFixture((fx) => {
        fx.storage.run(`UPDATE content_versions SET state = 'PUBLISHED' WHERE id = ?`, [fx.contentVersionId]);
        appendRecord(fx, RESULT.REVIEW);

        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.NEWEST_RECORD_NOT_PASS, `newest_${RESULT.REVIEW}`);
      });
    });

    test('PUBLISHED + a stale policy version is non-authorizing, exactly as it would be from FINAL_COMPLIANCE', async () => {
      await withPassedFixture((fx) => {
        fx.storage.run(`UPDATE content_versions SET state = 'PUBLISHED' WHERE id = ?`, [fx.contentVersionId]);
        writePolicy({ version: V2 });

        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.POLICY_VERSION_MISMATCH, `bound_${V1}_current_${V2}`);

        writeRawPolicy(REAL_POLICY_TEXT);
      });
    });

    test('PUBLISHED never authorizes by itself: a PUBLISHED item with no compliance record at all is refused with NO_COMPLIANCE_RECORD, not fabricated as passing', async () => {
      await withGate2Fixture((fx) => {
        fx.storage.run(`UPDATE content_versions SET state = 'PUBLISHED' WHERE id = ?`, [fx.contentVersionId]);
        assert.equal(rows(fx).length, 0, 'no compliance record exists for this item');

        assertNonAuthorizing(verify(fx), NON_AUTHORIZING.NO_COMPLIANCE_RECORD);
      });
    });
  });
});