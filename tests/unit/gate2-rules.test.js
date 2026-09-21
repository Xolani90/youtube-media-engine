import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateGate2,
  evaluateAssetRights,
  evaluateFinalMetadataPresence,
  evaluateScriptMediaConsistency,
  collectAssetVerifications,
  collectProvenance,
  resolveGate2Context
} from '../../src/compliance/evaluator.js';
import { RULE, RESULT } from '../../src/compliance/constants.js';
import {
  withGate2Fixture, recordVerification, addDecisionLog, insertResearchProject, insertClaim, insertSource,
  linkClaimSource, sha256Hex, uuid, nowISO, tableCounts, MEDIA_BYTES
} from '../helpers/gate2-rule-fixture.js';

/**
 * ADR-0032 sections 4-8: dedicated GC-001 .. GC-005 tests.
 *
 * Every test runs the REAL evaluator (evaluateGate2 or the exported rule
 * function) against a REAL migrated SQLite database and a REAL media file.
 * Each test starts from a fully passing baseline and changes ONE fact.
 */

const rule = (evaluation, ruleId) => evaluation.ruleResults.find((r) => r.rule_id === ruleId);
const evaluate = (fx) => evaluateGate2(fx.storage, fx.contentVersionId);
const provenance = (fx) => {
  const ctx = resolveGate2Context(fx.storage, fx.contentVersionId);
  return collectProvenance(fx.storage, { script: ctx.script, brief: ctx.brief });
};

test('baseline fixture passes all five rules (guards every negative test below)', async () => {
  await withGate2Fixture((fx) => {
    const ev = evaluate(fx);
    assert.equal(ev.overall, RESULT.PASS);
    assert.deepEqual(ev.ruleResults.map((r) => [r.rule_id, r.result]), [
      ['GC-001', 'PASS'], ['GC-002', 'PASS'], ['GC-003', 'PASS'], ['GC-004', 'PASS'], ['GC-005', 'PASS']
    ]);
  });
});

// ------------------------------------------------------------------ GC-001

describe('GC-001 FINAL_MEDIA_INTEGRITY', () => {
  test('1. valid media artifact and matching SHA-256 -> PASS', async () => {
    await withGate2Fixture((fx) => {
      // Independent hash of the actual bytes equals what is persisted.
      assert.equal(sha256Hex(fs.readFileSync(fx.mediaPath)), fx.storage.get('SELECT artifact_checksum AS c FROM media_artifacts WHERE id = ?', [fx.mediaArtifactId]).c);
      const r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(r.reason, 'CHECKSUM_MATCH');
    });
  });

  test('2a. persisted checksum differs from the actual file -> BLOCK', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('UPDATE media_artifacts SET artifact_checksum = ? WHERE id = ?', [sha256Hex(Buffer.from('some other bytes')), fx.mediaArtifactId]);
      const r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, 'ARTIFACT_CHECKSUM_MISMATCH');
    });
  });

  test('2b. file bytes changed after the checksum was persisted -> BLOCK', async () => {
    await withGate2Fixture((fx) => {
      fs.writeFileSync(fx.mediaPath, Buffer.concat([MEDIA_BYTES, Buffer.from('-tampered')]));
      const r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, 'ARTIFACT_CHECKSUM_MISMATCH');
    });
  });

  test('3. missing media artifact row -> REVIEW (not BLOCK)', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('DELETE FROM media_artifacts WHERE id = ?', [fx.mediaArtifactId]);
      const r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'MEDIA_ARTIFACT_ROW_MISSING');
    });
  });

  test('4a. artifact file missing from disk -> REVIEW (not BLOCK)', async () => {
    await withGate2Fixture((fx) => {
      fs.rmSync(fx.mediaPath);
      const r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'ARTIFACT_FILE_MISSING');
    });
  });

  test('4b. artifact path exists but cannot be read as a file -> REVIEW (not BLOCK)', async () => {
    await withGate2Fixture((fx) => {
      fs.rmSync(fx.mediaPath);
      fs.mkdirSync(fx.mediaPath); // a directory: exists, but hashing it throws
      const r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'ARTIFACT_FILE_UNREADABLE');
    });
  });

  test('4c. required evidence missing (blank path / blank persisted checksum) -> REVIEW (not BLOCK)', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run(`UPDATE media_artifacts SET artifact_checksum = '' WHERE id = ?`, [fx.mediaArtifactId]);
      let r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'ARTIFACT_CHECKSUM_NOT_PERSISTED');

      fx.storage.run('UPDATE media_artifacts SET artifact_checksum = ?, artifact_path = ? WHERE id = ?', [sha256Hex(MEDIA_BYTES), '', fx.mediaArtifactId]);
      r = rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'ARTIFACT_PATH_MISSING');
    });
  });

  test('a nonexistent artifact_path is REVIEW, and the rule never BLOCKs on missing evidence', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('UPDATE media_artifacts SET artifact_path = ? WHERE id = ?', [path.join(fx.dir, 'nope', 'gone.mp4'), fx.mediaArtifactId]);
      assert.equal(rule(evaluate(fx), RULE.FINAL_MEDIA_INTEGRITY).result, RESULT.REVIEW);
    });
  });
});

