// Policy-pin tests for the child-subject candidate gate (NEW file; additive, no production code change).
// They pin CURRENT, deliberately conservative behaviour so that any vocabulary or rule change is a conscious, reviewed one.
// The gate is a keyword heuristic, not semantic understanding: where a case is a documented limitation it says so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHitScreen, mentionsChildrenAffirmatively } from '../../src/asset-provisioning/candidateGate.js';

const PRO = 'Professional AI training helps staff adopt new laptop based tools at work.';
const hitWith = (tags) => ({ id: 1, pageURL: 'https://pixabay.com/p/1', tags });
const verdict = (scene, query, tags) => buildHitScreen({ sceneText: scene, query })(hitWith(tags));

test('policy pin: child-context words that DO enable child imagery (documented over-enabling: parenting, pupil)', () => {
  // Intentional-by-list, not semantic. "pupil" can mean the eye's pupil, so this is a known FALSE POSITIVE of the gate;
  // it only stops the child-subject rule from rejecting (the duplicate, branded/UI and tag-overlap rules still apply).
  for (const text of ['Parenting tips for new moms.', 'The pupil of the eye reacts to light.', 'Pupils return to school in September.',
    'Preschool and kindergarten programmes expand.', 'A newborn needs frequent feeding.', 'Childcare costs keep rising.']) {
    assert.equal(mentionsChildrenAffirmatively(text), true, text);
    assert.equal(verdict(text, 'tips', 'kid, tips').accept, true, `gate: ${text}`);
  }
});

test('policy pin: parent / family / student / teen / minor / youth are NOT proof that a child should appear', () => {
  for (const text of ['Parents and family support students and teens.', 'Our family and parents attend.', 'Minors and youth programmes are expanding.',
    'Students learn professional AI skills.', 'Teenagers use laptops at school.']) {
    assert.equal(mentionsChildrenAffirmatively(text), false, text);
    assert.deepEqual(verdict(text, 'learning', 'kid, learning'), { accept: false, reason: 'child_subject_tag:kid' }, `gate: ${text}`);
  }
});

test('policy pin: affirmative child wording in EITHER the scene text or the query enables the rule, independently of the other', () => {
  assert.equal(verdict(PRO, 'children learning to read', 'child, learning, reading').accept, true, 'child-focused query, neutral scene');
  assert.equal(verdict('Children learn to read with picture books.', 'books reading', 'child, books, reading').accept, true, 'child-focused scene, neutral query');
  assert.equal(verdict(PRO, 'laptop tools', 'child, laptop, tools').accept, false, 'both neutral');
  // A negated child query does not enable it, and does not cancel an affirmative scene.
  assert.equal(verdict(PRO, 'not for children', 'child, tools').accept, false);
  assert.equal(verdict('Children learn to read.', 'not for children reading', 'child, reading').accept, true);
});

// KNOWN IMPLEMENTATION LIMITATION (pinned, not endorsed as policy): tag words are extracted with /[a-z]+/g, so a hyphen or other
// non-letter splits a tag into words. 'baby-sitter' therefore yields the word 'baby' and is rejected, while 'babysitter' stays one
// word, is not in the child vocabulary and is accepted. The same rule makes 'kid-friendly' match 'kid'. A babysitter image may well
// show a child, so accepting 'babysitter' is a probable false negative. Changing this is a policy decision (widen the vocabulary, or
// match whole comma-separated tags only) and needs its own tests for both directions; these pins exist so such a change is deliberate.
test('policy pin: child words inside multiword / hyphenated / mixed-case tags are matched as whole words; look-alikes are not', () => {
  for (const [tags, word] of [['baby girl, laptop, training', 'baby'], ['happy children playing, training', 'children'], ['newborn baby, training', 'baby'],
    ['kid-friendly, laptop, training', 'kid'], ['laptop, Children, training', 'children'], ['laptop, CHILD care, training', 'child'], ['baby-sitter, training', 'baby']]) {
    assert.deepEqual(verdict(PRO, 'ai training laptop', tags), { accept: false, reason: `child_subject_tag:${word}` }, tags);
  }
  // kidney / childhood / infantry / babysitter are not child words (no suffix stripping).
  for (const tags of ['kidney, laptop, training', 'childhood, laptop, training', 'infantry, laptop, training', 'babysitter, laptop, training']) {
    assert.deepEqual(verdict(PRO, 'ai training laptop', tags), { accept: true, reason: null }, tags);
  }
  // 'newborn' enables context but is not itself a tag that is rejected.
  assert.deepEqual(verdict(PRO, 'ai training laptop', 'newborn, laptop, training'), { accept: true, reason: null });
});

test('policy pin: child context only exempts the child-subject rule; duplicates, branded/UI and no-overlap rejections still win', () => {
  const scene = 'Children learn to read with picture books.';
  assert.equal(buildHitScreen({ sceneText: scene, query: 'books', excludeOrigins: ['https://pixabay.com/p/1'] })(hitWith('child, books')).reason, 'duplicate_of_attached_asset');
  assert.match(buildHitScreen({ sceneText: scene, query: 'books' })(hitWith('child, books, logo')).reason, /^branded_or_ui_capture_tag:logo$/);
  assert.equal(buildHitScreen({ sceneText: scene, query: 'books' })(hitWith('child, volcano')).reason, 'no_tag_overlap_with_scene');
});
