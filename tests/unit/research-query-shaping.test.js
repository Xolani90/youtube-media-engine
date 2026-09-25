import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeResearchQuery, RESEARCH_QUERY_MAX_WORDS, acquireSources } from '../../src/research/acquisition.js';
import { ResearchSourceProvider } from '../../src/research/ResearchSourceProvider.js';

// A. Natural-language question becomes a compact query.
test('shapeResearchQuery: strips interrogative/function words and possessive, preserving content words', () => {
  const input = "How can OpenAI's latest model release affect enterprise software developers?";
  const result = shapeResearchQuery(input);
  assert.equal(result, 'OpenAI latest model release affect enterprise software developers');
});

test('shapeResearchQuery: another natural-language example', () => {
  const input = 'Did the product launch cause a measurable sales increase, and how did the public react?';
  const result = shapeResearchQuery(input);
  // "the", "a", "and", "how" removed ("did" is not in the small explicit
  // stopword list -- only "do"/"does" are -- so it is preserved).
  assert.equal(result, 'Did product launch cause measurable sales increase did public react');
});

// B. Named entities/technical terms survive.
test('shapeResearchQuery: named entities and technical terms survive intact, casing preserved', () => {
  const input = 'What is NVIDIA doing with the new GPT-4 based Blackwell architecture in Taiwan?';
  const result = shapeResearchQuery(input);
  assert.match(result, /\bNVIDIA\b/);
  assert.match(result, /\bGPT-4\b/);
  assert.match(result, /\bBlackwell\b/);
  assert.match(result, /\bTaiwan\b/);
  // interrogative/function words gone (per the small explicit stopword list)
  assert.doesNotMatch(result, /\b(what|is|the)\b/i);
});

// C. Punctuation and repeated whitespace are normalized.
test('shapeResearchQuery: punctuation stripped and repeated whitespace collapsed', () => {
  const input = '  Why   does\tActa Inc.,   report   record   profits???  ';
  const result = shapeResearchQuery(input);
  assert.equal(/\s{2,}/.test(result), false, 'no repeated whitespace');
  assert.equal(/[?.,]/.test(result), false, 'no leftover sentence punctuation');
  assert.equal(result, 'Acta Inc report record profits');
});

test('shapeResearchQuery: possessive is dropped, not turned into a plural', () => {
  const result = shapeResearchQuery("What is Tesla's plan for its Berlin factory?");
  assert.match(result, /\bTesla\b/);
  assert.doesNotMatch(result, /Teslas/);
});

// D. Long input is bounded deterministically.
test('shapeResearchQuery: bounds output to RESEARCH_QUERY_MAX_WORDS by default', () => {
  const longQuestion = 'What ' + Array.from({ length: 30 }, (_, i) => `term${i}`).join(' ') + '?';
  const result = shapeResearchQuery(longQuestion);
  assert.equal(result.split(' ').length, RESEARCH_QUERY_MAX_WORDS);
  assert.equal(result.split(' ')[0], 'term0');
});

test('shapeResearchQuery: extends the bound (up to the hard cap) rather than truncating away the subject', () => {
  const longQuestion = 'What ' + Array.from({ length: 15 }, (_, i) => `term${i}`).join(' ') + ' CrucialSubject and more filler words after it?';
  const withoutHint = shapeResearchQuery(longQuestion);
  assert.doesNotMatch(withoutHint, /CrucialSubject/, 'without a hint, naive bounding truncates it away');

  const withHint = shapeResearchQuery(longQuestion, { subjectHint: 'CrucialSubject' });
  assert.match(withHint, /CrucialSubject/, 'with subjectHint, the primary subject is preserved');
  assert.ok(withHint.split(' ').length <= 20, 'still deterministically bounded by the hard cap');
});

// E. Empty/unusable transformation falls back safely to the original query.
test('shapeResearchQuery: falls back to the normalized original when everything is a stopword', () => {
  const result = shapeResearchQuery('What is the of a an?');
  assert.equal(result, 'What is the of a an?');
  assert.ok(result.length > 0);
});

test('shapeResearchQuery: non-string/empty input never throws and returns a string', () => {
  assert.equal(shapeResearchQuery(''), '');
  assert.equal(shapeResearchQuery(undefined), '');
  assert.equal(shapeResearchQuery(null), '');
});

// F covered by tests/unit/gdelt-search-provider.test.js and
// tests/unit/research-acquisition.test.js continuing to pass unchanged.

// Acquisition-boundary integration: the shaped query, not the raw
// core_question, is what actually reaches the provider.
class SpyProvider extends ResearchSourceProvider {
  constructor() {
    super();
    this.receivedQuery = null;
  }
  get id() { return 'spy'; }
  async healthCheck() { return true; }
  async discoverCandidates({ query }) {
    this.receivedQuery = query;
    return { candidates: [] };
  }
}

function policyWith(overrides) {
  return {
    acquisition: { max_sources_per_research_project: 8, max_acquisition_attempts: 12 },
    retry: { max_retries_per_source: 2 },
    ...overrides
  };
}

test('acquireSources passes the shaped query, not the raw core_question, to provider.discoverCandidates', async () => {
  const provider = new SpyProvider();
  await acquireSources({
    provider,
    query: "How can OpenAI's latest model release affect enterprise software developers?",
    policy: policyWith({}),
    retrieveImpl: async () => ({ status: 'SUCCESS', content: 'ok', error: null })
  });
  assert.equal(provider.receivedQuery, 'OpenAI latest model release affect enterprise software developers');
});

test('acquireSources: a query that is already a single content word (e.g. "q" in existing tests) passes through unchanged', async () => {
  const provider = new SpyProvider();
  await acquireSources({
    provider,
    query: 'q',
    policy: policyWith({}),
    retrieveImpl: async () => ({ status: 'SUCCESS', content: 'ok', error: null })
  });
  assert.equal(provider.receivedQuery, 'q');
});
