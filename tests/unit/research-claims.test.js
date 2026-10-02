import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClaims, validateExtractedClaim, ExtractionFailureError } from '../../src/research/claims.js';
import { LLMRouter } from '../../src/providers/llm/router.js';
import { deriveClaimIdentity } from '../../src/research/claimIdentity.js';

function stubRouter(responseText) {
  const registry = {
    'claim-stub': () => ({
      id: 'claim-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete() {
        return { text: responseText, model: 'claim-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  return new LLMRouter({ priority: ['claim-stub'], allowPaidProviders: false, registry });
}

test('validateExtractedClaim accepts a well-formed claim', () => {
  const result = validateExtractedClaim({ claim: 'The product launched in March.', claim_type: 'FACT', is_load_bearing: true });
  assert.equal(result.valid, true);
});

test('validateExtractedClaim rejects missing/empty claim text', () => {
  assert.equal(validateExtractedClaim({ claim: '', claim_type: 'FACT', is_load_bearing: true }).valid, false);
  assert.equal(validateExtractedClaim({ claim_type: 'FACT', is_load_bearing: true }).valid, false);
});

test('validateExtractedClaim rejects an invalid claim_type (old four-value vocabulary must not slip through)', () => {
  const result = validateExtractedClaim({ claim: 'x', claim_type: 'verified_fact', is_load_bearing: true });
  assert.equal(result.valid, false);
  assert.match(result.reason, /claim_type/);
});

test('validateExtractedClaim rejects a non-boolean is_load_bearing', () => {
  const result = validateExtractedClaim({ claim: 'x', claim_type: 'FACT', is_load_bearing: 'yes' });
  assert.equal(result.valid, false);
  assert.match(result.reason, /is_load_bearing/);
});

test('extractClaims parses a well-formed LLM claim array', async () => {
  const router = stubRouter(JSON.stringify([
    { claim: 'The company reported $1B revenue.', claim_type: 'FACT', is_load_bearing: true },
    { claim: 'Analysts think this is impressive.', claim_type: 'OPINION', is_load_bearing: false }
  ]));
  const { claims, providerUsed } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(providerUsed, 'claim-stub');
  assert.equal(claims.length, 2);
  assert.equal(validateExtractedClaim(claims[0]).valid, true);
  assert.equal(validateExtractedClaim(claims[1]).valid, true);
});

test('extractClaims never asks the LLM for evidence_status (Generation must not include evidentiary self-certification)', async () => {
  let capturedPrompt = null;
  const registry = {
    'capture-stub': () => ({
      id: 'capture-stub', isPaid: false,
      async healthCheck() { return true; },
      async complete({ prompt }) {
        capturedPrompt = prompt;
        return { text: '[]', model: 'capture-stub', requestId: null, inputTokens: 1, outputTokens: 1, estimatedCost: 0, isPaid: false };
      }
    })
  };
  const router = new LLMRouter({ priority: ['capture-stub'], allowPaidProviders: false, registry });
  await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.match(capturedPrompt, /not.*evidence/i);
});

test('unparseable LLM output is an extraction FAILURE, never a zero-claim result', async () => {
  const router = stubRouter('not json');
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});

test('a non-array LLM output is an extraction FAILURE, never a zero-claim result', async () => {
  const router = stubRouter(JSON.stringify({ claim: 'not an array' }));
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});

// --- Markdown-fenced JSON (real Groq/openai-gpt-oss-20b observed shape) ---

const SAMPLE_CLAIM_ARRAY = JSON.stringify([
  { claim: 'Acme reported one billion dollars in Q3 revenue following the product launch.', claim_type: 'FACT', is_load_bearing: true }
]);

test('bare JSON (no fence) still parses exactly as before', async () => {
  const router = stubRouter(SAMPLE_CLAIM_ARRAY);
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim, 'Acme reported one billion dollars in Q3 revenue following the product launch.');
});

test('a claim array wrapped in exactly one ```json fence parses', async () => {
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims, rawOutput } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim_type, 'FACT');
  assert.equal(claims[0].is_load_bearing, true);
  // rawOutput must still be the exact, unmodified model output.
  assert.equal(rawOutput, '```json\n' + SAMPLE_CLAIM_ARRAY + '\n```');
});

test('a claim array wrapped in exactly one ```JSON (uppercase tag) fence parses', async () => {
  const router = stubRouter('```JSON\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
});

test('a claim array wrapped in a bare ``` fence (no language tag) parses', async () => {
  const router = stubRouter('```\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
});

test('leading/trailing whitespace around a complete fenced response is tolerated', async () => {
  const router = stubRouter('  \n```json\n' + SAMPLE_CLAIM_ARRAY + '\n```\n  ');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
});

test('the exact live Groq shape (trailing blank line before the closing fence) parses', async () => {
  // Mirrors the literal shape observed from the real groq-free/openai-gpt-oss-20b
  // response: a blank line between the JSON payload and the closing fence.
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY + '\n\n```');
  const { claims } = await extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].claim, 'Acme reported one billion dollars in Q3 revenue following the product launch.');
});