// ------------------------------------------------------------------ GC-002

describe('GC-002 ASSET_RIGHTS', () => {
  test('1. zero applicable assets -> PASS (vacuous)', async () => {
    await withGate2Fixture((fx) => {
      const r = rule(evaluate(fx), RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(r.reason, 'NO_APPLICABLE_ASSETS');
      assert.deepEqual(evaluate(fx).evidence.asset_verifications, []);
    });
  });

  test('1b. an asset attached only to a DIFFERENT content_version is not applicable', async () => {
    await withGate2Fixture((fx) => {
      const other = fx.addOtherContentVersion();
      const foreignAsset = fx.addAsset('DISPUTED');
      // Re-point the usage from this content_version to the other one.
      fx.storage.run('UPDATE asset_usages SET content_version_id = ? WHERE asset_id = ?', [other.contentVersionId, foreignAsset]);
      recordVerification(fx.storage, foreignAsset, 'DISPUTED');
      const r = rule(evaluate(fx), RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(r.reason, 'NO_APPLICABLE_ASSETS');
    });
  });

  test('2. every applicable asset has a latest authoritative VERIFIED record -> PASS, referencing the row relied upon', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      const verificationId = recordVerification(fx.storage, a, 'VERIFIED');
      const ev = evaluate(fx);
      const r = rule(ev, RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(r.reason, 'ALL_ASSETS_VERIFIED');
      assert.deepEqual(ev.evidence.asset_verifications, [{ asset_id: a, asset_verification_id: verificationId }]);
    });
  });

  test('3. latest record NOT_VERIFIED -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      recordVerification(fx.storage, a, 'NOT_VERIFIED');
      const r = rule(evaluate(fx), RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `ASSET_NOT_VERIFIED_${a}`);
    });
  });

  test('4a. no authoritative history at all (even if the mutable cache says VERIFIED) -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset('VERIFIED'); // cache only; no asset_verifications row
      const ev = evaluate(fx);
      const r = rule(ev, RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `ASSET_NOT_VERIFIED_${a}`);
      assert.deepEqual(ev.evidence.asset_verifications, [{ asset_id: a, asset_verification_id: null }]);
    });
  });

  test('4b. an unrecognized decision value is never an inferred pass -> REVIEW', () => {
    // The table CHECK constrains decision to three values, so this branch is only
    // reachable by calling the real rule function directly.
    const r = evaluateAssetRights([{ asset_id: 'asset-x', asset_verification_id: 'v1', decision: 'SOMETHING_ELSE' }]);
    assert.equal(r.result, RESULT.REVIEW);
    assert.equal(r.reason, 'ASSET_NOT_VERIFIED_asset-x');
  });

  test('5. latest record DISPUTED -> BLOCK', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      recordVerification(fx.storage, a, 'DISPUTED');
      const r = rule(evaluate(fx), RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, `ASSET_DISPUTED_${a}`);
    });
  });

  test('6a. a newer append-only record supersedes an older one (NOT_VERIFIED -> VERIFIED)', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      recordVerification(fx.storage, a, 'NOT_VERIFIED');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.REVIEW);
      const newer = recordVerification(fx.storage, a, 'VERIFIED');
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.ASSET_RIGHTS).result, RESULT.PASS);
      assert.equal(ev.evidence.asset_verifications[0].asset_verification_id, newer);
    });
  });

  test('6b. a newer DISPUTED record supersedes an older VERIFIED one (VERIFIED -> DISPUTED)', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      recordVerification(fx.storage, a, 'VERIFIED');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.PASS);
      recordVerification(fx.storage, a, 'DISPUTED');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.BLOCK);
    });
  });

  test('6c. "newer" means insertion order, not created_at: the later-inserted row wins even with an earlier timestamp', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      const insert = (decision, createdAt) => {
        const id = uuid();
        fx.storage.run(
          `INSERT INTO asset_verifications (id, asset_id, decision, policy_id, policy_version, evidence_fields_examined, reason, verifier_type, created_at)
           VALUES (?, ?, ?, 'p', '1', '{}', 'r', 'automated', ?)`,
          [id, a, decision, createdAt]
        );
        return id;
      };
      insert('VERIFIED', '2099-01-01T00:00:00.000Z');       // inserted first, timestamp far in the future
      const later = insert('DISPUTED', '2000-01-01T00:00:00.000Z'); // inserted last, timestamp far in the past
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.ASSET_RIGHTS).result, RESULT.BLOCK);
      assert.equal(ev.evidence.asset_verifications[0].asset_verification_id, later);
    });
  });

  test('6d. no policy-version filtering: the newest record wins regardless of its policy_id / policy_version', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      const insert = (decision, policyId, policyVersion) => fx.storage.run(
        `INSERT INTO asset_verifications (id, asset_id, decision, policy_id, policy_version, evidence_fields_examined, reason, verifier_type, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', 'r', 'automated', ?)`,
        [uuid(), a, decision, policyId, policyVersion, nowISO()]
      );
      insert('VERIFIED', 'rights-policy', '1');
      insert('NOT_VERIFIED', 'some-other-policy', '99'); // newest, from an unrelated policy id/version
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.REVIEW);
      insert('VERIFIED', 'yet-another-policy', '0.0.1');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.PASS);
    });
  });

  test('7. the mutable assets.verification_status cache cannot override authoritative history', async () => {
    await withGate2Fixture((fx) => {
      // Cache says VERIFIED, history says DISPUTED -> BLOCK.
      const a1 = fx.addAsset('VERIFIED');
      recordVerification(fx.storage, a1, 'DISPUTED');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.BLOCK);

      // Cache says VERIFIED, history says NOT_VERIFIED -> REVIEW (after clearing a1's dispute by using a fresh fixture asset set).
      fx.storage.run('DELETE FROM asset_usages WHERE asset_id = ?', [a1]);
      const a2 = fx.addAsset('VERIFIED');
      recordVerification(fx.storage, a2, 'NOT_VERIFIED');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.REVIEW);

      // Cache says DISPUTED / UNVERIFIED, history says VERIFIED -> PASS.
      fx.storage.run('DELETE FROM asset_usages WHERE asset_id = ?', [a2]);
      const a3 = fx.addAsset('DISPUTED');
      recordVerification(fx.storage, a3, 'VERIFIED');
      const a4 = fx.addAsset('UNVERIFIED');
      recordVerification(fx.storage, a4, 'VERIFIED');
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.PASS);

      // Flipping the cache after the fact changes nothing.
      fx.storage.run(`UPDATE assets SET verification_status = 'DISPUTED' WHERE id = ?`, [a4]);
      assert.equal(rule(evaluate(fx), RULE.ASSET_RIGHTS).result, RESULT.PASS);
    });
  });

  test('8. multiple assets aggregate: any DISPUTED -> BLOCK, else any non-VERIFIED -> REVIEW, else PASS', async () => {
    await withGate2Fixture((fx) => {
      const a = fx.addAsset();
      const b = fx.addAsset();
      const ruleFor = () => rule(evaluate(fx), RULE.ASSET_RIGHTS);

      recordVerification(fx.storage, a, 'VERIFIED');
      recordVerification(fx.storage, b, 'VERIFIED');
      assert.equal(ruleFor().result, RESULT.PASS);

      recordVerification(fx.storage, b, 'NOT_VERIFIED'); // VERIFIED + NOT_VERIFIED
      let r = ruleFor();
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `ASSET_NOT_VERIFIED_${b}`);

      recordVerification(fx.storage, b, 'DISPUTED'); // VERIFIED + DISPUTED
      r = ruleFor();
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, `ASSET_DISPUTED_${b}`);

      recordVerification(fx.storage, a, 'NOT_VERIFIED'); // NOT_VERIFIED + DISPUTED: BLOCK outranks REVIEW
      assert.equal(ruleFor().result, RESULT.BLOCK);

      recordVerification(fx.storage, b, 'VERIFIED'); // NOT_VERIFIED + VERIFIED
      assert.equal(ruleFor().result, RESULT.REVIEW);

      recordVerification(fx.storage, a, 'VERIFIED'); // both VERIFIED again
      assert.equal(ruleFor().result, RESULT.PASS);
    });
  });

  test('8b. one verified asset plus one asset with no history -> REVIEW, naming only the unverified asset', async () => {
    await withGate2Fixture((fx) => {
      const verified = fx.addAsset();
      const noHistory = fx.addAsset();
      recordVerification(fx.storage, verified, 'VERIFIED');
      const r = rule(evaluate(fx), RULE.ASSET_RIGHTS);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `ASSET_NOT_VERIFIED_${noHistory}`);
      assert.ok(!r.reason.includes(verified));
    });
  });

  test('collectAssetVerifications is deterministic: sorted by asset_id and one entry per asset', async () => {
    await withGate2Fixture((fx) => {
      const ids = [fx.addAsset(), fx.addAsset(), fx.addAsset()];
      for (const id of ids) recordVerification(fx.storage, id, 'VERIFIED');
      // A second usage of the same asset must not duplicate it.
      fx.storage.run(`INSERT INTO asset_usages (id, asset_id, content_version_id, usage_context, created_at) VALUES (?, ?, ?, 'again', ?)`, [uuid(), ids[0], fx.contentVersionId, nowISO()]);
      const collected = collectAssetVerifications(fx.storage, fx.contentVersionId);
      assert.deepEqual(collected.map((c) => c.asset_id), [...ids].sort());
    });
  });
});

