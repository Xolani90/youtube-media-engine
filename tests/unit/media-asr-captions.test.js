import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptionsFromAsr, CaptionWorkerError, textCorrespondence } from '../../src/media/asrCaptions.js';
import { writeSrtFile } from '../../src/media/render.js';
import { trimCaptionTiming } from '../../src/media/shortFormSelection.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DUR = 10;
const seg = (start, end, text) => ({ start, end, text });
const rejects = (segments, dur = DUR, opts) =>
  assert.throws(() => buildCaptionsFromAsr(segments, dur, opts), (e) => e instanceof CaptionWorkerError && e.reason === 'CAPTION_ASR_INVALID');

test('A. valid ASR segments -> ordered captions inside the audio, spoken text preserved', () => {
  const segments = [seg(0.2, 3.1, 'Welcome to the show.'), seg(3.5, 7.0, 'Today we cover captions.'), seg(7.2, 9.8, 'Thanks for watching.')];
  const caps = buildCaptionsFromAsr(segments, DUR);
  assert.equal(caps.length, 3);
  assert.deepEqual(caps.map((c) => c.start_seconds), [0.2, 3.5, 7.2]);
  assert.deepEqual(caps.map((c) => c.duration_seconds), [2.9, 3.5, 2.6]);
  let prevEnd = 0;
  for (const c of caps) {
    assert.ok(c.start_seconds >= prevEnd - 1e-9, 'ordered, non-overlapping');
    const end = c.start_seconds + c.duration_seconds;
    assert.ok(end >= c.start_seconds && end <= DUR + 1e-9, 'end >= start and inside audio');
    prevEnd = end;
  }
  assert.equal(caps.map((c) => c.text).join(' '), 'Welcome to the show. Today we cover captions. Thanks for watching.');
});

test('A. a long segment is split at word boundaries, chunks tile the real segment window exactly', () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen';
  const caps = buildCaptionsFromAsr([seg(1, 9, text)], DUR, { maxLength: 40 });
  assert.ok(caps.length > 1);
  assert.ok(caps.every((c) => c.text.length <= 40));
  assert.equal(caps[0].start_seconds, 1);
  const last = caps.at(-1);
  assert.equal(Math.round((last.start_seconds + last.duration_seconds) * 1000), 9000);
  for (let i = 1; i < caps.length; i++) assert.equal(caps[i].start_seconds, Math.round((caps[i - 1].start_seconds + caps[i - 1].duration_seconds) * 1000) / 1000);
  assert.equal(caps.map((c) => c.text).join(' '), text);
});

test('A. silence between segments stays a gap and blank segments are dropped', () => {
  const caps = buildCaptionsFromAsr([seg(0, 2, 'First.'), seg(2, 4, '   '), seg(6, 8, 'Second.')], DUR);
  assert.equal(caps.length, 2);
  assert.equal(caps[1].start_seconds, 6);
});

test('A. output is deterministic and feeds the existing SRT writer and short-form trim', () => {
  const segments = [seg(0, 2, 'Alpha beta.'), seg(2.5, 6, 'Gamma delta epsilon.')];
  const a = buildCaptionsFromAsr(segments, DUR);
  assert.deepEqual(a, buildCaptionsFromAsr(segments, DUR));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cap-')), 'c.srt');
  writeSrtFile(a, f);
  const srt = fs.readFileSync(f, 'utf8');
  assert.match(srt, /00:00:02,500 --> 00:00:06,000\nGamma delta epsilon\./);
  const trimmed = trimCaptionTiming(a, 4);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[1].start_seconds + trimmed[1].duration_seconds, 4);
});

