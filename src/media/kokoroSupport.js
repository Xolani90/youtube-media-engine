import fs from 'node:fs';
// Pure helpers for the Kokoro worker (kept separate so they are unit-testable
// without the model or onnxruntime).

export function concatFloat32(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Mono 16-bit PCM WAV from float samples in [-1, 1]. */
export function encodeWav16(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Natural-delivery helpers (pure; unit-testable without the model).
//
// Why they exist: Kokoro synthesises sentence by sentence and the original worker simply concatenated the
// sentences with no gap, spoke headings as ordinary sentences, and read abbreviations, symbols and model
// names ("GPT-6.1", "6×", "300 tokens/second") however its phonemizer guessed. That is what made the voice
// sound hurried and robotic. Everything below changes only what is SPOKEN; captions keep the original text.
// ---------------------------------------------------------------------------

export const DEFAULT_KOKORO_SPEED = 0.95;

/** KOKORO_SPEED (0.5-1.5). An invalid value throws; unset gives the default. */
export function resolveKokoroSpeed(env = process.env) {
  const raw = env.KOKORO_SPEED;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_KOKORO_SPEED;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0.5 || n > 1.5) throw new Error(`KOKORO_SPEED must be between 0.5 and 1.5 (got "${raw}")`);
  return n;
}

/** Silence between utterances, in seconds. Overridable per key with KOKORO_PAUSE_<KEY>_MS. */
export const DEFAULT_PAUSES = Object.freeze({ LEAD: 0.12, SENTENCE: 0.34, QUESTION: 0.42, HEADING: 0.62, PARAGRAPH: 0.78, TAIL: 0.45 });

export function resolvePauses(env = process.env) {
  const out = { ...DEFAULT_PAUSES };
  for (const key of Object.keys(DEFAULT_PAUSES)) {
    const raw = env[`KOKORO_PAUSE_${key}_MS`];
    if (raw === undefined || String(raw).trim() === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 5000) throw new Error(`KOKORO_PAUSE_${key}_MS must be 0-5000 (got "${raw}")`);
    out[key] = n / 1000;
  }
  return out;
}

// Letters spoken one by one. Pronounceable acronyms (NASA, LEGO ...) are deliberately absent.
const SPELLED = new Set(['AI', 'API', 'APIS', 'GPT', 'LLM', 'LLMS', 'CEO', 'CFO', 'CTO', 'COO', 'USB', 'GPU', 'CPU', 'SQL', 'HTML', 'CSS',
  'URL', 'ROI', 'KPI', 'FAQ', 'USA', 'UK', 'EU', 'UN', 'TV', 'PC', 'HR', 'SEO', 'SDK', 'CLI', 'SMS', 'PDF', 'VPN', 'ERP', 'CRM', 'POS',
  'UI', 'UX', 'AWS', 'IBM', 'BBC', 'CNN', 'NBA', 'NFL', 'FBI', 'CIA', 'IRS', 'VAT', 'GDP', 'IPO', 'B2B', 'B2C', 'OCR', 'ASR', 'TTS']);
const PRONOUNCED = new Set(['NASA', 'NATO', 'FIFA', 'UNESCO', 'COVID', 'LEGO', 'OPEC', 'LASER', 'RADAR', 'SCUBA', 'SAAS', 'WIFI', 'PIN', 'OK', 'AM', 'PM', 'NEW', 'THE', 'AND', 'FOR', 'NOW', 'YOU', 'ALL', 'BIG', 'TOP', 'WHY', 'HOW']);
const spell = (w) => w.split('').join(' ');

/**
 * Pronunciation fixes for names the phonemizer is likely to get wrong. Keys are matched case-insensitively
 * as whole words. Extend with a JSON object file via KOKORO_LEXICON_FILE ({"Name": "respelling"}).
 */
export const DEFAULT_LEXICON = Object.freeze({
  "Schlotzsky's": "Shlots-key's", Schlotzskys: 'Shlots-keys', Cinnabon: 'Sinna-bon', Kokoro: 'Koh-koh-roh', Nginx: 'engine X',
  Kubernetes: 'Koo-ber-net-eez', GitHub: 'Git Hub', YouTube: 'You Tube', TikTok: 'Tick Tock', OpenAI: 'Open A I', ChatGPT: 'Chat G P T',
  SaaS: 'sass', 'Wi-Fi': 'wifi', 'e-commerce': 'e commerce', 'T3': 'T three'
});

export function loadLexicon(env = process.env, readFile = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))) {
  const file = env.KOKORO_LEXICON_FILE;
  if (!file || !String(file).trim()) return { ...DEFAULT_LEXICON };
  const extra = readFile(file);
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('KOKORO_LEXICON_FILE must contain a JSON object');
  return { ...DEFAULT_LEXICON, ...extra };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The text Kokoro should SPEAK for one paragraph. Deterministic, no model. Never adds facts: it only rewrites
 * symbols, abbreviations, acronyms and punctuation into their spoken form.
 */
export function normalizeForSpeech(text, { lexicon = DEFAULT_LEXICON } = {}) {
  let t = String(text ?? '');
  t = t.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
  t = t.replace(/https?:\/\/\S+/gi, '').replace(/[*_`#>]+/g, ' ');
  // Pronunciation lexicon first (before acronym spelling touches the same words).
  for (const [word, say] of Object.entries(lexicon)) {
    t = t.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(word)}(?![A-Za-z0-9])`, 'gi'), say);
  }
  // Latin abbreviations.
  t = t.replace(/\be\.g\.,?/gi, 'for example,').replace(/\bi\.e\.,?/gi, 'that is,').replace(/\bvs\.?(?=\s)/gi, 'versus')
    .replace(/\betc\.(?=\s+[a-z])/g, 'and so on').replace(/\betc\./gi, 'and so on.').replace(/\bapprox\.?(?=\s)/gi, 'approximately');
  // Money: $1.2 million -> 1.2 million dollars; $5 -> 5 dollars.
  t = t.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion|[kmb])?\b/gi, (_, n, unit) => {
    const u = { k: 'thousand', m: 'million', b: 'billion' }[String(unit ?? '').toLowerCase()] ?? (unit ? unit.toLowerCase() : '');
    return `${n}${u ? ` ${u}` : ''} dollars`;
  });
  t = t.replace(/(\d)\s?%/g, '$1 percent').replace(/%/g, ' percent ');
  // 6x / 6× / 6 x faster -> 6 times
  t = t.replace(/(\d)\s?[x\u00d7](?=\s|$|[.,;:!?)])/gi, '$1 times').replace(/\u00d7/g, ' times ');
  t = t.replace(/\b(\w+)\/(second|sec|minute|min|hour|hr|day|week|month|year)\b/gi, (_, a, b) => `${a} per ${{ sec: 'second', min: 'minute', hr: 'hour' }[b.toLowerCase()] ?? b}`);
  t = t.replace(/&/g, ' and ').replace(/\s+\+\s+/g, ' plus ').replace(/\s=\s/g, ' equals ');
  // Model / product names: GPT-6.1 -> G P T 6.1 ; Q3 -> Q 3 left to the phonemizer.
  t = t.replace(/\b([A-Z]{2,5})-(\d)/g, (_, a, d) => `${a} ${d}`);
  // Acronyms: explicit spelled set, plus a conservative generic rule for unknown 2-4 letter all-caps tokens.
  t = t.replace(/\b([A-Z][A-Za-z]{1,4})\b/g, (m) => {
    const up = m.toUpperCase();
    if (PRONOUNCED.has(up)) return m;
    if (m === up && SPELLED.has(up)) return spell(up);
    // Plural of a spelled acronym: APIs -> "A P I s", SDKs -> "S D K s" (lower-case s only).
    if (/s$/.test(m) && m.slice(0, -1) === up.slice(0, -1) && SPELLED.has(up.slice(0, -1))) return `${spell(up.slice(0, -1))}s`;
    return m;
  });
  // Unknown vowel-less all-caps tokens (MPG, CRM) are initialisms; tokens with vowels (IT, NOT, SOL) are left alone.
  t = t.replace(/\b([B-DF-HJ-NP-TV-Z]{2,5})\b/g, (m) => (PRONOUNCED.has(m) ? m : spell(m)));
  // Punctuation that should become a natural pause, not be read or ignored.
  t = t.replace(/\s*[\u2014\u2013]\s*/g, ', ').replace(/\s+-\s+/g, ', ').replace(/\u2026/g, '...');
  t = t.replace(/\s*\(([^)]*)\)/g, ', $1,').replace(/,\s*,/g, ',').replace(/,\s*([.!?])/g, '$1').replace(/,\s*$/g, '.');
  t = t.replace(/\s+([,.;:!?])/g, '$1').replace(/\s+/g, ' ').trim();
  return t;
}

