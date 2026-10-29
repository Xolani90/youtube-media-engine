import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForSpeech, splitParagraphs, looksLikeHeading, pauseAfter, assembleNarration,
  resolveKokoroSpeed, resolvePauses, loadLexicon, DEFAULT_PAUSES, DEFAULT_KOKORO_SPEED
} from '../../src/media/kokoroSupport.js';

test('speech text: symbols, units and model names are spoken, not guessed', () => {
  assert.equal(normalizeForSpeech('It does 300 tokens/second, up to 6× faster, saving 94% (about $1.2 million).'),
    'It does 300 tokens per second, up to 6 times faster, saving 94 percent, about 1.2 million dollars.');
  assert.match(normalizeForSpeech('GPT-6.1 Sol uses the API.'), /^G P T 6\.1 Sol uses the A P I\.$/);
  assert.match(normalizeForSpeech('Compare APIs and SDKs.'), /A P Is and S D Ks/);
});

test('speech text: pronounceable words and ordinary words are left alone', () => {
  assert.equal(normalizeForSpeech('NASA and LEGO said it is OK. IT, NOT, WHY stay words.'), 'NASA and LEGO said it is OK. IT, NOT, WHY stay words.');
});

test('speech text: lexicon respells names; a file can extend it', () => {
  assert.match(normalizeForSpeech("Schlotzsky's and Cinnabon"), /Shlots-key's and Sinna-bon/);
  const lex = loadLexicon({ KOKORO_LEXICON_FILE: 'x.json' }, () => ({ Foobar: 'Foo bar' }));
  assert.equal(normalizeForSpeech('Foobar rocks', { lexicon: lex }), 'Foo bar rocks');
  assert.throws(() => loadLexicon({ KOKORO_LEXICON_FILE: 'x.json' }, () => [1]), /JSON object/);
});

test('speech text: dashes and brackets become pauses; URLs and markdown are dropped', () => {
  assert.equal(normalizeForSpeech('The model — fast and cheap (for now) wins.'), 'The model, fast and cheap, for now, wins.');
  assert.equal(normalizeForSpeech('Read **this** https://example.com/x now.'), 'Read this now.');
});

test('paragraphs and headings', () => {
  assert.deepEqual(splitParagraphs('A one.\n\nB two. C three.\n\n\nD four.'), ['A one.', 'B two. C three.', 'D four.']);
  assert.equal(looksLikeHeading('Operational Challenges and Menu Repricing.'), true);
  assert.equal(looksLikeHeading('The franchisee saved time.'), false);
  assert.equal(looksLikeHeading('Is this a heading?'), false);
});

test('pauses: paragraph > heading > question > sentence', () => {
  const p = DEFAULT_PAUSES;
  assert.equal(pauseAfter('Ends the paragraph.', { isLastInParagraph: true }), p.PARAGRAPH);
  assert.equal(pauseAfter('Menu Repricing Time Savings.', { isLastInParagraph: false }), p.HEADING);
  assert.equal(pauseAfter('Does it work?', { isLastInParagraph: false }), p.QUESTION);
  assert.equal(pauseAfter('It works.', { isLastInParagraph: false }), p.SENTENCE);
  assert.ok(p.PARAGRAPH > p.HEADING && p.HEADING > p.QUESTION && p.QUESTION > p.SENTENCE);
});

test('config: speed and pause overrides validate', () => {
  assert.equal(resolveKokoroSpeed({}), DEFAULT_KOKORO_SPEED);
  assert.equal(resolveKokoroSpeed({ KOKORO_SPEED: '1.05' }), 1.05);
  assert.throws(() => resolveKokoroSpeed({ KOKORO_SPEED: '3' }), /between 0.5 and 1.5/);
  assert.equal(resolvePauses({ KOKORO_PAUSE_SENTENCE_MS: '500' }).SENTENCE, 0.5);
  assert.throws(() => resolvePauses({ KOKORO_PAUSE_SENTENCE_MS: '-1' }), /0-5000/);
});

test('assembleNarration: speech text goes to the model, silences separate utterances, tail is padded', async () => {
  const SR = 1000; // tiny rate keeps the arithmetic exact
  const asked = [];
  const streamFor = (paragraph) => {
    asked.push(paragraph);
    const sentences = paragraph.split(/(?<=[.?])\s+/);
    return (async function* () {
      for (const text of sentences) yield { text, audio: { audio: new Float32Array(100).fill(0.5), sampling_rate: SR } };
    }());
  };
  const pauses = { LEAD: 0.1, SENTENCE: 0.3, QUESTION: 0.4, HEADING: 0.6, PARAGRAPH: 0.8, TAIL: 0.5 };
  const { samples, sampleRate } = await assembleNarration({ paragraphs: ['One. Two?', 'Three at 5%.'], streamFor, pauses });
  assert.deepEqual(asked, ['One. Two?', 'Three at 5 percent.']);
  assert.equal(sampleRate, SR);
  // lead 100 + One 100 + .3s 300 + Two? 100 + paragraph 800 + Three 100 + tail 500
  assert.equal(samples.length, 100 + 100 + 300 + 100 + 800 + 100 + 500);
});

test('assembleNarration: no audio is an error; mixed sampling rates are an error', async () => {
  const empty = () => (async function* () {}());
  await assert.rejects(assembleNarration({ paragraphs: ['Hi.'], streamFor: empty }), /no audio/);
  let n = 0;
  const mixed = () => (async function* () {
    yield { text: 'a.', audio: { audio: new Float32Array(10), sampling_rate: 24000 } };
    yield { text: 'b.', audio: { audio: new Float32Array(10), sampling_rate: 16000 } };
    n++;
  }());
  await assert.rejects(assembleNarration({ paragraphs: ['a. b.'], streamFor: mixed }), /inconsistent sampling rate/);
});