test('prose before a fenced JSON block is rejected (no substring extraction)', async () => {
  const router = stubRouter('Here is the JSON:\n```json\n' + SAMPLE_CLAIM_ARRAY + '\n```');
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});

test('prose after a fenced JSON block is rejected (no substring extraction)', async () => {
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY + '\n```\nHope that helps!');
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});

test('an unclosed fence is rejected', async () => {
  const router = stubRouter('```json\n' + SAMPLE_CLAIM_ARRAY);
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});

test('fenced malformed JSON is rejected', async () => {
  const router = stubRouter('```json\n{not valid json at all\n```');
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});

test('fenced JSON with a non-array root is rejected, same as the unfenced case', async () => {
  const router = stubRouter('```json\n' + JSON.stringify({ claim: 'not an array' }) + '\n```');
  await assert.rejects(() => extractClaims({ sourceText: 'text', coreQuestion: 'q' }, router), ExtractionFailureError);
});
// ---- Pass 32: identity-coverage guard ------------------------------------
const cid = (o) => ({ subject: 'Argon', predicate: 'launch', object: null, qualifiers: [], time: null, quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...o });
const derive = (claim, identity) => deriveClaimIdentity({ claim_type: 'FACT', claim, identity });
const SEP = 'Argon was announced on September 30 and released to trusted cyber defenders.';
const NEG = 'Google launched Argon but has not stated the input context window.';
const PARTIAL = 'compound_text_partial_identity';

test('Pass 32 matrix: atomic claims still fingerprint', () => {
  assert.ok(derive('Google launched Argon.', cid({ subject: 'Google', object: 'Argon' })).fingerprint);
  assert.ok(derive('Argon is designed to handle coding and research.', cid({ predicate: 'design', object: 'handle coding and research' })).fingerprint);
  assert.ok(derive('Argon offers secure and trusted use.', cid({ predicate: 'offer', object: 'secure and trusted use' })).fingerprint);
  assert.ok(derive('Argon launched on Wednesday in Europe.', cid({ qualifiers: ['on Wednesday', 'in Europe'] })).fingerprint);
  assert.ok(derive('Google launched a closed beta of Argon.', cid({ subject: 'Google', object: 'closed beta of Argon' })).fingerprint);
  assert.ok(derive('Google launched and released Argon.', cid({ subject: 'Google', object: 'Argon' })).fingerprint);
  assert.ok(derive('Google announced the release of Argon.', cid({ subject: 'Google', predicate: 'announce', modality: 'ANNOUNCED', object: 'release of Argon' })).fingerprint);
});

test('Pass 32 matrix: second recognized event rejects, including when copied into object/qualifiers', () => {
  const g = { subject: 'Google' };
  const t = 'Google launched Argon, then expanded testing.';
  assert.equal(derive(t, cid({ ...g, object: 'Argon' })).reason, PARTIAL);
  assert.equal(derive(t, cid({ ...g, object: 'Argon then expanded testing' })).reason, PARTIAL);
  assert.equal(derive(t, cid({ ...g, object: 'Argon', qualifiers: ['expanded testing'] })).reason, PARTIAL);
  const ann = { predicate: 'announce', modality: 'ANNOUNCED', qualifiers: ['on September 30'] };
  assert.equal(derive(SEP, cid(ann)).reason, PARTIAL);
  assert.equal(derive(SEP, cid({ ...ann, object: 'released to trusted cyber defenders' })).reason, PARTIAL);
  assert.equal(derive(SEP, cid({ ...ann, qualifiers: [...ann.qualifiers, 'released to trusted cyber defenders'] })).reason, PARTIAL);
  assert.equal(derive(SEP, cid({ ...ann, predicate: 'open' })).reason, PARTIAL); // right modality, wrong predicate
  assert.equal(derive(SEP, cid({ ...ann, predicate: 'release' })).fingerprint, null); // right predicate, wrong modality
  assert.equal(derive('Google plans to release Argon next month and has already opened testing.',
    cid({ subject: 'Google', predicate: 'release', object: 'Argon', modality: 'PLANNED', qualifiers: ['next month'] })).reason, PARTIAL);
});

