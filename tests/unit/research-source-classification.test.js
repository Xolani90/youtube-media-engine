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