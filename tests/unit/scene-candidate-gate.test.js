import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildHitScreen, resolveCandidateGateEnabled, parseTags, mentionsChildrenAffirmatively } from '../../src/asset-provisioning/candidateGate.js';
import { planScenes } from '../../src/asset-provisioning/scenePlan.js';
import { PixabayAssetSourceProvider } from '../../src/providers/asset/PixabayAssetSourceProvider.js';

const NARRATION = 'In person workshops are being established to provide direct guidance for small firms.';

test('gate rejects a branded / UI-capture hit the narration never mentions (the Google-homepage case)', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'workshop' });
  const v = screen({ id: 1, pageURL: 'p1', tags: 'google, chrome, browser, workshop' });
  assert.equal(v.accept, false);
  assert.match(v.reason, /^branded_or_ui_capture_tag:/);
});

test('gate allows a brand tag when the narration itself names it', () => {
  const screen = buildHitScreen({ sceneText: 'Google announced a new Chrome update today.', query: 'google chrome' });
  assert.equal(screen({ id: 1, pageURL: 'p', tags: 'google, chrome, update' }).accept, true);
});

test('gate rejects a hit with tags but no word in common with scene or query; accepts a tagless hit', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'workshop' });
  assert.equal(screen({ id: 2, pageURL: 'p2', tags: 'sunset, beach, ocean' }).reason, 'no_tag_overlap_with_scene');
  assert.equal(screen({ id: 3, pageURL: 'p3', tags: '' }).accept, true);
  assert.equal(screen({ id: 4, pageURL: 'p4', tags: 'workshop, training, people' }).accept, true);
});

test('gate rejects a hit whose page is already attached', () => {
  const screen = buildHitScreen({ sceneText: NARRATION, query: 'workshop', excludeOrigins: ['p9'] });
  assert.equal(screen({ id: 9, pageURL: 'p9', tags: 'workshop' }).reason, 'duplicate_of_attached_asset');
});

test('env switch: default on, off restores, invalid throws', () => {
  assert.equal(resolveCandidateGateEnabled({}), true);
  assert.equal(resolveCandidateGateEnabled({ SCENE_CANDIDATE_GATE: 'off' }), false);
  assert.throws(() => resolveCandidateGateEnabled({ SCENE_CANDIDATE_GATE: 'maybe' }));
  assert.deepEqual(parseTags('A, b ,,C'), ['a', 'b', 'c']);
});

test('planner: scenes expose their text; no-term scenes get anchored, non-junk queries', () => {
  const body = ['Millions of small firm employees lack access to structured training.', 'A programme aims to close that gap soon.',
    'Funding goes to sector specific resources for retail.', 'Employers say cost is the biggest barrier.',
    'Workshops are being established to provide direct guidance.', 'Critics argue the plan relies on voluntary participation.',
    'Early pilots reported higher confidence among participants.', 'However the pilots were small and not independently evaluated.',
    'Officials plan a wider evaluation before expanding the scheme again.', 'The scheme will be reviewed at the end of next year.'].join(' ');
  const plan = planScenes({ visualIdeas: 'small business owner, office', scriptBody: body, fallbackQuery: 'small business owner, office' });
  assert.ok(plan.length >= 2);
  for (const sc of plan) assert.equal(typeof sc.text, 'string');
  const all = plan.flatMap((s) => s.queries);
  for (const junk of ['pilot among', 'again end', 'among', 'again']) assert.ok(!all.includes(junk), `junk query ${junk}`);
});

function fakeFetch(hits) {
  let downloads = 0;
  const impl = async (url) => {
    if (String(url).includes('pixabay.com/api')) return { ok: true, status: 200, json: async () => ({ hits }) };
    downloads++;
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`bytes-${url}`) };
  };
  return { impl, downloads: () => downloads };
}
const hit = (id, tags, extra = {}) => ({ id, tags, pageURL: `https://pixabay.com/p/${id}`, user: 'u', largeImageURL: `https://cdn/${id}.jpg`, ...extra });

