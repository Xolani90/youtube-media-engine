/**
 * Script -> Media contract (B-01 / F-4 remediation).
 *
 * PRODUCER CONTRACT. The Script stage persists `scripts.body` as the
 * JSON text of a structured object (src/script/pipeline.js; Script
 * Specification §3):
 *
 *   { hook, narrative,
 *     sections: [{ heading, content, claim_ids }, ...],
 *     counterpoints, conclusion, call_to_action: string | null }
 *
 * CONSUMER CONTRACT. Narration (synthesizeNarration) and caption
 * segmentation (segmentCaptions) both operate on human-readable prose.
 * Neither parses JSON, so neither may receive the serialized body.
 *
 * THE BOUNDARY. scriptBodyToNarrationText() is the ONE deterministic
 * conversion from the persisted body into the prose that crosses
 * Script -> Media. Media Production calls it exactly once per render and
 * feeds the identical string to both narration and caption segmentation,
 * so the spoken audio and the burned-in captions can never diverge.
 *
 * Reading order (the generated order, nothing reordered or dropped):
 *   hook, narrative, each section in order (heading, then content),
 *   counterpoints, conclusion, call_to_action (only when non-null).
 *
 * Every field is emitted as its own sentence(s): a field lacking terminal
 * punctuation gets a single "." appended so speech pauses and caption
 * sentence-splitting never fuse two fields into one run-on sentence. No
 * label or connective words are invented — only generated text is spoken.
 * `claim_ids` are provenance metadata, not speech, and are not emitted.
 *
 * LEGACY / SEEDED PROSE. A body that does not look like serialized JSON
 * (does not begin with "{" or "[") is treated as already-rendered prose
 * and returned unchanged. A body that DOES look like JSON but cannot be
 * interpreted per the producer contract is a contract violation and
 * throws ScriptBodyContractError — it is never spoken or captioned.
 */

export class ScriptBodyContractError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ScriptBodyContractError';
    this.reason = reason;
  }
}

const TERMINAL_PUNCTUATION = /[.!?…]["'”’)\]]*$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Trims, collapses internal whitespace, and guarantees terminal punctuation. */
function asSentence(text) {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return TERMINAL_PUNCTUATION.test(normalized) ? normalized : `${normalized}.`;
}

function requireField(parsed, field) {
  if (!isNonEmptyString(parsed[field])) {
    throw new ScriptBodyContractError(`SCRIPT_BODY_MISSING_OR_EMPTY_FIELD_${field}`);
  }
  return parsed[field];
}

/**
 * @param {string} body - the persisted `scripts.body` value.
 * @returns {string} human-readable prose for narration and captions.
 * @throws {ScriptBodyContractError} if the body is not a string, is empty,
 *   or looks like serialized JSON but does not satisfy the producer contract.
 */
export function scriptBodyToNarrationText(body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new ScriptBodyContractError('SCRIPT_BODY_EMPTY');
  }

  const trimmed = body.trim();
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    return body; // already-rendered prose: unchanged, exactly as before
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ScriptBodyContractError('SCRIPT_BODY_MALFORMED_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ScriptBodyContractError('SCRIPT_BODY_NOT_AN_OBJECT');
  }

  const paragraphs = [];
  paragraphs.push(asSentence(requireField(parsed, 'hook')));
  paragraphs.push(asSentence(requireField(parsed, 'narrative')));

  if (!Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new ScriptBodyContractError('SCRIPT_BODY_MISSING_OR_EMPTY_SECTIONS');
  }
  parsed.sections.forEach((section, i) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new ScriptBodyContractError(`SCRIPT_BODY_INVALID_SECTION_${i}`);
    }
    if (!isNonEmptyString(section.heading)) {
      throw new ScriptBodyContractError(`SCRIPT_BODY_MISSING_SECTION_HEADING_${i}`);
    }
    if (!isNonEmptyString(section.content)) {
      throw new ScriptBodyContractError(`SCRIPT_BODY_MISSING_SECTION_CONTENT_${i}`);
    }
    paragraphs.push(`${asSentence(section.heading)} ${asSentence(section.content)}`);
  });

  paragraphs.push(asSentence(requireField(parsed, 'counterpoints')));
  paragraphs.push(asSentence(requireField(parsed, 'conclusion')));

  const cta = parsed.call_to_action;
  if (cta !== null && cta !== undefined) {
    if (!isNonEmptyString(cta)) {
      throw new ScriptBodyContractError('SCRIPT_BODY_INVALID_CALL_TO_ACTION');
    }
    paragraphs.push(asSentence(cta));
  }

  return paragraphs.join('\n\n');
}