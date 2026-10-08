import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  MUSIC_MIX_DEFAULTS, AudioMixError, buildMusicMixFilter, resolveMixParams, resolveMusicMixEnabled,
  selectMusicAsset, probeMusicFile
} from '../../src/media/audioMix.js';
import { muxNarration, LOUDNORM_TARGETS, LOUDNORM_OUTPUT_SAMPLE_RATE } from '../../src/media/render.js';
import { buildRenderSpec, renderSpecChecksum } from '../../src/media/renderSpec.js';
import {
  NARRATION_HZ, MUSIC_HZ, writeBurstNarrationWav, writeMusicWav, writeSilentVideo, decodeMono, toneLevelDb, measureIntegratedLufs
} from '../helpers/audioSignals.js';

// Audio ducking / background music: pure configuration + REAL FFmpeg signal measurements.
// Narration is a 1 kHz burst, music a continuous 220 Hz tone, so each one's level inside the
// mixed output is measured by frequency (Goertzel) -- not inferred from the command line.

const DUR = 8;
const BURSTS = [[1, 3.5], [5.5, 7.5]];
const SPEECH = [1.5, 3.0];
const GAP = [4.4, 5.3];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-mix-'));
  const f = { dir, narration: path.join(dir, 'n.wav'), music: path.join(dir, 'm.wav'), video: path.join(dir, 'v.mp4') };
  writeBurstNarrationWav(f.narration, { duration: DUR, bursts: BURSTS });
  writeMusicWav(f.music, { duration: 3 }); // shorter than narration: must loop
  writeSilentVideo(f.video, { duration: DUR });
  f.render = (name, { params, normalizeLoudness = false, music = true } = {}) => {
    const out = path.join(dir, `${name}.mp4`);
    muxNarration({
      silentVideoPath: f.video, narrationPath: f.narration, audioEncoder: 'aac', outputPath: out, normalizeLoudness,
      music: music ? { path: f.music, narrationDurationSeconds: DUR, params } : null
    });
    return out;
  };
  f.cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  return f;
}
const level = (file, hz, [a, b]) => toneLevelDb(decodeMono(file), hz, a, b);
const ffprobeAudio = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file]).toString()).streams.find((s) => s.codec_type === 'audio');

test('A. narration-only regression: no music -> the original path (mono narration kept, aac, 48 kHz with loudnorm) and an unchanged render_spec shape', () => {
  const f = fixture();
  try {
    const out = f.render('plain', { music: false, normalizeLoudness: true });
    const a = ffprobeAudio(out);
    assert.equal(a.codec_name, 'aac');
    assert.equal(a.channels, 1, 'narration-only output keeps its original channel layout');
    assert.equal(Number(a.sample_rate), LOUDNORM_OUTPUT_SAMPLE_RATE);
    const spec = buildRenderSpec({ contentVersion: { id: 'cv' }, narrationPath: 'n.wav', narrationDurationSeconds: 1, visualTiming: [] });
    assert.ok(!('music' in spec), 'no music key unless music is mixed');
    // byte-identical to a spec built without the new argument at all
    const same = buildRenderSpec({ contentVersion: { id: 'cv' }, narrationPath: 'n.wav', narrationDurationSeconds: 1, visualTiming: [], music: null });
    assert.equal(renderSpecChecksum(spec).checksum, renderSpecChecksum(same).checksum);
  } finally { f.cleanup(); }
});

test('B/E. music + narration: both are present in the mix and narration is the dominant signal during speech', () => {
  const f = fixture();
  try {
    const out = f.render('mix');
    const a = ffprobeAudio(out);
    assert.equal(a.codec_name, 'aac');
    const dec = decodeMono(out);
    assert.ok(Math.abs(dec.samples.length / dec.rate - DUR) < 0.3, 'mix is bounded to the narration duration even though the music file is shorter');
    const narSpeech = toneLevelDb(dec, NARRATION_HZ, ...SPEECH);
    const musSpeech = toneLevelDb(dec, MUSIC_HZ, ...SPEECH);
    const musGap = toneLevelDb(dec, MUSIC_HZ, ...GAP);
    const narGap = toneLevelDb(dec, NARRATION_HZ, ...GAP);
    assert.ok(narSpeech > -20, `narration present (${narSpeech.toFixed(1)} dB)`);
    assert.ok(musGap > -45, `music present in the gap (${musGap.toFixed(1)} dB)`);
    assert.ok(narGap < narSpeech - 40, 'narration is absent in the gap');
    assert.ok(narSpeech - musSpeech >= 25, `narration dominates music during speech by >= 25 dB (got ${(narSpeech - musSpeech).toFixed(1)})`);
    // the music loops past its 3 s length (still present at the 7 s mark, in the second burst's gap region)
    assert.ok(toneLevelDb(dec, MUSIC_HZ, 4.4, 5.3) > -45 && toneLevelDb(dec, MUSIC_HZ, 7.7, 7.9) > -60, 'looped music continues to the end');
  } finally { f.cleanup(); }
});

