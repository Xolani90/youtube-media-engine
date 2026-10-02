import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveClaimIdentity, resolvePublicationYear, summarizeIdentityCoverage, normalizeClaimIdentity, MAX_PUBLICATION_GAP_MONTHS
} from '../../src/research/claimIdentity.js';

// Publication-date year grounding. A month-only claim ("... in March.") may
// have its year vouched for by a TRUSTED publication date, and only that: the
// only check this can satisfy is `time_year_not_grounded`. Every rule fails
// closed.

const ident = (over = {}) => ({
  subject: 'Acme', predicate: 'release', object: 'Widget', qualifiers: [], time: '2026-03',
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});
const derive = (claim, identity, context) => deriveClaimIdentity({ claim, claim_type: 'FACT', is_load_bearing: true, identity }, context);
const MONTH_ONLY = 'Acme released Widget in March.';
const TAVILY = { providerId: 'tavily', publishedAt: '2026-05-12' };
const NOT_GROUNDED = 'time_year_not_grounded';

test('safe Tavily case: trusted ISO publication date grounds a month-only claim, and the fingerprint equals the explicit-year claim', () => {
  const r = derive(MONTH_ONLY, ident(), TAVILY);
  assert.equal(r.reason, null);
  assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  // Identical structure => identical fingerprint to the explicit-year wording.
  assert.equal(r.fingerprint, derive('Acme released Widget in March 2026.', ident()).fingerprint);
  // ISO datetime with a zone is accepted too; ANNOUNCED counts as past modality.
  assert.ok(derive('Acme announced Widget in March.', ident({ predicate: 'announce', modality: 'ANNOUNCED' }), { providerId: 'tavily', publishedAt: '2026-05-12T09:30:00Z' }).fingerprint);
});

test('safe Google News RSS case: RFC-822 pubDate grounds a month-only claim', () => {
  const r = derive(MONTH_ONLY, ident(), { providerId: 'google-news-rss', publishedAt: 'Tue, 12 May 2026 08:30:00 GMT' });
  assert.equal(r.reason, null);
  assert.ok(r.fingerprint);
});

test('production composite id (tavily primary, duckduckgo fallback) is trusted; a composite containing gdelt is not', () => {
  assert.ok(derive(MONTH_ONLY, ident(), { ...TAVILY, providerId: 'tavily+duckduckgo-fallback' }).fingerprint);
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, providerId: 'tavily+gdelt-fallback' }).reason, NOT_GROUNDED);
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, providerId: 'duckduckgo' }).reason, NOT_GROUNDED, 'a dateless provider alone is not a date source');
});

test('GDELT seendate is never trusted, whatever its shape', () => {
  for (const publishedAt of ['20260512T083000Z', '2026-05-12', 'Tue, 12 May 2026 08:30:00 GMT']) {
    const r = derive(MONTH_ONLY, ident(), { providerId: 'gdelt', publishedAt });
    assert.equal(r.fingerprint, null);
    assert.equal(r.reason, NOT_GROUNDED);
  }
  assert.equal(derive(MONTH_ONLY, ident(), { providerId: undefined, publishedAt: '2026-05-12' }).reason, NOT_GROUNDED, 'unknown provider');
});

test('same-month publication is rejected; so is a publication month before the claimed month', () => {
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, publishedAt: '2026-03-20' }).reason, NOT_GROUNDED);
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, publishedAt: '2026-02-20' }).reason, NOT_GROUNDED);
});

test('gap limit: 3 months later is the most that is accepted; 4 months is rejected', () => {
  assert.equal(MAX_PUBLICATION_GAP_MONTHS, 3);
  assert.ok(derive(MONTH_ONLY, ident(), { ...TAVILY, publishedAt: '2026-06-30' }).fingerprint, '3 months');
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, publishedAt: '2026-07-01' }).reason, NOT_GROUNDED, '4 months');
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, publishedAt: '2026-12-01' }).reason, NOT_GROUNDED, '9 months');
});

test('publication in a different calendar year is rejected, even when the month arithmetic would fit', () => {
  const dec = ident({ time: '2025-12' });
  assert.equal(derive('Acme released Widget in December.', dec, { ...TAVILY, publishedAt: '2026-01-15' }).reason, NOT_GROUNDED);
});

test('relative or scoping wording is rejected', () => {
  const cases = [
    'Acme released Widget in March last year.', 'Acme released Widget last March.', 'Acme released Widget in March this year.',
    'Acme has released Widget since March.', 'Acme released Widget by March.', 'Acme released Widget in March, months ago.',
    'Acme released Widget in the annual March event.', 'Acme released Widget in March next year.', 'Acme released Widget every March.',
    'Acme released Widget in early March.', 'Acme released Widget until March.', 'Acme released Widget in March of the previous year.'
  ];
  for (const claim of cases) assert.equal(derive(claim, ident(), TAVILY).reason, NOT_GROUNDED, claim);
});

test('claim must name exactly one month and no year', () => {
  assert.equal(derive('Acme released Widget in March and April.', ident(), TAVILY).reason, 'month_not_accounted');
  assert.equal(derive('Acme released Widget in Mar.', ident(), TAVILY).reason, 'month_not_accounted', 'abbreviation is not accepted');
  // Resolver-level: the unique-month rule itself.
  const t = normalizeClaimIdentity(ident()).timeParts;
  assert.equal(resolvePublicationYear('Acme released Widget in March or April.', ident(), t, TAVILY).reason, 'claimed_month_not_unique');
  assert.equal(resolvePublicationYear('Acme released Widget.', ident(), t, TAVILY).reason, 'claimed_month_not_unique');
  assert.equal(resolvePublicationYear('Acme released Widget in March 2026.', ident(), t, TAVILY).reason, 'claim_names_year');
  // "may" is never resolved: modal verb or an unprovable month.
  assert.equal(derive('Acme may release Widget in May.', ident({ time: '2026-05', modality: 'ANNOUNCED' }), { ...TAVILY, publishedAt: '2026-07-01' }).reason, NOT_GROUNDED);
});

