import fs from 'node:fs';
import { config } from '../config/index.js';
import { REQUIRED_RULE_IDS } from './constants.js';

/**
 * Deterministic Gate 2 policy-load failure (ADR-0032 section 13). Carries a
 * stable machine-readable `code`. Callers surface it; they never convert it
 * into a REVIEW/BLOCK decision, never establish a PASS, never accept a
 * previously persisted PASS, and never transition state because of it.
 */
export class Gate2PolicyLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'Gate2PolicyLoadError';
    this.code = code;
  }
}

export const POLICY_LOAD_FAILURE_CODE = Object.freeze({
  MISSING: 'GATE2_POLICY_MISSING',
  UNREADABLE: 'GATE2_POLICY_UNREADABLE',
  MALFORMED: 'GATE2_POLICY_MALFORMED',
  INVALID_VERSION: 'GATE2_POLICY_INVALID_VERSION',
  INVALID_RULE_SET: 'GATE2_POLICY_INVALID_RULE_SET'
});

/**
 * Reads and validates the versioned Gate 2 policy pack FRESH from disk.
 * There is deliberately no module-level cache: this is called for every
 * Gate 2 evaluation and every publication-boundary verification, so an edit
 * to the file takes effect on the very next call (ADR-0032 section 13).
 *
 * The pack must be a JSON object with a non-empty string `version` and a
 * `rules` array whose entries' `id`s are EXACTLY the five v1 rule IDs
 * (GC-001..GC-005): no missing id, no extra id, no duplicate.
 *
 * @param {string} [policyPath] - defaults to config.gate2PolicyPath, read at call time
 * @returns {{ version: string, ruleIds: string[] }} ruleIds sorted
 * @throws {Gate2PolicyLoadError}
 */
export function loadGate2Policy(policyPath = config.gate2PolicyPath) {
  let raw;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.MISSING, `Gate 2 policy pack not found at ${policyPath}`);
    }
    throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.UNREADABLE, `Gate 2 policy pack unreadable at ${policyPath}: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.MALFORMED, `Gate 2 policy pack is not valid JSON: ${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.MALFORMED, 'Gate 2 policy pack must be a JSON object');
  }
  if (typeof parsed.version !== 'string' || parsed.version.trim().length === 0) {
    throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.INVALID_VERSION, 'Gate 2 policy pack must have a non-empty string "version"');
  }
  if (!Array.isArray(parsed.rules)) {
    throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET, 'Gate 2 policy pack must have a "rules" array');
  }
  const ids = [];
  for (const rule of parsed.rules) {
    if (rule === null || typeof rule !== 'object' || typeof rule.id !== 'string') {
      throw new Gate2PolicyLoadError(POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET, 'Every Gate 2 policy rule must be an object with a string "id"');
    }
    ids.push(rule.id);
  }
  const sorted = ids.slice().sort();
  const sameSet = sorted.length === REQUIRED_RULE_IDS.length && sorted.every((id, i) => id === REQUIRED_RULE_IDS[i]);
  if (!sameSet) {
    throw new Gate2PolicyLoadError(
      POLICY_LOAD_FAILURE_CODE.INVALID_RULE_SET,
      `Gate 2 policy pack rule IDs must be exactly [${REQUIRED_RULE_IDS.join(', ')}]; found [${sorted.join(', ')}]`
    );
  }
  return { version: parsed.version, ruleIds: sorted };
}
