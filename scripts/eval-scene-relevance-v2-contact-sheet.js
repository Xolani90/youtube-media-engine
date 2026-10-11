// EVALUATION ONLY (v2). OFFLINE. Writes eval/scene-relevance-v2/contact-sheet.html.
//
// ONE blind sheet containing every item: 30 positive scenes, 10 cross-category
// pairings and 10 near-miss scenes, labelled J01..J50. The sheet NEVER reads
// results.json, so no model score or rank can reach the reviewer.
//
// BLINDING: the sheet, its embedded data, its image file names and the exported
// file contain ONLY random opaque IDs. The mapping back to item and candidate
// IDs lives in answer-key.json, which is created once (crypto randomness), never
// overwritten, and must NOT be given to the reviewer. Give the reviewer only
// contact-sheet.html and the review-assets/ folder (images copied under opaque
// names). Item order and in-item photo order come from the key (random), so they
// cannot be recomputed from public IDs. Pixabay tags and original paths are not
// embedded. Re-running reuses the existing key; a key that no longer matches the
// items is refused, never regenerated.
//
// Review, then press "Export": the reviewer states their ID and two honest
// checkboxes (labels suggested by an AI? saw model scores first?) and the file
// blind-judgments-<reviewerId>.json is downloaded. Save it in this folder, then
// run the freeze script, which translates it using the key. A second reviewer
// exports a separate file.
//
// NOT hidden by this script: cross-category items reuse another scene's photos,
// so the same photo set can appear under two descriptions; image metadata is not
// stripped; the owner who wrote the negatives cannot be blind to them.
//
// usage: node scripts/eval-scene-relevance-v2-contact-sheet.js
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_EVAL_DIR, ANSWER_KEY_FILE, REVIEW_ASSET_DIR, readJsonStrict, buildItems, buildAnswerKey, validateAnswerKey, sha256File } from './eval-scene-relevance-v2-lib.js';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || DEFAULT_EVAL_DIR);
const die = (m) => { console.error(`SHEET REFUSED: ${m}`); process.exit(1); };
let items; let key;
try {
  items = buildItems(readJsonStrict(path.join(EVAL_DIR, 'scenes.json')), readJsonStrict(path.join(EVAL_DIR, 'negatives.json')), readJsonStrict(path.join(EVAL_DIR, 'candidates.json')));
  const keyPath = path.join(EVAL_DIR, ANSWER_KEY_FILE);
  if (fs.existsSync(keyPath)) key = validateAnswerKey(readJsonStrict(keyPath), items); // reuse: IDs stay stable
  else {
    if (fs.existsSync(path.join(EVAL_DIR, 'judgments-manifest.json'))) throw new Error('judgments are frozen but answer-key.json is missing; a new key would silently remap them');
    key = buildAnswerKey(items); validateAnswerKey(key, items);
    fs.writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`, { flag: 'wx' }); // never overwrites
    console.log(`Created ${keyPath}. KEEP IT PRIVATE: do not give it to the reviewer.`);
  }
} catch (e) { die(e.message); }

// Reviewer-facing images under opaque names (never overwrites a different file).
const byId = new Map(items.map((i) => [i.itemId, i]));
const assetDir = path.join(EVAL_DIR, REVIEW_ASSET_DIR); fs.mkdirSync(assetDir, { recursive: true });
const data = {
  keyId: key.keyId,
  items: key.items.map((k, i) => {
    const it = byId.get(k.itemId); const cands = new Map(it.candidates.map((c) => [c.candidateId, c]));
    return {
      id: k.opaqueItemId, display: `J${String(i + 1).padStart(2, '0')}`, description: it.description, visualTarget: it.visualTarget,
      candidates: k.candidates.map((kc, n) => {
        const src = path.resolve(EVAL_DIR, ...cands.get(kc.candidateId).localPath.split('/'));
        if (!fs.existsSync(src)) die(`image file missing for an item: ${path.relative(EVAL_DIR, src)}`);
        const name = `${kc.opaqueCandidateId}${path.extname(src).toLowerCase()}`; const dest = path.join(assetDir, name);
        if (fs.existsSync(dest)) { if (sha256File(dest) !== sha256File(src)) die(`${REVIEW_ASSET_DIR}/${name} exists with different content`); } else fs.copyFileSync(src, dest);
        return { id: kc.opaqueCandidateId, label: String(n + 1), src: `${REVIEW_ASSET_DIR}/${name}` };
      })
    };
  })
};
const json = JSON.stringify(data).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scene relevance v2: blind human review</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;padding:16px 24px;background:#fafafa;color:#111}
 header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ccc;padding:8px 0;z-index:5}
 section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:18px 0}
 h2{margin:0 0 4px;font-size:18px}.desc{font-size:16px;margin:4px 0}.target{color:#555;font-size:13px;margin-bottom:10px}
 .grid{display:flex;flex-wrap:wrap;gap:12px}.card{border:1px solid #ccc;border-radius:6px;padding:6px;width:300px;background:#fcfcfc}
 .card img{width:100%;height:200px;object-fit:contain;background:#222;border-radius:4px}
 .cid{font-weight:700}.card label{display:block;font-size:13px;margin-top:4px}
 .bar{margin-top:10px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}textarea{width:340px;height:44px}.done{border-color:#2a7}
</style></head><body>
<header><b>Blind human review (v2)</b> &mdash; <span id="count"></span>
 <button id="export">Export judgments</button>
 <div style="font-size:12px;color:#555">Judge each photo against the text only. No model scores are shown. Some items may have NO suitable photo: tick &ldquo;no photo is suitable&rdquo; when that is true.</div></header>
<div id="root"></div>
<script>
const DATA = ${json};
const KEY = 'ame-scene-rel-v2-draft-' + DATA.keyId;
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const get = (id) => (state[id] ||= { reviewed:false, relevant:[], best:[], noneSuitable:false, notes:'' });
const toggle = (a, v, on) => { const i = a.indexOf(v); if (on && i < 0) a.push(v); if (!on && i >= 0) a.splice(i,1); };
function render(){
  const root = document.getElementById('root'); root.innerHTML = ''; let done = 0;
  for (const it of DATA.items) {
    const st = get(it.id); if (st.reviewed) done++;
    const sec = document.createElement('section'); if (st.reviewed) sec.className = 'done';
    sec.innerHTML = '<h2></h2><div class="desc"></div><div class="target"></div><div class="grid"></div><div class="bar"></div>';
    sec.querySelector('h2').textContent = it.display;
    sec.querySelector('.desc').textContent = it.description;
    sec.querySelector('.target').textContent = 'Look for: ' + it.visualTarget;
    const grid = sec.querySelector('.grid');
    for (const c of it.candidates) {
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = '<a target="_blank"><img></a><div class="cid"></div><label><input type="checkbox" class="rel"> relevant</label><label><input type="checkbox" class="best"> best (a clearly good match; ties allowed)</label>';
      card.querySelector('img').src = c.src; card.querySelector('a').href = c.src; card.querySelector('.cid').textContent = it.display + '-' + c.label;
      const rel = card.querySelector('.rel'), best = card.querySelector('.best');
      rel.checked = st.relevant.includes(c.id); best.checked = st.best.includes(c.id); rel.disabled = best.disabled = st.noneSuitable;
      rel.onchange = () => { toggle(st.relevant, c.id, rel.checked); if (!rel.checked) toggle(st.best, c.id, false); persist(); render(); };
      best.onchange = () => { toggle(st.best, c.id, best.checked); if (best.checked) toggle(st.relevant, c.id, true); persist(); render(); };
      grid.appendChild(card);
    }
    const bar = sec.querySelector('.bar');
    bar.innerHTML = '<label><input type="checkbox" class="none"> no photo is suitable</label><label><input type="checkbox" class="rv"> <b>reviewed</b></label><textarea placeholder="notes (optional)"></textarea>';
    const none = bar.querySelector('.none'), rv = bar.querySelector('.rv'), ta = bar.querySelector('textarea');
    none.checked = st.noneSuitable; rv.checked = st.reviewed; ta.value = st.notes;
    none.onchange = () => { st.noneSuitable = none.checked; if (none.checked) { st.relevant = []; st.best = []; } persist(); render(); };
    rv.onchange = () => { if (rv.checked && !st.noneSuitable && st.relevant.length === 0) { alert('Mark at least one relevant photo, or tick "no photo is suitable".'); rv.checked = false; return; } st.reviewed = rv.checked; persist(); render(); };
    ta.onchange = () => { st.notes = ta.value; persist(); };
    root.appendChild(sec);
  }
  document.getElementById('count').textContent = done + ' / ' + DATA.items.length + ' reviewed';
}
document.getElementById('export').onclick = () => {
  const missing = DATA.items.filter((s) => !get(s.id).reviewed).map((s) => s.display);
  if (missing.length) { alert('Not reviewed yet: ' + missing.join(', ')); return; }
  const reviewerId = (prompt('Reviewer ID (letters, digits, _ or -; e.g. owner):') || '').trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(reviewerId)) { alert('Invalid reviewer ID.'); return; }
  const ai = confirm('Were ANY of your labels suggested by an AI (e.g. Claude)?\\nOK = yes, Cancel = no.');
  const saw = confirm('Did you see ANY model scores or rankings before judging?\\nOK = yes, Cancel = no.');
  const out = { schema: 'scene-relevance-v2-blind-judgments', keyId: DATA.keyId, reviewerId, judgedAt: new Date().toISOString(), aiSuggestedLabels: ai, sawModelScoresFirst: saw, items: {} };
  for (const it of DATA.items) { const st = get(it.id); out.items[it.id] = { reviewed: true, relevant: st.relevant, best: st.best, noneSuitable: st.noneSuitable, notes: st.notes }; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'blind-judgments-' + reviewerId + '.json'; a.click();
};
render();
</script></body></html>`;

fs.writeFileSync(path.join(EVAL_DIR, 'contact-sheet.html'), html);
console.log(`Wrote ${path.join(EVAL_DIR, 'contact-sheet.html')} (${data.items.length} items, order from the private answer key).`);
console.log(`Give the reviewer ONLY contact-sheet.html and ${REVIEW_ASSET_DIR}/ (not ${ANSWER_KEY_FILE}).`);
console.log('Review in a browser, export blind-judgments-<reviewerId>.json into the same folder, then run the freeze script.');