/** Paragraphs in reading order (blank-line separated, as scriptBodyToNarrationText emits them). */
export function splitParagraphs(text) {
  return String(text ?? '').split(/\n\s*\n+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const HEADING_SMALL = new Set(['and', 'of', 'the', 'to', 'for', 'in', 'on', 'with', 'a', 'an', 'vs']);
/** A short Title Case line ("Operational Challenges and Menu Repricing."): spoken with a longer pause after it. */
export function looksLikeHeading(sentence) {
  const s = String(sentence ?? '').trim().replace(/\.$/, '');
  if (!/[A-Za-z]/.test(s) || /[?!,;:]/.test(s)) return false;
  const words = s.split(/\s+/);
  if (words.length < 2 || words.length > 7) return false;
  return words.every((w) => HEADING_SMALL.has(w.toLowerCase()) || /^[A-Z0-9]/.test(w));
}

/** Seconds of silence to leave AFTER an utterance. */
export function pauseAfter(utterance, { isLastInParagraph, pauses = DEFAULT_PAUSES }) {
  if (isLastInParagraph) return pauses.PARAGRAPH;
  const s = String(utterance ?? '').trim();
  if (looksLikeHeading(s)) return pauses.HEADING;
  if (/\?["')\]]*$/.test(s)) return pauses.QUESTION;
  return pauses.SENTENCE;
}

/** Samples at or below this absolute amplitude (about -48 dBFS) count as silence when trimming. */
export const TRIM_THRESHOLD = 0.004;
/** Silence kept on each side of the speech after trimming, in seconds, so word onsets and tails are not clipped. */
export const TRIM_MARGIN_SECONDS = 0.04;

/**
 * Removes the model's own leading and trailing near-silence from one utterance so that the configured
 * pauses are the actual pauses. An all-silent utterance is returned unchanged.
 */
export function trimSilence(samples, sampleRate, { threshold = TRIM_THRESHOLD, marginSeconds = TRIM_MARGIN_SECONDS } = {}) {
  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) <= threshold) first++;
  if (first === samples.length) return samples;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) <= threshold) last--;
  const margin = Math.round(marginSeconds * sampleRate);
  return samples.subarray(Math.max(0, first - margin), Math.min(samples.length, last + 1 + margin));
}