test('provider: with a screen it skips rejected hits and downloads exactly one; evidence lands in provenance notes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'google, chrome, browser'), hit(2, 'sunset, beach'), hit(3, 'workshop, training')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: NARRATION, query: 'workshop' }) });
  assert.equal(r.verificationStatus, 'UNVERIFIED'); // rights status is never promoted
  assert.match(r.provenanceNotes, /pixabayId=3/);
  assert.match(r.provenanceNotes, /query=workshop/);
  assert.match(r.provenanceNotes, /screenRejected=1:branded_or_ui_capture_tag:google\|2:no_tag_overlap_with_scene/);
  assert.equal(f.downloads(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: every hit rejected -> structured EMPTY_RESULT (no fabricated asset, no download)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'google, chrome'), hit(2, 'sunset')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: NARRATION, query: 'workshop' }) });
  assert.equal(r.failure.kind, 'EMPTY_RESULT');
  assert.equal(r.failure.hitCount, 2);
  assert.match(r.failure.cause, /no_hit_passed_screen/);
  assert.equal(f.downloads(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: without a screen behaviour is unchanged (hits[0] only, notes carry no search evidence)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'google, chrome'), hit(2, 'workshop')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'] });
  assert.match(r.provenanceNotes, /pixabayId=1/);
  assert.ok(!/query=|screenRejected/.test(r.provenanceNotes));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('provider: a screen that throws fails closed (hit rejected)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, 'workshop')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'workshop', assetTypes: ['image'], screenHit: () => { throw new Error('boom'); } });
  assert.equal(r.failure.kind, 'EMPTY_RESULT');
  fs.rmSync(dir, { recursive: true, force: true });
});

const AI_TRAINING = 'Professional AI training helps staff adopt new laptop based tools at work.';
const OPENAI = 'OpenAI announced a partnership to expand learning tools for people everywhere.';
const KIDS_TAGS = 'baby, child, infant, kid, laptop, learning, people';

test('child gate: regression scenes (AI training, OpenAI partnership) reject child-tagged hits; reason as written', () => {
  const a = buildHitScreen({ sceneText: AI_TRAINING, query: 'ai training laptop' })({ id: 1, pageURL: 'p', tags: KIDS_TAGS });
  assert.equal(a.accept, false);
  assert.match(a.reason, /^child_subject_tag:(baby|child|infant|kid)$/);
  const b = buildHitScreen({ sceneText: OPENAI, query: 'openai learning' })({ id: 2, pageURL: 'p', tags: 'kids, children, laptop, learning' });
  assert.equal(b.reason, 'child_subject_tag:kids');
});

test('child gate: whole words and plurals; kidney / childhood do not match', () => {
  const s = buildHitScreen({ sceneText: AI_TRAINING, query: 'training' });
  assert.equal(s({ id: 1, pageURL: 'p', tags: 'training, kidney, childhood' }).accept, true);
  for (const w of ['babies', 'infants', 'toddlers', 'kids', 'children']) assert.equal(s({ id: 1, pageURL: 'p', tags: `training, ${w}` }).accept, false, w);
});

test('child gate: genuinely child-focused scenes still accept child imagery (narration, query, newborn)', () => {
  const tags = 'children, reading, classroom';
  assert.equal(buildHitScreen({ sceneText: 'Teachers help children who are not yet reading fluently.', query: 'reading' })({ id: 1, pageURL: 'p', tags }).accept, true);
  assert.equal(buildHitScreen({ sceneText: 'Reading skills matter.', query: 'kids with laptop' })({ id: 1, pageURL: 'p', tags: 'kids, laptop' }).accept, true);
  assert.equal(buildHitScreen({ sceneText: 'Toddlers benefit from early reading.', query: 'reading' })({ id: 1, pageURL: 'p', tags: 'toddler, reading' }).accept, true);
  assert.equal(buildHitScreen({ sceneText: 'The newborn sleeps well.', query: 'newborn' })({ id: 1, pageURL: 'p', tags: 'baby, newborn' }).accept, true);
});