test('C/F. ducking is real: music is attenuated during narration relative to a no-ducking mix, and recovers in the gap', () => {
  const f = fixture();
  try {
    const ducked = decodeMono(f.render('duck'));
    const flat = decodeMono(f.render('flat', { params: { ratio: 1 } })); // ratio 1 = no compression: identical graph, no ducking
    const musSpeechDucked = toneLevelDb(ducked, MUSIC_HZ, ...SPEECH);
    const musSpeechFlat = toneLevelDb(flat, MUSIC_HZ, ...SPEECH);
    const depth = musSpeechFlat - musSpeechDucked;
    assert.ok(depth >= 15, `music is >= 15 dB lower under narration than without ducking (got ${depth.toFixed(1)} dB)`);
    // the narration itself is not touched by ducking
    assert.ok(Math.abs(toneLevelDb(ducked, NARRATION_HZ, ...SPEECH) - toneLevelDb(flat, NARRATION_HZ, ...SPEECH)) < 1);
    // gap recovery: back to (within 3 dB of) the un-ducked level once narration stops
    const gapDucked = toneLevelDb(ducked, MUSIC_HZ, ...GAP);
    const gapFlat = toneLevelDb(flat, MUSIC_HZ, ...GAP);
    assert.ok(Math.abs(gapDucked - gapFlat) < 3, `music recovers in the gap (ducked ${gapDucked.toFixed(1)} vs flat ${gapFlat.toFixed(1)})`);
    assert.ok(gapDucked - musSpeechDucked >= 15, 'music is clearly louder in the gap than under speech in the same render');
    // no abrupt jump: the level 50 ms after a burst ends is not already at full recovery (release is gradual, not a step)
    const justAfter = toneLevelDb(ducked, MUSIC_HZ, 3.55, 3.65);
    assert.ok(justAfter < gapDucked - 3, 'release is gradual rather than an instantaneous jump');
  } finally { f.cleanup(); }
});

test('C. the filter graph configures sidechain ducking keyed by the narration, with the configured attack/release, ahead of the existing loudnorm', () => {
  const g = buildMusicMixFilter({ params: {}, narrationDurationSeconds: 8, sampleRate: 48000, loudnorm: LOUDNORM_TARGETS });
  assert.match(g, /\[1:a\][^;]*asplit=2\[nar\]\[key\]/, 'narration (input 1) is split into program + sidechain key');
  assert.match(g, /\[2:a\]/, 'music is input 2');
  assert.match(g, new RegExp(`\\[mus\\]\\[key\\]sidechaincompress=threshold=${MUSIC_MIX_DEFAULTS.threshold}:ratio=${MUSIC_MIX_DEFAULTS.ratio}:attack=${MUSIC_MIX_DEFAULTS.attack_ms}:release=${MUSIC_MIX_DEFAULTS.release_ms}`));
  assert.ok(g.indexOf('amix') < g.indexOf('loudnorm'), 'loudnorm is applied AFTER the mix');
  assert.match(g, /loudnorm=I=-16:TP=-1.5:LRA=11\[aout\]$/);
});

test('D. deterministic: identical inputs -> identical graph; any parameter change -> a different graph', () => {
  const a = buildMusicMixFilter({ params: {}, narrationDurationSeconds: 8.123456, sampleRate: 48000, loudnorm: LOUDNORM_TARGETS });
  const b = buildMusicMixFilter({ params: {}, narrationDurationSeconds: 8.123456, sampleRate: 48000, loudnorm: LOUDNORM_TARGETS });
  assert.equal(a, b);
  assert.notEqual(a, buildMusicMixFilter({ params: { ratio: 6 }, narrationDurationSeconds: 8.123456, sampleRate: 48000, loudnorm: LOUDNORM_TARGETS }));
  assert.notEqual(a, buildMusicMixFilter({ params: {}, narrationDurationSeconds: 9, sampleRate: 48000, loudnorm: LOUDNORM_TARGETS }));
  assert.deepEqual(resolveMixParams(), { ...MUSIC_MIX_DEFAULTS });
  assert.ok(Object.isFrozen(MUSIC_MIX_DEFAULTS));
  // two real renders of the same inputs are sample-identical
  const f = fixture();
  try {
    const x = decodeMono(f.render('r1')); const y = decodeMono(f.render('r2'));
    assert.equal(x.samples.length, y.samples.length);
    assert.ok(x.samples.every((v, i) => v === y.samples[i]), 'same inputs -> same decoded samples');
  } finally { f.cleanup(); }
});