test('B. negative timestamps rejected', () => rejects([seg(-0.5, 2, 'Hello there.')]));
test('B. end before start rejected', () => rejects([seg(3, 2, 'Hello there.')]));
test('B. start out of order rejected', () => rejects([seg(4, 5, 'Later.'), seg(1, 2, 'Earlier.')]));
test('B. overlapping segments rejected', () => rejects([seg(0, 5, 'One.'), seg(3, 6, 'Two.')]));
test('B. timestamps beyond audio duration rejected', () => rejects([seg(0, 12.5, 'Too long.')]));
test('B. NaN / non-numeric timestamps rejected', () => {
  rejects([seg(NaN, 2, 'x')]);
  rejects([{ start: '0', end: 2, text: 'x' }]);
});
test('B. malformed segments rejected', () => {
  rejects([null]);
  rejects([{ start: 0, end: 1 }]);
  rejects([]);
  rejects(undefined);
});
test('B. text with zero duration rejected; all-blank transcript rejected', () => {
  rejects([seg(2, 2, 'Spoken but no time.')]);
  rejects([seg(0, 1, ' '), seg(1, 2, '')]);
});
test('B. invalid audio duration rejected', () => {
  rejects([seg(0, 1, 'Hi.')], 0);
  rejects([seg(0, 1, 'Hi.')], NaN);
});
test('B. small whisper overshoot past the end is clamped to the audio duration', () => {
  const caps = buildCaptionsFromAsr([seg(8, 10.6, 'Final words.')], DUR);
  assert.equal(caps[0].start_seconds + caps[0].duration_seconds, DUR);
});

test('C. transcript that does not correspond to the narration is rejected', () => {
  const narration = 'This is a short narration script for the test video.';
  assert.throws(() => buildCaptionsFromAsr([seg(0, 3, 'Completely unrelated words here.')], DUR, { narrationText: narration }),
    (e) => e instanceof CaptionWorkerError && e.reason === 'CAPTION_TEXT_MISMATCH');
  const ok = buildCaptionsFromAsr([seg(0, 3, 'This is a short narration script for the test video.')], DUR, { narrationText: narration });
  assert.equal(ok.length, 1);
  assert.ok(textCorrespondence('this is a short narration script', narration) >= 0.6);
  assert.ok(textCorrespondence('minor asr slip: This is a short narration scripts for the test video', narration) >= 0.8);
});

test('D. misheard words: script text is shown, ASR timing is kept', () => {
  const script = 'Welcome to the rehearsal. Rights verified today.';
  const segs = [seg(0.2, 3, 'Welcome to the reversal.'), seg(3.5, 6, 'Right, verified today.')];
  const caps = buildCaptionsFromAsr(segs, DUR, { narrationText: script });
  assert.equal(caps.map((c) => c.text).join(' '), script);
  assert.ok(!caps.some((c) => /reversal/.test(c.text)));
  assert.equal(caps[0].start_seconds, 0.2);
  const last = caps.at(-1);
  assert.equal(Math.round((last.start_seconds + last.duration_seconds) * 1000), 6000);
});

test('E. dropped and added words: captions stay in-window, ordered, non-overlapping', () => {
  const script = 'One two three four five. Six seven eight nine ten.';
  const segs = [seg(0, 2, 'One two three four five extra words added.'), seg(2.5, 5, 'Six seven.')];
  const caps = buildCaptionsFromAsr(segs, DUR, { narrationText: script });
  let prevEnd = 0;
  for (const c of caps) {
    const end = c.start_seconds + c.duration_seconds;
    assert.ok(c.start_seconds >= prevEnd - 1e-9);
    assert.ok((c.start_seconds >= 0 && end <= 2 + 1e-9) || (c.start_seconds >= 2.5 - 1e-9 && end <= 5 + 1e-9));
    prevEnd = end;
  }
  assert.equal(caps.map((c) => c.text).join(' '), script);
});

test('F. silence gaps stay gaps with script text', () => {
  const caps = buildCaptionsFromAsr([seg(0, 2, 'First.'), seg(6, 8, 'Second.')], DUR, { narrationText: 'First. Second.' });
  for (const c of caps) {
    const end = c.start_seconds + c.duration_seconds;
    assert.ok(end <= 2 + 1e-9 || c.start_seconds >= 6 - 1e-9, 'no caption inside the 2-6s silence');
  }
});

test('G. correspondence is judged on whisper output, not the script', () => {
  assert.throws(
    () => buildCaptionsFromAsr([seg(0, 3, 'Completely unrelated words here.')], DUR, { narrationText: 'This is a short narration script for the test video.' }),
    (e) => e instanceof CaptionWorkerError && e.reason === 'CAPTION_TEXT_MISMATCH');
});

test('H. textSource "asr" keeps whisper text', () => {
  const script = 'The rights verified report is ready for review today.';
  const heard = 'The right, verified report is ready for review today.';
  const caps = buildCaptionsFromAsr([seg(0, 3, heard)], DUR, { narrationText: script, textSource: 'asr' });
  assert.equal(caps.map((c) => c.text).join(' '), heard);
});