test('child gate: negated mentions are not evidence (seven phrasings reject)', () => {
  for (const text of ['This service is not intended for children.', 'The tool is not designed or suitable for children.',
    "The app isn't aimed at kids.", 'Access is offered without children or minors.', 'No toddlers are admitted to the course.',
    'The programme is open to adults, excluding children.', 'It was never meant for babies.']) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
    const v = buildHitScreen({ sceneText: `${text} The service offers online learning.`, query: 'online learning' })({ id: 1, pageURL: 'p', tags: 'children, online, learning' });
    assert.equal(v.accept, false, text);
  }
});

test('child gate: negation is local - other sentence, "not only", "but" boundary do not cancel a real children context', () => {
  assert.equal(mentionsChildrenAffirmatively('Adults are not eligible. Children learn to read here.'), true);
  assert.equal(mentionsChildrenAffirmatively('It is not only for children but also for parents.'), true);
  assert.equal(mentionsChildrenAffirmatively('It is not for adults but for children.'), true);
  assert.equal(mentionsChildrenAffirmatively('Teachers help children who are not yet reading.'), true);
});

test('child gate: negated query does not enable child imagery; affirming query survives unrelated negation', () => {
  assert.equal(buildHitScreen({ sceneText: 'Online learning grows.', query: 'no children learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' }).accept, false);
  assert.equal(buildHitScreen({ sceneText: 'Fees are not published.', query: 'children learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' }).accept, true);
});

test('child gate: known limit - an incidental organisation name counts as a children context', () => {
  assert.equal(mentionsChildrenAffirmatively("The Children's Commissioner announced an AI training grant."), true); // documented heuristic limit
});

test('child gate: existing rules still win; child-tag rule runs before overlap and cannot promote', () => {
  const s = buildHitScreen({ sceneText: AI_TRAINING, query: 'training' });
  assert.match(s({ id: 1, pageURL: 'p', tags: 'google, children, training' }).reason, /^branded_or_ui_capture_tag:/);
  assert.equal(s({ id: 2, pageURL: 'p', tags: 'sunset, beach' }).reason, 'no_tag_overlap_with_scene');
  assert.equal(s({ id: 3, pageURL: 'p', tags: 'training' }).accept, true);
});

test('provider: a rejected child-tagged first hit is skipped and the next passing hit is downloaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, KIDS_TAGS), hit(2, 'training, office, laptop')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'ai training laptop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: AI_TRAINING, query: 'ai training laptop' }) });
  assert.match(r.provenanceNotes, /pixabayId=2/);
  assert.match(r.provenanceNotes, /screenRejected=1:child_subject_tag:/);
  assert.equal(f.downloads(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('child gate: explicit normalisation covers every supported term and plural; no generic suffix stripping', () => {
  const s = buildHitScreen({ sceneText: AI_TRAINING, query: 'training' });
  for (const w of ['baby', 'babies', 'infant', 'infants', 'toddler', 'toddlers', 'kid', 'kids', 'child', 'children']) {
    assert.equal(s({ id: 1, pageURL: 'p', tags: `training, ${w}` }).reason, `child_subject_tag:${w}`, w);
    assert.equal(mentionsChildrenAffirmatively(`Our ${w} programme runs daily.`), true, w);
  }
  // near-misses that a generic "strip trailing s" would have mangled or matched
  for (const w of ['kidney', 'kidneys', 'childhood', 'childish', 'babysit', 'babysitter', 'infantry', 'kiddo', 'childs']) {
    assert.equal(s({ id: 1, pageURL: 'p', tags: `training, ${w}` }).accept, true, w);
    assert.equal(mentionsChildrenAffirmatively(`The ${w} item.`), false, w);
  }
});

test('child gate: child term BEFORE the negation is not affirmative context', () => {
  for (const text of ['Children are not the target audience.', 'Kids are not allowed.', "Toddlers can't attend.",
    'Children were never part of the plan.', 'Babies must not use the service.']) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
    const v = buildHitScreen({ sceneText: `${text} The service offers learning.`, query: 'learning' })({ id: 1, pageURL: 'p', tags: 'children, kids, learning' });
    assert.equal(v.accept, false, text);
  }
});

test('child gate: valid affirmative contexts stay affirmative', () => {
  for (const text of ['Children learn here.', 'It is not only for children.', 'It is not only for children but also for parents.',
    'It is not for adults but for children.', 'Teachers help children who are not yet reading.', 'Kids are learning to code.']) {
    assert.equal(mentionsChildrenAffirmatively(text), true, text);
  }
  assert.equal(buildHitScreen({ sceneText: 'Children learn here.', query: 'learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' }).accept, true);
});

test('child gate: DOCUMENTED LIMIT - teenagers, students, families, parents are not understood semantically', () => {
  // None of these words is a recognised child term, so they do not enable child-tagged imagery.
  for (const text of ['Teenagers use AI tools daily.', 'Students use AI tools daily.', 'Families use AI tools daily.', 'Parents use AI tools daily.']) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
    const v = buildHitScreen({ sceneText: text, query: 'ai tools' })({ id: 1, pageURL: 'p', tags: 'kids, children, ai, tools' });
    assert.equal(v.reason, 'child_subject_tag:kids', text);
  }
  // 'parenting' is a listed context word, so it DOES enable child imagery; 'parents' does not. This asymmetry is intentional-by-list, not semantic.
  assert.equal(mentionsChildrenAffirmatively('Parenting advice for new parents.'), true);
  // Adding an explicit child word restores acceptance.
  assert.equal(buildHitScreen({ sceneText: 'Families teach children to use AI tools.', query: 'ai tools' })({ id: 1, pageURL: 'p', tags: 'children, ai, tools' }).accept, true);
});

