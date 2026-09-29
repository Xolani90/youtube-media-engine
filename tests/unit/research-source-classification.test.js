import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySourceRole, classifySourceQuality } from '../../src/research/sourceClassification.js';

test('classifySourceRole: matches an authoritative domain -> primary_authoritative', () => {
  const result = classifySourceRole('https://www.acme.com/press-release', { authoritativeDomains: ['acme.com'] });
  assert.equal(result.role, 'primary_authoritative');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: matches a syndicated domain -> syndicated', () => {
  const result = classifySourceRole('https://aggregator.example/copy', { syndicatedDomains: ['aggregator.example'] });
  assert.equal(result.role, 'syndicated');
});

test('classifySourceRole: unmatched domain defaults to independent_reporting', () => {
  const result = classifySourceRole('https://news.example/story', { authoritativeDomains: ['acme.com'] });
  assert.equal(result.role, 'independent_reporting');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: unparseable URL is flagged ambiguous rather than silently guessed', () => {
  const result = classifySourceRole('not a url', {});
  assert.equal(result.ambiguous, true);
});

test('classifySourceQuality: role and quality are independent — role alone determines the default tier', () => {
  assert.equal(classifySourceQuality('SUCCESS', 'primary_authoritative'), 'HIGH');
  assert.equal(classifySourceQuality('SUCCESS', 'independent_reporting'), 'MEDIUM');
  assert.equal(classifySourceQuality('SUCCESS', 'syndicated'), 'LOW');
});

test('classifySourceQuality: any non-SUCCESS retrieval is always UNUSABLE regardless of role', () => {
  assert.equal(classifySourceQuality('FAILED', 'primary_authoritative'), 'UNUSABLE');
  assert.equal(classifySourceQuality('CONTENT_UNPARSEABLE', 'independent_reporting'), 'UNUSABLE');
});

test('classifySourceRole: empty production-style config keeps TechCrunch as independent_reporting', () => {
  const result = classifySourceRole('https://techcrunch.com/2026/09/29/example-story', {
    authoritativeDomains: [],
    syndicatedDomains: []
  });
  assert.equal(result.role, 'independent_reporting');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: empty production-style config keeps arbitrary sources independent_reporting', () => {
  const result = classifySourceRole('https://example.org/story', {
    authoritativeDomains: [],
    syndicatedDomains: []
  });
  assert.equal(result.role, 'independent_reporting');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: configured synthetic authority domain is primary_authoritative', () => {
  const result = classifySourceRole('https://example-authority.test/article', {
    authoritativeDomains: ['example-authority.test']
  });
  assert.equal(result.role, 'primary_authoritative');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: configured synthetic syndicated domain is syndicated', () => {
  const result = classifySourceRole('https://example-syndicated.test/article', {
    syndicatedDomains: ['example-syndicated.test']
  });
  assert.equal(result.role, 'syndicated');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: www prefix is normalized for configured domains', () => {
  const result = classifySourceRole('https://www.example-authority.test/article', {
    authoritativeDomains: ['example-authority.test']
  });
  assert.equal(result.role, 'primary_authoritative');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: parent domain does not match an unrelated subdomain configuration', () => {
  const result = classifySourceRole('https://sub.example-authority.test/article', {
    authoritativeDomains: ['example-authority.test']
  });
  assert.equal(result.role, 'independent_reporting');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: lookalike domain does not match configured authority', () => {
  const result = classifySourceRole('https://example-authority.test.evil.test/article', {
    authoritativeDomains: ['example-authority.test']
  });
  assert.equal(result.role, 'independent_reporting');
  assert.equal(result.ambiguous, false);
});

test('classifySourceRole: wildcard-like configuration is not treated as a wildcard', () => {
  const result = classifySourceRole('https://news.example-authority.test/article', {
    authoritativeDomains: ['*.example-authority.test']
  });
  assert.equal(result.role, 'independent_reporting');
  assert.equal(result.ambiguous, false);
});

test('production config exposes empty frozen classification lists', async () => {
  const { config } = await import('../../src/config/index.js');

  assert.deepEqual(config.researchClassification.authoritativeDomains, []);
  assert.deepEqual(config.researchClassification.syndicatedDomains, []);
  assert.equal(Object.isFrozen(config.researchClassification), true);
  assert.equal(Object.isFrozen(config.researchClassification.authoritativeDomains), true);
  assert.equal(Object.isFrozen(config.researchClassification.syndicatedDomains), true);
});