// ------------------------------------------------------------------ GC-003

describe('GC-003 FINAL_METADATA', () => {
  const setBrief = (fx, column, value) => fx.storage.run(`UPDATE content_briefs SET ${column} = ? WHERE id = ?`, [value, fx.contentBriefId]);

  test('1. valid nonblank working_title + viewer_promise -> PASS', async () => {
    await withGate2Fixture((fx) => {
      const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(r.reason, 'METADATA_PRESENT');
    });
  });

  test('1b. surrounding whitespace around real text is still PASS, and the binding keeps the exact stored text', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'working_title', '  Padded Title  ');
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.FINAL_METADATA_PRESENCE).result, RESULT.PASS);
      assert.equal(ev.binding.workingTitle, '  Padded Title  ');
    });
  });

  test('2. null working_title -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'working_title', null);
      const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_WORKING_TITLE');
    });
  });

  test('3. blank / whitespace-only working_title -> REVIEW', async () => {
    for (const blank of ['', ' ', '   ', '\t', '\n', ' \t\r\n ', '\u00a0']) {
      await withGate2Fixture((fx) => {
        setBrief(fx, 'working_title', blank);
        const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
        assert.equal(r.result, RESULT.REVIEW, `working_title ${JSON.stringify(blank)}`);
        assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_WORKING_TITLE');
      });
    }
  });

  test('4. null viewer_promise -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'viewer_promise', null);
      const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_VIEWER_PROMISE');
    });
  });

  test('5. blank / whitespace-only viewer_promise -> REVIEW', async () => {
    for (const blank of ['', ' ', '   ', '\t', '\n', ' \t\r\n ', '\u00a0']) {
      await withGate2Fixture((fx) => {
        setBrief(fx, 'viewer_promise', blank);
        const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
        assert.equal(r.result, RESULT.REVIEW, `viewer_promise ${JSON.stringify(blank)}`);
        assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_VIEWER_PROMISE');
      });
    }
  });

  test('both fields bad -> a single REVIEW naming both', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'working_title', null);
      setBrief(fx, 'viewer_promise', '   ');
      const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_WORKING_TITLE_AND_VIEWER_PROMISE');
    });
  });

  test('non-string values (a BLOB stored in the column) -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'working_title', Buffer.from('bytes, not a string'));
      assert.equal(rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE).result, RESULT.REVIEW);
      setBrief(fx, 'working_title', 'Fine Title');
      setBrief(fx, 'viewer_promise', Buffer.from('bytes, not a string'));
      assert.equal(rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE).result, RESULT.REVIEW);
    });
  });

  test('6. the generated publication fallback "Untitled (<content_version_id>)" never satisfies the rule -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      // Exactly what src/publication/PublicationRequest.js generates when working_title is null.
      const generatedFallback = `Untitled (${fx.contentVersionId})`;
      setBrief(fx, 'working_title', null);
      // The publication fallback would read as a plausible title but must not pass Gate 2:
      assert.equal(rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE).result, RESULT.REVIEW);
      // The pure rule agrees when handed the generated fallback directly.
      const r = evaluateFinalMetadataPresence({ workingTitle: generatedFallback, viewerPromise: 'A promise', contentVersionId: fx.contentVersionId });
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_WORKING_TITLE');
    });
  });

  test('7. a STORED literal fallback title remains REVIEW (also with surrounding whitespace)', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'working_title', `Untitled (${fx.contentVersionId})`);
      const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'METADATA_MISSING_OR_BLANK_WORKING_TITLE');

      setBrief(fx, 'working_title', `  Untitled (${fx.contentVersionId})\n`);
      assert.equal(rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE).result, RESULT.REVIEW);
    });
  });

  test('7b. a title that merely contains the word Untitled is real text and PASSes', async () => {
    await withGate2Fixture((fx) => {
      setBrief(fx, 'working_title', 'Untitled Masterpieces of the 1970s');
      assert.equal(rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE).result, RESULT.PASS);
    });
  });

  test('8. no GC-003 input can ever produce BLOCK', async () => {
    const values = [null, undefined, '', ' ', '\t\n', 'Real', '  Real  ', 'Untitled (some-id)', 0, 42, true, {}, [], Buffer.from('x')];
    const seen = new Set();
    for (const workingTitle of values) {
      for (const viewerPromise of values) {
        const r = evaluateFinalMetadataPresence({ workingTitle, viewerPromise, contentVersionId: 'some-id' });
        seen.add(r.result);
        assert.notEqual(r.result, RESULT.BLOCK, `title=${String(workingTitle)} promise=${String(viewerPromise)}`);
      }
    }
    assert.deepEqual([...seen].sort(), [RESULT.PASS, RESULT.REVIEW].sort());

    // And end to end, with the brief unresolvable (no script pointer -> no brief).
    await withGate2Fixture((fx) => {
      fx.storage.run('UPDATE content_versions SET script_id = NULL WHERE id = ?', [fx.contentVersionId]);
      const r = rule(evaluate(fx), RULE.FINAL_METADATA_PRESENCE);
      assert.equal(r.result, RESULT.REVIEW);
    });
  });
});