test('child gate: never promotes - child context does not rescue duplicate, branded/UI or no-overlap rejections', () => {
  const ctx = { sceneText: 'Children learn to code with laptops.', query: 'children laptop' };
  assert.equal(buildHitScreen({ ...ctx, excludeOrigins: ['dup'] })({ id: 1, pageURL: 'dup', tags: 'children, laptop' }).reason, 'duplicate_of_attached_asset');
  assert.match(buildHitScreen(ctx)({ id: 2, pageURL: 'p', tags: 'children, laptop, logo' }).reason, /^branded_or_ui_capture_tag:logo/);
  assert.equal(buildHitScreen(ctx)({ id: 3, pageURL: 'p', tags: 'sunset, beach' }).reason, 'no_tag_overlap_with_scene');
});

test('child gate: clause-boundary matrix (affirmative vs not)', () => {
  const cases = [
    ['Children are not the target audience.', false],
    ['Kids are not allowed.', false],
    ['Adults are not eligible, but children can participate.', true],
    ['Adults are not eligible. Children can participate.', true],
    ['Adults are not eligible; children can participate.', true],
    ['Adults are not eligible\nChildren can participate.', true],
    ['It is not for adults but for children.', true],
    ['Children are not only welcome but encouraged.', true],
    ['Children who are not yet reading can participate.', true],
    ['The service is not intended for children.', false],
    ['The service is intended for children.', true],
    ['No children are allowed, but parents can attend.', false],
    ['Children can participate. The service is not for adults.', true],
    ['The service is not for adults. Children are not allowed.', false]
  ];
  for (const [text, expected] of cases) assert.equal(mentionsChildrenAffirmatively(text), expected, text);
  // and through the gate: affirmative enables, negated rejects
  const tags = 'children, learning';
  assert.equal(buildHitScreen({ sceneText: 'No children are allowed, but parents can attend.', query: 'learning' })({ id: 1, pageURL: 'p', tags }).accept, false);
  assert.equal(buildHitScreen({ sceneText: 'Adults are not eligible, but children can participate.', query: 'learning' })({ id: 1, pageURL: 'p', tags }).accept, true);
});