test('G. invalid input is rejected with AudioMixError: bad parameters, bad duration, bad sample rate, bad MUSIC_DUCKING value, non-audio / corrupt / missing music files', () => {
  const base = { narrationDurationSeconds: 8, sampleRate: 48000, loudnorm: LOUDNORM_TARGETS };
  for (const bad of [{ ratio: 0 }, { ratio: 99 }, { threshold: 0 }, { attack_ms: -1 }, { release_ms: NaN }, { music_gain_db: 6 }, { makeup: '2' }, { fade_in_seconds: -1 }]) {
    assert.throws(() => buildMusicMixFilter({ ...base, params: bad }), (e) => e instanceof AudioMixError && e.reason === 'PARAMS_INVALID', JSON.stringify(bad));
  }
  for (const d of [0, -1, NaN, Infinity, '8']) {
    assert.throws(() => buildMusicMixFilter({ ...base, params: {}, narrationDurationSeconds: d }), (e) => e instanceof AudioMixError && e.reason === 'DURATION_INVALID');
  }
  assert.throws(() => buildMusicMixFilter({ ...base, params: {}, sampleRate: 0 }), AudioMixError);
  assert.throws(() => resolveMusicMixEnabled({ MUSIC_DUCKING: 'maybe' }), (e) => e instanceof AudioMixError && e.reason === 'CONFIG_INVALID');
  assert.equal(resolveMusicMixEnabled({}), true);
  assert.equal(resolveMusicMixEnabled({ MUSIC_DUCKING: 'off' }), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-bad-'));
  try {
    const text = path.join(dir, 'not-audio.wav'); fs.writeFileSync(text, 'this is not audio');
    const empty = path.join(dir, 'empty.wav'); fs.writeFileSync(empty, '');
    const noAudio = path.join(dir, 'video-only.mp4'); writeSilentVideo(noAudio, { duration: 1 });
    for (const p of [text, empty, noAudio, path.join(dir, 'missing.wav')]) {
      assert.throws(() => probeMusicFile(p), (e) => e instanceof AudioMixError && e.reason === 'MUSIC_INVALID', p);
    }
    const ok = path.join(dir, 'ok.wav'); writeMusicWav(ok, { duration: 1 });
    assert.ok(probeMusicFile(ok).duration_seconds > 0.9);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('selectMusicAsset: only attached assets of type music, lowest id first; never chooses anything else', () => {
  assert.equal(selectMusicAsset([]), null);
  assert.equal(selectMusicAsset(null), null);
  assert.equal(selectMusicAsset([{ id: 'a', asset_type: 'image' }, { id: 'b', asset_type: 'video_clip' }]), null);
  assert.equal(selectMusicAsset([{ id: 'z', asset_type: 'music' }, { id: 'c', asset_type: 'image' }, { id: 'm', asset_type: 'music' }]).id, 'm');
});

test('I. EBU R128 normalization stays active on the mix: the same quiet inputs land near -16 LUFS with loudnorm and far below without it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-lufs-'));
  try {
    const n = path.join(dir, 'n.wav'); const m = path.join(dir, 'm.wav'); const v = path.join(dir, 'v.mp4');
    writeBurstNarrationWav(n, { duration: DUR, bursts: [[0.5, 7.5]], amplitude: 0.03 }); // quiet on purpose
    writeMusicWav(m, { duration: DUR, amplitude: 0.03 });
    writeSilentVideo(v, { duration: DUR });
    const render = (name, normalizeLoudness) => {
      const out = path.join(dir, `${name}.mp4`);
      muxNarration({ silentVideoPath: v, narrationPath: n, audioEncoder: 'aac', outputPath: out, normalizeLoudness, music: { path: m, narrationDurationSeconds: DUR } });
      return measureIntegratedLufs(out);
    };
    const raw = render('raw', false);
    const normalized = render('norm', true);
    assert.ok(raw < -30, `un-normalized mix is quiet (${raw} LUFS)`);
    assert.ok(Math.abs(normalized - LOUDNORM_TARGETS.I) <= 2.5, `normalized mix is near ${LOUDNORM_TARGETS.I} LUFS (got ${normalized})`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