// ------------------------------------------------------------------ GC-004

describe('GC-004 CONTENT_LINEAGE (SCRIPT_MEDIA_CONSISTENCY)', () => {
  test('1. consistent content / script / production / media lineage -> PASS', async () => {
    await withGate2Fixture((fx) => {
      const ev = evaluate(fx);
      const r = rule(ev, RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(r.reason, 'CONSISTENT');
      assert.equal(ev.binding.contentScriptId, fx.scriptId);
      assert.equal(ev.binding.scriptId, fx.scriptId);
      assert.equal(ev.binding.productionScriptId, fx.scriptId);
      assert.equal(ev.binding.scriptVersion, 1);
      assert.equal(ev.binding.mediaArtifactId, fx.mediaArtifactId);
    });
  });

  test('2a. missing media artifact row -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('DELETE FROM media_artifacts WHERE id = ?', [fx.mediaArtifactId]);
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'MISSING_MEDIA_ARTIFACT_ROW');
    });
  });

  test('2b. missing production (and therefore media) row -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('DELETE FROM media_artifacts WHERE id = ?', [fx.mediaArtifactId]);
      fx.storage.run('DELETE FROM productions WHERE id = ?', [fx.productionId]);
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'MISSING_PRODUCTION_ROW_MEDIA_ARTIFACT_ROW');
    });
  });

  test('2c. content_versions.script_id absent (no script evidence) -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('UPDATE content_versions SET script_id = NULL WHERE id = ?', [fx.contentVersionId]);
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'MISSING_CONTENT_VERSION_SCRIPT_ID_SCRIPT_ROW');
    });
  });

  test('3a. missing required lineage evidence: script version is not an integer -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run(`UPDATE scripts SET version = 'not-a-number' WHERE id = ?`, [fx.scriptId]);
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'MISSING_SCRIPT_VERSION');
    });
  });

  test('3b. missing required lineage evidence: script row unresolved (real rows, script removed from context) -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const ctx = resolveGate2Context(fx.storage, fx.contentVersionId);
      const r = evaluateScriptMediaConsistency({ ...ctx, script: null });
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'MISSING_SCRIPT_ROW');
    });
  });

  test('3c. missing evidence never BLOCKs on its own (every single-row removal is REVIEW)', async () => {
    await withGate2Fixture((fx) => {
      const ctx = resolveGate2Context(fx.storage, fx.contentVersionId);
      for (const missing of ['script', 'production', 'media']) {
        const r = evaluateScriptMediaConsistency({ ...ctx, [missing]: null });
        assert.equal(r.result, RESULT.REVIEW, `missing ${missing}`);
      }
    });
  });

  test('4a. contradictory identity: productions.script_id differs from content_versions.script_id -> BLOCK', async () => {
    await withGate2Fixture((fx) => {
      const otherScript = fx.addScript(2);
      fx.storage.run('UPDATE productions SET script_id = ? WHERE id = ?', [otherScript, fx.productionId]);
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, 'INCONSISTENT_PRODUCTION_SCRIPT_ID_VS_CONTENT_VERSION');
    });
  });

  test('4b. contradictory identity: media artifact belongs to a different production -> BLOCK', async () => {
    await withGate2Fixture((fx) => {
      const other = fx.addOtherContentVersion();
      fx.storage.run('UPDATE media_artifacts SET production_id = ? WHERE id = ?', [other.productionId, fx.mediaArtifactId]);
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, 'INCONSISTENT_MEDIA_PRODUCTION_ID_VS_PRODUCTION');
    });
  });

  test('4c. identity contradictions the resolver cannot construct from FK-joined rows are still BLOCK when the real rule sees them', async () => {
    await withGate2Fixture((fx) => {
      const ctx = resolveGate2Context(fx.storage, fx.contentVersionId);
      const cases = [
        [{ ...ctx, script: { ...ctx.script, id: 'a-different-script-id' } }, 'INCONSISTENT_SCRIPT_ID_VS_CONTENT_VERSION'],
        [{ ...ctx, production: { ...ctx.production, content_version_id: 'a-different-content-version' } }, 'INCONSISTENT_PRODUCTION_CONTENT_VERSION'],
        [{ ...ctx, media: { ...ctx.media, content_version_id: 'a-different-content-version' } }, 'INCONSISTENT_MEDIA_CONTENT_VERSION']
      ];
      for (const [input, reason] of cases) {
        const r = evaluateScriptMediaConsistency(input);
        assert.equal(r.result, RESULT.BLOCK);
        assert.equal(r.reason, reason);
      }
    });
  });

  test('4d. a present contradiction outranks missing evidence (BLOCK, not REVIEW)', async () => {
    await withGate2Fixture((fx) => {
      const otherScript = fx.addScript(2);
      fx.storage.run('UPDATE productions SET script_id = ? WHERE id = ?', [otherScript, fx.productionId]);
      fx.storage.run('DELETE FROM media_artifacts WHERE id = ?', [fx.mediaArtifactId]); // also missing media
      const r = rule(evaluate(fx), RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.BLOCK);
    });
  });

  test('5. regenerated script inconsistent with the current content version -> BLOCK', async () => {
    await withGate2Fixture((fx) => {
      // The script was regenerated (v2) and the content version now points at it,
      // but the production/media were built from the ORIGINAL script (v1).
      const regenerated = fx.addScript(2);
      fx.storage.run('UPDATE content_versions SET script_id = ? WHERE id = ?', [regenerated, fx.contentVersionId]);
      const ev = evaluate(fx);
      const r = rule(ev, RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.BLOCK);
      assert.equal(r.reason, 'INCONSISTENT_PRODUCTION_SCRIPT_ID_VS_CONTENT_VERSION');
      assert.equal(ev.overall, RESULT.BLOCK);
    });
  });

  test('6. correct script / version / media identity after regeneration -> PASS, bound to the regenerated script', async () => {
    await withGate2Fixture((fx) => {
      const regenerated = fx.addScript(2);
      fx.storage.run('UPDATE content_versions SET script_id = ? WHERE id = ?', [regenerated, fx.contentVersionId]);
      fx.storage.run('UPDATE productions SET script_id = ? WHERE id = ?', [regenerated, fx.productionId]);
      const ev = evaluate(fx);
      const r = rule(ev, RULE.SCRIPT_MEDIA_CONSISTENCY);
      assert.equal(r.result, RESULT.PASS);
      assert.equal(ev.binding.scriptId, regenerated);
      assert.equal(ev.binding.contentScriptId, regenerated);
      assert.equal(ev.binding.productionScriptId, regenerated);
      assert.equal(ev.binding.scriptVersion, 2);
      assert.equal(ev.binding.mediaArtifactId, fx.mediaArtifactId);
    });
  });
});