test('child gate: DOCUMENTED LIMITS of the negation heuristic', () => {
  // a comma continues a negated LIST of child words ...
  assert.equal(mentionsChildrenAffirmatively('Not intended for children, babies or toddlers.'), false);
  // ... and, by the same rule, a non-child noun list before a verbless child list is still negated
  assert.equal(mentionsChildrenAffirmatively('Not for adults, children or babies.'), false);
  // UNAVOIDABLE AMBIGUITY: same shape as "Without adults, children play here." - read as a new clause (affirmative)
  assert.equal(mentionsChildrenAffirmatively('No adults, children or babies are admitted.'), true);
  // punctuation alone does not decide: the no-comma form reads the same as the comma form (see the punctuation test)
  assert.equal(mentionsChildrenAffirmatively('Without adults children play here.'), true);
  // known false positive of the "can't wait" idiom exception: a literal reading ("Babies can't wait in line") is also affirmative
  assert.equal(mentionsChildrenAffirmatively("Babies can't wait in line."), true);
  // "no longer" is treated as plain negation
  assert.equal(mentionsChildrenAffirmatively('Children are no longer eligible.'), false);
  // 'nursery' (plant nursery) and 'parents' do not enable child imagery
  assert.equal(mentionsChildrenAffirmatively('The plant nursery sells trees to parents.'), false);
});

test('provider: child-rejected first hit is skipped; only the fallback is downloaded; provenance records both', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const urls = [];
  const hits = [hit(1, KIDS_TAGS), hit(2, 'training, office, laptop')];
  const impl = async (url) => {
    if (String(url).includes('pixabay.com/api')) return { ok: true, status: 200, json: async () => ({ hits }) };
    urls.push(String(url));
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`bytes-${url}`) };
  };
  const p = new PixabayAssetSourceProvider({ fetchImpl: impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'ai training laptop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: AI_TRAINING, query: 'ai training laptop' }) });
  assert.deepEqual(urls, ['https://cdn/2.jpg']);
  assert.match(r.provenanceNotes, /pixabayId=2/);
  assert.match(r.provenanceNotes, /screenRejected=1:child_subject_tag:baby(\||$|;|\s)/);
  assert.equal(r.verificationStatus, 'UNVERIFIED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('child gate: SCENE_CANDIDATE_GATE switch behaviour unchanged', () => {
  assert.equal(resolveCandidateGateEnabled({}), true);
  assert.equal(resolveCandidateGateEnabled({ SCENE_CANDIDATE_GATE: '0' }), false);
  assert.throws(() => resolveCandidateGateEnabled({ SCENE_CANDIDATE_GATE: 'x' }), /SCENE_CANDIDATE_GATE/);
});

test('child gate: comma/clause regression - "Without adults, children play here." and similar are affirmative', () => {
  for (const text of ['Without adults, children play here.', 'Without supervision, kids play here.', 'Excluding adults, children participate.',
    'Except on Sundays, children can attend.', 'Without adults (children play) here.', 'Without adults - children play here.',
    'Without adults\u2014children play here.', 'Without adults,\nchildren play here.', 'Not intended for adults; children play here.',
    'Never mind the adults, children learn here.', 'Children, not adults, can participate.']) {
    assert.equal(mentionsChildrenAffirmatively(text), true, text);
  }
  assert.equal(buildHitScreen({ sceneText: 'Without adults, children play here.', query: 'playground' })({ id: 1, pageURL: 'p', tags: 'children, playground' }).accept, true);
});

test('child gate: the six required existing cases are unchanged', () => {
  const cases = [['The service is not intended for children.', false], ['Children are not the target audience.', false],
    ['Adults are not eligible, but children can participate.', true], ['It is not for adults but for children.', true],
    ['Children who are not yet reading can participate.', true], ['Not intended for children, babies or toddlers.', false]];
  for (const [text, expected] of cases) assert.equal(mentionsChildrenAffirmatively(text), expected, text);
});

test('child gate: negated lists stay negated across commas, parentheses, dashes and contractions', () => {
  for (const text of ['Not intended for children, babies or toddlers.', 'Not for adults, children, or babies.', 'No children, babies or toddlers are admitted.',
    'Not for adults, children or babies.', 'Not intended for children (babies or toddlers).', "Children aren't allowed, but parents can attend.",
    "Toddlers can\u2019t attend, nor can babies.", 'Without children - babies or toddlers.']) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
  }
});