export function silence(seconds, sampleRate) {
  return new Float32Array(Math.max(0, Math.round(seconds * sampleRate)));
}

/**
 * Assembles the whole narration. `streamFor(paragraphText)` must return an async iterable of
 * { text, audio: { audio: Float32Array, sampling_rate } } (the shape kokoro-js yields).
 * Utterances are separated by pauseAfter(); a short lead-in and tail avoid abrupt starts and ends.
 */
export async function assembleNarration({ paragraphs, streamFor, pauses = DEFAULT_PAUSES, lexicon = DEFAULT_LEXICON }) {
  const parts = [];
  let sampleRate = null;
  for (let pi = 0; pi < paragraphs.length; pi++) {
    const spoken = normalizeForSpeech(paragraphs[pi], { lexicon });
    if (!spoken) continue;
    const utterances = [];
    for await (const item of streamFor(spoken)) {
      const audio = item.audio;
      sampleRate ??= audio.sampling_rate;
      if (audio.sampling_rate !== sampleRate) throw new Error('inconsistent sampling rate from Kokoro');
      utterances.push({ text: item.text ?? '', samples: audio.audio });
    }
    utterances.forEach((u, ui) => {
      parts.push(trimSilence(u.samples, sampleRate));
      const last = ui === utterances.length - 1;
      if (last && pi === paragraphs.length - 1) return;
      parts.push(silence(pauseAfter(u.text, { isLastInParagraph: last, pauses }), sampleRate));
    });
  }
  if (parts.length === 0 || sampleRate === null) throw new Error('Kokoro produced no audio');
  return { samples: concatFloat32([silence(pauses.LEAD, sampleRate), ...parts, silence(pauses.TAIL, sampleRate)]), sampleRate };
}