// ------------------------------------------------------------------ GC-005

describe('GC-005 GENERATION_PROVENANCE (EXISTING_PROVENANCE)', () => {
  /** Adds a full claim -> source -> extraction chain inside the fixture's research project and lists the claim in key_claims. */
  function addChain(fx, { extraction = true } = {}) {
    const claimId = insertClaim(fx.storage, fx.researchProjectId);
    const sourceId = insertSource(fx.storage, fx.researchProjectId);
    linkClaimSource(fx.storage, claimId, sourceId);
    const extractionId = extraction
      ? addDecisionLog(fx.storage, { subjectType: 'source', subjectId: sourceId, stage: 'CLAIM_EXTRACTION', decision: 'EXTRACTED' })
      : null;
    fx.storage.run('UPDATE content_briefs SET key_claims = ? WHERE id = ?', [JSON.stringify([claimId]), fx.contentBriefId]);
    return { claimId, sourceId, extractionId };
  }
  const setKeyClaims = (fx, raw) => fx.storage.run('UPDATE content_briefs SET key_claims = ? WHERE id = ?', [raw, fx.contentBriefId]);

  test('1. exactly one accepted script-generation row tied to the current brief -> PASS (that row is the one referenced)', async () => {
    await withGate2Fixture((fx) => {
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.EXISTING_PROVENANCE).result, RESULT.PASS);
      assert.equal(ev.evidence.decision_log.script_generation_id, fx.scriptGenerationId);
    });
  });

  test('1b. accepted rows keyed to a DIFFERENT brief, and non-ACCEPTED / other-stage rows, do not count for the current brief', async () => {
    await withGate2Fixture((fx) => {
      const other = fx.addOtherContentVersion();
      addDecisionLog(fx.storage, { subjectType: 'content_brief', subjectId: other.briefId, stage: 'SCRIPT_GENERATION', decision: 'ACCEPTED' });
      addDecisionLog(fx.storage, { subjectType: 'content_brief', subjectId: fx.contentBriefId, stage: 'SCRIPT_GENERATION', decision: 'REJECTED' });
      addDecisionLog(fx.storage, { subjectType: 'content_brief', subjectId: fx.contentBriefId, stage: 'SOME_OTHER_STAGE', decision: 'ACCEPTED' });
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.EXISTING_PROVENANCE).result, RESULT.PASS);
      assert.equal(ev.evidence.decision_log.script_generation_id, fx.scriptGenerationId);
    });
  });

  test('2. exactly one accepted brief-generation row tied to the current research project -> PASS (that row is the one referenced)', async () => {
    await withGate2Fixture((fx) => {
      const otherProject = insertResearchProject(fx.storage);
      addDecisionLog(fx.storage, { subjectType: 'research_project', subjectId: otherProject, stage: 'BRIEF_GENERATION', decision: 'ACCEPTED' });
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.EXISTING_PROVENANCE).result, RESULT.PASS);
      assert.equal(ev.evidence.decision_log.brief_generation_id, fx.briefGenerationId);
    });
  });

  test('3a. missing accepted script-generation row -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('DELETE FROM decision_log WHERE id = ?', [fx.scriptGenerationId]);
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'SCRIPT_GENERATION_ACCEPTED_ROW_ABSENT');
    });
  });

  test('3b. missing accepted brief-generation row -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('DELETE FROM decision_log WHERE id = ?', [fx.briefGenerationId]);
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'BRIEF_GENERATION_ACCEPTED_ROW_ABSENT');
    });
  });

  test('3c. a generation row that is not ACCEPTED is treated as absent -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run(`UPDATE decision_log SET decision = 'REJECTED' WHERE id = ?`, [fx.scriptGenerationId]);
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'SCRIPT_GENERATION_ACCEPTED_ROW_ABSENT');
    });
  });

  test('3d. brief with no research project (brief lineage cannot be established) -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('UPDATE content_briefs SET research_project_id = NULL WHERE id = ?', [fx.contentBriefId]);
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'BRIEF_RESEARCH_PROJECT_ABSENT');
    });
  });

  test('3e. unresolvable script -> REVIEW, lineage never invented', async () => {
    await withGate2Fixture((fx) => {
      fx.storage.run('UPDATE content_versions SET script_id = NULL WHERE id = ?', [fx.contentVersionId]);
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'SCRIPT_UNRESOLVED');
    });
  });

  test('4a. multiple accepted script-generation rows -> REVIEW (ambiguous, no row referenced)', async () => {
    await withGate2Fixture((fx) => {
      addDecisionLog(fx.storage, { subjectType: 'content_brief', subjectId: fx.contentBriefId, stage: 'SCRIPT_GENERATION', decision: 'ACCEPTED' });
      const ev = evaluate(fx);
      const r = rule(ev, RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'SCRIPT_GENERATION_ACCEPTED_ROW_AMBIGUOUS');
      assert.equal(ev.evidence.decision_log.script_generation_id, null);
    });
  });

  test('4b. multiple accepted brief-generation rows -> REVIEW (ambiguous, no row referenced)', async () => {
    await withGate2Fixture((fx) => {
      addDecisionLog(fx.storage, { subjectType: 'research_project', subjectId: fx.researchProjectId, stage: 'BRIEF_GENERATION', decision: 'ACCEPTED' });
      const ev = evaluate(fx);
      const r = rule(ev, RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, 'BRIEF_GENERATION_ACCEPTED_ROW_AMBIGUOUS');
      assert.equal(ev.evidence.decision_log.brief_generation_id, null);
    });
  });

  test('5a. complete claim -> source -> single extraction chain -> PASS, referencing the extraction row', async () => {
    await withGate2Fixture((fx) => {
      const { sourceId, extractionId } = addChain(fx);
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.EXISTING_PROVENANCE).result, RESULT.PASS);
      assert.deepEqual(ev.evidence.decision_log.claim_extractions, [{ source_id: sourceId, decision_log_id: extractionId }]);
    });
  });

  test('5b. no extraction row for a linked source -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const { sourceId } = addChain(fx, { extraction: false });
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `CLAIM_EXTRACTION_ROW_ABSENT_${sourceId}`);
    });
  });

  test('5c. ambiguous / multiple extraction rows for a linked source -> REVIEW (no row referenced)', async () => {
    await withGate2Fixture((fx) => {
      const { sourceId } = addChain(fx);
      addDecisionLog(fx.storage, { subjectType: 'source', subjectId: sourceId, stage: 'CLAIM_EXTRACTION', decision: 'EXTRACTED' });
      const ev = evaluate(fx);
      const r = rule(ev, RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `CLAIM_EXTRACTION_ROW_AMBIGUOUS_${sourceId}`);
      assert.deepEqual(ev.evidence.decision_log.claim_extractions, [{ source_id: sourceId, decision_log_id: null }]);
    });
  });

  test('6a. required claim linkage missing: key_claims names an unknown claim -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const ghost = uuid();
      setKeyClaims(fx, JSON.stringify([ghost]));
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `KEY_CLAIM_UNKNOWN_${ghost}`);
    });
  });

  test('6b. required source linkage missing: a key claim with no claim_sources row -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const claimId = insertClaim(fx.storage, fx.researchProjectId);
      setKeyClaims(fx, JSON.stringify([claimId]));
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `KEY_CLAIM_HAS_NO_SOURCE_${claimId}`);
    });
  });

  test('6c. unusable key_claims payloads (unparseable / not an array / bad entries) -> REVIEW', async () => {
    const cases = [
      ['this is not json', 'KEY_CLAIMS_UNPARSEABLE'],
      ['{"a":1}', 'KEY_CLAIMS_NOT_AN_ARRAY'],
      ['"a-string"', 'KEY_CLAIMS_NOT_AN_ARRAY'],
      ['[1,2]', 'KEY_CLAIMS_INVALID_ENTRY'],
      ['[""]', 'KEY_CLAIMS_INVALID_ENTRY'],
      ['[null]', 'KEY_CLAIMS_INVALID_ENTRY']
    ];
    for (const [raw, reason] of cases) {
      await withGate2Fixture((fx) => {
        setKeyClaims(fx, raw);
        const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
        assert.equal(r.result, RESULT.REVIEW, raw);
        assert.equal(r.reason, reason, raw);
      });
    }
  });

  test('7a. claim outside the applicable research project -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const foreignProject = insertResearchProject(fx.storage);
      const foreignClaim = insertClaim(fx.storage, foreignProject);
      const source = insertSource(fx.storage, foreignProject);
      linkClaimSource(fx.storage, foreignClaim, source);
      setKeyClaims(fx, JSON.stringify([foreignClaim]));
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `KEY_CLAIM_OUTSIDE_RESEARCH_PROJECT_${foreignClaim}`);
    });
  });

  test('7b. in-project claim linked to a source outside the applicable research project -> REVIEW', async () => {
    await withGate2Fixture((fx) => {
      const foreignProject = insertResearchProject(fx.storage);
      const foreignSource = insertSource(fx.storage, foreignProject);
      addDecisionLog(fx.storage, { subjectType: 'source', subjectId: foreignSource, stage: 'CLAIM_EXTRACTION', decision: 'EXTRACTED' }); // extraction exists; only project scope is wrong
      const claimId = insertClaim(fx.storage, fx.researchProjectId);
      linkClaimSource(fx.storage, claimId, foreignSource);
      setKeyClaims(fx, JSON.stringify([claimId]));
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.equal(r.reason, `SOURCE_OUTSIDE_RESEARCH_PROJECT_${foreignSource}`);
    });
  });

  test('8. empty / null key_claims with no source chain required does not create a false failure', async () => {
    for (const raw of [null, '', '   ', '[]', ' [] ']) {
      await withGate2Fixture((fx) => {
        setKeyClaims(fx, raw);
        const ev = evaluate(fx);
        assert.equal(rule(ev, RULE.EXISTING_PROVENANCE).result, RESULT.PASS, `key_claims=${JSON.stringify(raw)}`);
        assert.deepEqual(ev.evidence.decision_log.claim_extractions, []);
      });
    }
  });

  test('8b. claims/sources that exist in the project but are NOT listed in key_claims are not required', async () => {
    await withGate2Fixture((fx) => {
      const claimId = insertClaim(fx.storage, fx.researchProjectId);
      const sourceId = insertSource(fx.storage, fx.researchProjectId);
      linkClaimSource(fx.storage, claimId, sourceId); // deliberately no extraction row, not in key_claims
      const ev = evaluate(fx);
      assert.equal(rule(ev, RULE.EXISTING_PROVENANCE).result, RESULT.PASS);
      assert.deepEqual(ev.evidence.decision_log.claim_extractions, []);
    });
  });

  test('9a. no new provenance subsystem: evaluation is strictly read-only (no row written to any table)', async () => {
    await withGate2Fixture((fx) => {
      addChain(fx);
      const before = tableCounts(fx.storage);
      evaluate(fx);
      assert.deepEqual(tableCounts(fx.storage), before, 'PASS-path evaluation wrote rows');

      fx.storage.run('DELETE FROM decision_log WHERE id = ?', [fx.briefGenerationId]);
      const beforeReview = tableCounts(fx.storage);
      evaluate(fx);
      assert.deepEqual(tableCounts(fx.storage), beforeReview, 'REVIEW-path evaluation wrote rows');
    });
  });

  test('9b. no new provenance subsystem: evidence holds only references to EXISTING decision_log rows (no new id or hash)', async () => {
    await withGate2Fixture((fx) => {
      const { extractionId } = addChain(fx);
      const ev = evaluate(fx);
      assert.deepEqual(Object.keys(ev.evidence).sort(), ['asset_verifications', 'decision_log', 'media']);
      assert.deepEqual(Object.keys(ev.evidence.decision_log).sort(), ['brief_generation_id', 'claim_extractions', 'script_generation_id']);
      const referenced = [ev.evidence.decision_log.script_generation_id, ev.evidence.decision_log.brief_generation_id, extractionId];
      assert.deepEqual(referenced, [fx.scriptGenerationId, fx.briefGenerationId, extractionId]);
      for (const id of referenced) {
        assert.ok(fx.storage.get('SELECT id FROM decision_log WHERE id = ?', [id]), `evidence id ${id} is not an existing decision_log row`);
      }
    });
  });

  test('9c. no provider_calls / contentId wiring: provider_calls rows neither create nor replace provenance', async () => {
    await withGate2Fixture((fx) => {
      const insertCall = (jobStage) => fx.storage.run(
        `INSERT INTO provider_calls (id, content_id, job_stage, provider, timestamp) VALUES (?, ?, ?, 'test-provider', ?)`,
        [uuid(), fx.contentVersionId, jobStage, nowISO()]
      );
      const baseline = provenance(fx);
      insertCall('SCRIPT_GENERATION');
      insertCall('BRIEF_GENERATION');
      assert.deepEqual(provenance(fx), baseline, 'provider_calls rows changed the provenance result');

      // With the generation rows gone, provider_calls must NOT make provenance resolve.
      fx.storage.run('DELETE FROM decision_log WHERE id IN (?, ?)', [fx.scriptGenerationId, fx.briefGenerationId]);
      const r = rule(evaluate(fx), RULE.EXISTING_PROVENANCE);
      assert.equal(r.result, RESULT.REVIEW);
      assert.match(r.reason, /SCRIPT_GENERATION_ACCEPTED_ROW_ABSENT/);
      assert.match(r.reason, /BRIEF_GENERATION_ACCEPTED_ROW_ABSENT/);
    });
  });

  test('GC-005 never produces BLOCK across every failure mode above', async () => {
    const mutate = [
      (fx) => fx.storage.run('DELETE FROM decision_log WHERE id = ?', [fx.scriptGenerationId]),
      (fx) => addDecisionLog(fx.storage, { subjectType: 'research_project', subjectId: fx.researchProjectId, stage: 'BRIEF_GENERATION', decision: 'ACCEPTED' }),
      (fx) => setKeyClaims(fx, 'garbage'),
      (fx) => setKeyClaims(fx, JSON.stringify([uuid()])),
      (fx) => fx.storage.run('UPDATE content_briefs SET research_project_id = NULL WHERE id = ?', [fx.contentBriefId]),
      (fx) => fx.storage.run('UPDATE content_versions SET script_id = NULL WHERE id = ?', [fx.contentVersionId])
    ];
    for (const m of mutate) {
      await withGate2Fixture((fx) => {
        m(fx);
        assert.equal(rule(evaluate(fx), RULE.EXISTING_PROVENANCE).result, RESULT.REVIEW);
      });
    }
  });
});