test('child gate: sentence boundaries - semicolon, colon, newline, CRLF and full stop all reset negation', () => {
  for (const sep of [';', ':', '\n', '\r\n', '. ', '! ', '? ']) {
    assert.equal(mentionsChildrenAffirmatively(`Adults are not eligible${sep}children can participate.`), true, JSON.stringify(sep));
  }
});

test('child gate: CONTRADICTORY scene text - any affirmative child mention enables child imagery (chosen, documented)', () => {
  // The gate can only reject, so "any affirmative mention wins" errs toward NOT discarding a hit for a scene that does
  // call for children somewhere; the other rules (duplicate, branded/UI, tag overlap) still apply in full.
  assert.equal(mentionsChildrenAffirmatively('Children are not allowed. Children learn here.'), true);
  assert.equal(mentionsChildrenAffirmatively('Not intended for children. Kids love it anyway.'), true);
  const tags = 'children, learning';
  assert.equal(buildHitScreen({ sceneText: 'Children are not allowed. Children learn here.', query: 'learning' })({ id: 1, pageURL: 'p', tags }).accept, true);
  // affirmative in the query alone also wins over a negated narration
  assert.equal(buildHitScreen({ sceneText: 'Not intended for children.', query: 'children learning' })({ id: 1, pageURL: 'p', tags }).accept, true);
  // all-negated stays rejected
  assert.equal(buildHitScreen({ sceneText: 'Not intended for children. Kids are not allowed.', query: 'learning' })({ id: 1, pageURL: 'p', tags }).accept, false);
  // and the winning mention cannot rescue other rejection rules
  assert.equal(buildHitScreen({ sceneText: 'Children are not allowed. Children learn here.', query: 'learning', excludeOrigins: ['dup'] })({ id: 2, pageURL: 'dup', tags }).reason, 'duplicate_of_attached_asset');
});

test('child gate: punctuation never decides - \"without adults\" with and without a comma are both affirmative', () => {
  const pair = ['Without adults, children play here.', 'Without adults children play here.'];
  for (const text of pair) {
    assert.equal(mentionsChildrenAffirmatively(text), true, text);
    // gate decision: child-tagged hit ACCEPTED (child imagery enabled); the same hit is REJECTED for a neutral scene
    const accept = buildHitScreen({ sceneText: text, query: 'playground' })({ id: 1, pageURL: 'p', tags: 'children, playground' });
    assert.equal(accept.accept, true, text);
  }
  const neutral = buildHitScreen({ sceneText: 'Playgrounds are open daily.', query: 'playground' })({ id: 1, pageURL: 'p', tags: 'children, playground' });
  assert.equal(neutral.accept, false);
  assert.equal(neutral.reason, 'child_subject_tag:children');
  // same family: more governed words, other prepositional negators, and a negator AFTER the child word
  for (const text of ['Without any adults children play here.', 'Without supervision kids play here.', 'Except on Sundays children can attend.',
    'Excluding staff children participate.', 'No adults children or babies are admitted.', 'Children without adults play here.']) {
    assert.equal(mentionsChildrenAffirmatively(text), true, text);
  }
});

test('child gate: prepositional negators still negate a child word they directly govern', () => {
  for (const text of ['Without children, babies or toddlers.', 'Without children.', 'Without any children.', 'Without the children babies or toddlers.',
    'Except for children.', 'Excluding all young children.', 'No young children are allowed.', 'Children no longer eligible.']) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
    const v = buildHitScreen({ sceneText: `${text} The service offers learning.`, query: 'learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' });
    assert.equal(v.accept, false, text);
  }
});

test('child gate: required ten-case matrix (single source of truth for the final policy)', () => {
  const cases = [['The service is not intended for children.', false], ['Children are not the target audience.', false],
    ['Not intended for children, babies or toddlers.', false], ['Not for adults, children or babies.', false],
    ['Adults are not eligible, but children can participate.', true], ['It is not for adults but for children.', true],
    ['Children who are not yet reading can participate.', true], ['Without adults, children play here.', true],
    ['Without adults children play here.', true], ['Without children, babies or toddlers.', false]];
  for (const [text, expected] of cases) {
    assert.equal(mentionsChildrenAffirmatively(text), expected, text);
    const v = buildHitScreen({ sceneText: text, query: 'learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' });
    assert.equal(v.accept, expected, `gate: ${text}`);
  }
});

