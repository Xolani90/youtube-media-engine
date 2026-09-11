import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveCurrentScript } from '../../src/fact-check/eligibility.js';

function fakeStorage(rows) {
  return {
    get(sql, params) {
      if (sql.includes('FROM content_versions')) {
        return rows.contentVersions.find((r) => r.content_brief_id === params[0]);
      }
      if (sql.includes('FROM scripts')) {
        return rows.scripts.find((r) => r.id === params[0]);
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
}

test('resolveCurrentScript: uses content_versions.script_id, not scripts ORDER BY version', () => {
  const storage = fakeStorage({
    contentVersions: [{ id: 'cv1', content_brief_id: 'brief1', script_id: 'scriptA', state: 'SCRIPT_DRAFT' }],
    // scriptB has a HIGHER version than scriptA, but content_versions
    // points at scriptA. If resolution used ORDER BY version DESC it
    // would (incorrectly) pick scriptB.
    scripts: [
      { id: 'scriptA', content_brief_id: 'brief1', version: 1 },
      { id: 'scriptB', content_brief_id: 'brief1', version: 2 }
    ]
  });

  const result = resolveCurrentScript(storage, 'brief1');

  assert.equal(result.eligible, true);
  assert.equal(result.script.id, 'scriptA', 'must use content_versions.script_id authority, not the highest scripts.version');
});

test('resolveCurrentScript: no content_versions row -> ineligible', () => {
  const storage = fakeStorage({ contentVersions: [], scripts: [] });
  const result = resolveCurrentScript(storage, 'missing-brief');
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'CONTENT_VERSION_NOT_FOUND');
});

test('resolveCurrentScript: content_versions.script_id is null -> ineligible', () => {
  const storage = fakeStorage({
    contentVersions: [{ id: 'cv1', content_brief_id: 'brief1', script_id: null, state: 'BRIEF_CREATED' }],
    scripts: []
  });
  const result = resolveCurrentScript(storage, 'brief1');
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'NO_CURRENT_SCRIPT');
});

test('resolveCurrentScript: content_versions.script_id points at a missing scripts row -> ineligible', () => {
  const storage = fakeStorage({
    contentVersions: [{ id: 'cv1', content_brief_id: 'brief1', script_id: 'ghost', state: 'SCRIPT_DRAFT' }],
    scripts: []
  });
  const result = resolveCurrentScript(storage, 'brief1');
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'CURRENT_SCRIPT_NOT_FOUND');
});