test('Pass 32 matrix: affirmed + negated compound never gets a single polarity', () => {
  const g = { subject: 'Google', object: 'Argon' };
  assert.equal(derive(NEG, cid({ ...g, polarity: 'NEGATED' })).reason, 'compound_text_mixed_polarity');
  assert.equal(derive(NEG, cid(g)).reason, 'polarity_text_mismatch'); // existing precedence preserved
});

test('Pass 32 matrix: existing rejections unchanged', () => {
  assert.equal(derive('Argon raised its context window to 1M, up from 64K.', cid({ object: 'context window', quantity: 1000000, unit: 'tokens' })).reason, 'number_not_accounted');
});

test('Pass 32: guard only removes fingerprints; identity and text are not rewritten', () => {
  const identity = cid({ predicate: 'announce', modality: 'ANNOUNCED' });
  const before = JSON.stringify(identity);
  const r = derive(SEP, identity);
  assert.equal(r.fingerprint, null);
  assert.equal(JSON.stringify(identity), before);
});

// ---- Pass 33: subordinate/embedded clauses are not top-level events --------
// Expected result is stated in each assertion: FP = fingerprinted, PARTIAL =
// compound_text_partial_identity, MIXED = compound_text_mixed_polarity,
// existing = a pre-existing validator reason (not the compound guard).
test('Pass 33 false positives (FP): embedded, reported, relative, purpose and participial clauses fingerprint', () => {
  const g = { subject: 'Google' };
  assert.ok(derive('Google announced that Argon was released.', cid({ ...g, predicate: 'announce', object: 'that Argon was released', modality: 'ANNOUNCED' })).fingerprint, 'content clause: FP');
  assert.ok(derive('Google reported that Argon launched on Wednesday.', cid({ ...g, predicate: 'report', object: 'that Argon launched on Wednesday' })).fingerprint, 'reported content: FP');
  assert.ok(derive('Argon, which Google said was its most advanced model, launched on Wednesday.', cid({ qualifiers: ['on Wednesday'] })).fingerprint, 'relative clause: FP');
  assert.ok(derive('Argon, which Google said was released widely, launched on Wednesday.', cid({ qualifiers: ['on Wednesday'] })).fingerprint, 'relative clause with release verb: FP');
  assert.ok(derive('Argon launched to help developers migrate code.', cid({ qualifiers: ['to help developers migrate code'] })).fingerprint, 'purpose clause: FP');
  assert.ok(derive('Argon launched, offering improved coding performance.', cid({ qualifiers: ['offering improved coding performance'] })).fingerprint, 'participial: FP');
  assert.ok(derive('Argon launched, opening access to developers.', cid({ qualifiers: ['opening access to developers'] })).fingerprint, 'participial with table verb: FP');
  assert.ok(derive('Google announced that Argon was released and opened to developers.', cid({ ...g, predicate: 'announce', object: 'that Argon was released and opened to developers', modality: 'ANNOUNCED' })).fingerprint, 'bare "and" inside content clause: FP');
  assert.ok(derive('Argon launched after Google announced it.', cid({ modality: 'ANNOUNCED' })).fingerprint, 'after-clause: FP');
});

test('Pass 33 existing validator reasons are not the compound guard', () => {
  assert.equal(derive('Argon launched after Google announced it.', cid()).reason, 'modality_text_mismatch'); // existing
  assert.equal(derive('Argon, which Google said was released in March, launched on Wednesday.', cid({ qualifiers: ['on Wednesday'] })).reason, 'month_not_accounted'); // existing
});

test('Pass 33 true positives: top-level coordination is still rejected, including after a subordinate clause', () => {
  const g = { subject: 'Google', object: 'Argon' };
  assert.equal(derive('Google launched Argon, then expanded testing.', cid(g)).reason, PARTIAL); // then
  assert.equal(derive('Google launched Argon but opened testing only to partners.', cid(g)).reason, PARTIAL); // but
  assert.equal(derive('Google launched Argon and was acquired by Meta.', cid(g)).reason, PARTIAL); // and + aux
  assert.equal(derive('Google announced that Argon launched, then expanded testing.', cid({ subject: 'Google', predicate: 'announce', object: 'that Argon launched', modality: 'ANNOUNCED' })).reason, PARTIAL); // then after content clause
  assert.equal(derive('Argon, which Google said was advanced, launched, then expanded testing.', cid()).reason, PARTIAL); // then after relative clause
  assert.equal(derive('Google reported that Argon was released and has since opened testing.', cid({ subject: 'Google', predicate: 'report', object: 'that Argon was released' })).reason, PARTIAL); // and + aux after content clause
  assert.equal(derive(NEG, cid({ subject: 'Google', object: 'Argon', polarity: 'NEGATED' })).reason, 'compound_text_mixed_polarity'); // MIXED
});