test("child gate: \"can't wait\" idiom is affirmative; other [auxiliary] + negator after a child word stays negated", () => {
  const yes = ["Without adults, children can't wait.", "Children can't wait for the school trip.", 'Kids cannot wait for summer.',
    'Toddlers could not wait to start.', "Without adults children can\u2019t wait.", "Children can't wait. Adults are not eligible."];
  for (const text of yes) {
    assert.equal(mentionsChildrenAffirmatively(text), true, text);
    assert.equal(buildHitScreen({ sceneText: text, query: 'learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' }).accept, true, `gate: ${text}`);
  }
  const no = ["Toddlers can't attend.", 'Babies must not use the service.', "Children can't enter.", 'Kids cannot attend.', 'Children are not the target audience.',
    'Kids are not allowed.', 'The service is not intended for children.', 'No children are allowed, but parents can attend.', 'Without children, babies or toddlers.'];
  for (const text of no) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
    assert.equal(buildHitScreen({ sceneText: text, query: 'learning' })({ id: 1, pageURL: 'p', tags: 'children, learning' }).accept, false, `gate: ${text}`);
  }
});

test('child gate: full required matrix through both mentionsChildrenAffirmatively() and buildHitScreen()', () => {
  const matrix = [
    ['The service is not intended for children.', false], ['Children are not the target audience.', false], ['Kids are not allowed.', false],
    ["Toddlers can't attend.", false], ['Babies must not use the service.', false], ['No children are allowed, but parents can attend.', false],
    ['Without children, babies or toddlers.', false],
    ['Adults are not eligible, but children can participate.', true], ['It is not for adults but for children.', true],
    ['Children who are not yet reading can participate.', true], ['Without adults, children play here.', true], ['Without adults children play here.', true],
    ["Without adults, children can't wait.", true], ["Children can't wait for the school trip.", true]
  ];
  for (const [text, expected] of matrix) {
    assert.equal(mentionsChildrenAffirmatively(text), expected, text);
    assert.equal(buildHitScreen({ sceneText: text, query: 'learning' })({ id: 1, pageURL: 'p', tags: 'kids, learning' }).accept, expected, `gate: ${text}`);
  }
});

test('child gate: neutral AI-training / OpenAI scenes reject every child-tag variant; child-focused scenes accept them', () => {
  for (const scene of [AI_TRAINING, OPENAI]) {
    const screen = buildHitScreen({ sceneText: scene, query: 'learning tools' });
    assert.equal(mentionsChildrenAffirmatively(scene), false);
    for (const tag of ['baby', 'infant', 'toddler', 'kid', 'child', 'babies', 'kids', 'children']) {
      assert.equal(screen({ id: 1, pageURL: 'p', tags: `learning, tools, ${tag}` }).accept, false, tag);
    }
  }
  const focused = buildHitScreen({ sceneText: 'Children learn to read with simple tools.', query: 'learning tools' });
  for (const tag of ['kid', 'children', 'baby']) assert.equal(focused({ id: 1, pageURL: 'p', tags: `learning, tools, ${tag}` }).accept, true, tag);
});

test('child gate: provider records rejection provenance for several rejected hits and downloads only the accepted candidate', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  const f = fakeFetch([hit(1, KIDS_TAGS), hit(2, 'training, kids, laptop'), hit(3, 'training, office, laptop')]);
  const p = new PixabayAssetSourceProvider({ fetchImpl: f.impl, apiKeyProvider: () => 'k', downloadDir: dir });
  const r = await p.acquireVisualAsset({ query: 'ai training laptop', assetTypes: ['image'], screenHit: buildHitScreen({ sceneText: AI_TRAINING, query: 'ai training laptop' }) });
  assert.match(r.provenanceNotes, /pixabayId=3/);
  assert.match(r.provenanceNotes, /screenRejected=1:child_subject_tag:\w+\|2:child_subject_tag:kids/);
  assert.equal(f.downloads(), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