test('planned / possible / estimated modality is rejected; only OCCURRED and ANNOUNCED resolve', () => {
  for (const modality of ['PLANNED', 'POSSIBLE', 'ESTIMATED']) {
    const r = derive('Acme plans to release Widget in March.', ident({ modality }), TAVILY);
    assert.equal(r.reason, NOT_GROUNDED, modality);
  }
  const t = normalizeClaimIdentity(ident()).timeParts;
  assert.equal(resolvePublicationYear(MONTH_ONLY, ident({ modality: 'PLANNED' }), t, TAVILY).reason, 'modality_not_past');
});

test('missing or unparseable publication date is rejected', () => {
  for (const context of [null, undefined, {}, { providerId: 'tavily' }, { providerId: 'tavily', publishedAt: null },
    { providerId: 'tavily', publishedAt: '' }, { providerId: 'tavily', publishedAt: 'May 12 2026' },
    { providerId: 'tavily', publishedAt: '12/05/2026' }, { providerId: 'tavily', publishedAt: '2026-13-01' },
    { providerId: 'tavily', publishedAt: '2026-02-30' }, { providerId: 'tavily', publishedAt: 'Tue, 12 May 2026 08:30:00 EST' }]) {
    const r = derive(MONTH_ONLY, ident(), context);
    assert.equal(r.fingerprint, null, JSON.stringify(context));
    assert.equal(r.reason, NOT_GROUNDED, JSON.stringify(context));
  }
});

test('a timestamp whose zone offset moves it into another month is ambiguous and rejected', () => {
  // 2026-06-01 00:30 at +05:00 is 2026-05-31 in UTC.
  assert.equal(derive(MONTH_ONLY, ident(), { ...TAVILY, publishedAt: '2026-06-01T00:30:00+05:00' }).reason, NOT_GROUNDED);
});

test('proposed year that disagrees with the resolved publication year fails closed', () => {
  assert.equal(derive(MONTH_ONLY, ident({ time: '2025-03' }), TAVILY).reason, NOT_GROUNDED);
  assert.equal(derive(MONTH_ONLY, ident({ time: '2027-03' }), TAVILY).reason, NOT_GROUNDED);
});

test('identity time must itself be month-level and agree with the claimed month', () => {
  assert.equal(derive(MONTH_ONLY, ident({ time: '2026-Q1' }), TAVILY).reason, 'month_not_accounted');
  const t = normalizeClaimIdentity(ident({ time: '2026-04' })).timeParts;
  assert.equal(resolvePublicationYear(MONTH_ONLY, ident({ time: '2026-04' }), t, TAVILY).reason, 'claimed_month_mismatch');
});

test('explicit-year behavior is unchanged, with and without context', () => {
  const explicit = 'Acme released Widget in March 2026.';
  const base = derive(explicit, ident());
  assert.ok(base.fingerprint);
  // A context (trusted or not) neither adds nor removes anything for an explicit-year claim.
  for (const context of [TAVILY, { providerId: 'gdelt', publishedAt: '20260512T083000Z' }, null]) {
    assert.deepEqual(derive(explicit, ident(), context), base);
  }
  // An explicit year that disagrees with the proposed year is NOT rescued by a trusted date.
  const wrong = derive('Acme released Widget in March 2025.', ident(), TAVILY);
  assert.equal(wrong.fingerprint, null);
  // The pre-existing number veto (2025 is not the structured 2026) fires before
  // the grounding check; identical with and without context.
  assert.equal(wrong.reason, 'number_not_accounted');
  assert.equal(derive('Acme released Widget in March 2025.', ident()).reason, 'number_not_accounted');
  // No context, no year in text: exactly the old fail-closed result.
  const old = derive(MONTH_ONLY, ident());
  assert.equal(old.fingerprint, null);
  assert.equal(old.reason, NOT_GROUNDED);
  assert.equal(deriveClaimIdentity({ claim: MONTH_ONLY, claim_type: 'FACT', is_load_bearing: true, identity: ident() }).reason, NOT_GROUNDED);
});

test('the resolver only satisfies the year check: other vetoes and non-FACT claims are unaffected', () => {
  assert.equal(derive('Acme did not release Widget in March.', ident(), TAVILY).reason, 'polarity_text_mismatch');
  assert.equal(derive('Acme released Gadget in March.', ident(), TAVILY).reason, 'object_not_grounded');
  assert.equal(deriveClaimIdentity({ claim: MONTH_ONLY, claim_type: 'OPINION', identity: ident() }, TAVILY).reason, 'not_a_fact_claim');
});

test('summarizeIdentityCoverage honours the same optional context and is unchanged without it', () => {
  const claims = [{ claim: MONTH_ONLY, claim_type: 'FACT', is_load_bearing: true, identity: ident() }];
  assert.equal(summarizeIdentityCoverage(claims).fingerprinted, 0);
  assert.equal(summarizeIdentityCoverage(claims, TAVILY).fingerprinted, 1);
  assert.equal(summarizeIdentityCoverage(claims, { providerId: 'gdelt', publishedAt: '2026-05-12' }).inconsistent, 1);
});