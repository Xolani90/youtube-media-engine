// EVALUATION ONLY. Step 2 of 4. Builds eval/scene-relevance/contact-sheet.html:
// every candidate for every scene, labelled with its stable candidate ID, with
// controls for the HUMAN relevance judgment. It shows NO model scores and does
// not read results.json, so the judgments stay independent of SigLIP.
//
// Open the HTML file in a browser, judge each scene, tick "reviewed", then
// click "Export judgments.json" and save the file as
// eval/scene-relevance/judgments.json.
//
// usage: node scripts/eval-scene-relevance-contact-sheet.js
import fs from 'node:fs';
import path from 'node:path';

const EVAL_DIR = path.resolve(process.env.EVAL_DIR || path.join('eval', 'scene-relevance'));
const scenesDoc = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'scenes.json'), 'utf8'));
const cand = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'candidates.json'), 'utf8'));

const data = {
  scenes: scenesDoc.scenes
    .filter((s) => cand.scenes[s.id])
    .map((s) => ({
      id: s.id,
      description: s.description,
      visualTarget: s.visualTarget,
      candidates: cand.scenes[s.id].candidates.map((c) => ({
        id: c.candidateId, src: c.localPath, page: c.pageURL, tags: c.tags
      }))
    }))
};
const json = JSON.stringify(data).replace(/</g, '\\u003c');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Scene relevance: human review</title>
<style>
 body{font-family:system-ui,sans-serif;margin:0;padding:16px 24px;background:#fafafa;color:#111}
 header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ccc;padding:8px 0;z-index:5}
 section{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:18px 0}
 h2{margin:0 0 4px;font-size:18px} .desc{font-size:16px;margin:4px 0} .target{color:#555;font-size:13px;margin-bottom:10px}
 .grid{display:flex;flex-wrap:wrap;gap:12px}
 .card{border:1px solid #ccc;border-radius:6px;padding:6px;width:300px;background:#fcfcfc}
 .card img{width:100%;height:200px;object-fit:contain;background:#222;border-radius:4px}
 .cid{font-weight:700;font-family:monospace} .card label{display:block;font-size:13px;margin-top:4px}
 .meta{font-size:11px;color:#666;word-break:break-word}
 .bar{margin-top:10px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
 textarea{width:340px;height:44px} button{padding:6px 12px} .done{border-color:#2a7} 
</style></head><body>
<header><b>Human relevance review</b> &mdash; <span id="count"></span>
 <button id="export">Export judgments.json</button>
 <span style="font-size:12px;color:#555">Judge from the photo against the scene text. No model scores are shown here.</span></header>
<div id="root"></div>
<script>
const DATA = ${json};
const KEY = 'ame-scene-rel-judgments-v1';
let state = {};
try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const get = (id) => (state[id] ||= { reviewed:false, relevant:[], best:[], noneSuitable:false, notes:'' });
const toggle = (arr, v, on) => { const i = arr.indexOf(v); if (on && i < 0) arr.push(v); if (!on && i >= 0) arr.splice(i,1); };
function render(){
  const root = document.getElementById('root'); root.innerHTML = '';
  let done = 0;
  for (const sc of DATA.scenes) {
    const st = get(sc.id); if (st.reviewed) done++;
    const sec = document.createElement('section'); if (st.reviewed) sec.className = 'done';
    sec.innerHTML = '<h2></h2><div class="desc"></div><div class="target"></div><div class="grid"></div><div class="bar"></div>';
    sec.querySelector('h2').textContent = sc.id;
    sec.querySelector('.desc').textContent = sc.description;
    sec.querySelector('.target').textContent = 'Look for: ' + sc.visualTarget;
    const grid = sec.querySelector('.grid');
    for (const c of sc.candidates) {
      const card = document.createElement('div'); card.className = 'card';
      card.innerHTML = '<a target="_blank"><img></a><div class="cid"></div><div class="meta"></div>'
        + '<label><input type="checkbox" class="rel"> relevant</label><label><input type="checkbox" class="best"> best (a clearly good match)</label>';
      card.querySelector('img').src = c.src; card.querySelector('a').href = c.src;
      card.querySelector('.cid').textContent = c.id;
      card.querySelector('.meta').textContent = 'tags: ' + (c.tags || 'n/a');
      const rel = card.querySelector('.rel'), best = card.querySelector('.best');
      rel.checked = st.relevant.includes(c.id); best.checked = st.best.includes(c.id);
      rel.disabled = best.disabled = st.noneSuitable;
      rel.onchange = () => { toggle(st.relevant, c.id, rel.checked); if (!rel.checked) toggle(st.best, c.id, false); persist(); render(); };
      best.onchange = () => { toggle(st.best, c.id, best.checked); if (best.checked) toggle(st.relevant, c.id, true); persist(); render(); };
      grid.appendChild(card);
    }
    const bar = sec.querySelector('.bar');
    bar.innerHTML = '<label><input type="checkbox" class="none"> no candidate is suitable</label>'
      + '<label><input type="checkbox" class="rv"> <b>reviewed</b></label><textarea placeholder="ambiguity / notes"></textarea>';
    const none = bar.querySelector('.none'), rv = bar.querySelector('.rv'), ta = bar.querySelector('textarea');
    none.checked = st.noneSuitable; rv.checked = st.reviewed; ta.value = st.notes;
    none.onchange = () => { st.noneSuitable = none.checked; if (none.checked) { st.relevant = []; st.best = []; } persist(); render(); };
    rv.onchange = () => { st.reviewed = rv.checked; persist(); render(); };
    ta.onchange = () => { st.notes = ta.value; persist(); };
    root.appendChild(sec);
  }
  document.getElementById('count').textContent = done + ' / ' + DATA.scenes.length + ' scenes reviewed';
}
document.getElementById('export').onclick = () => {
  const missing = DATA.scenes.filter((s) => !get(s.id).reviewed).map((s) => s.id);
  if (missing.length) { alert('Not reviewed yet: ' + missing.join(', ')); return; }
  const out = { judgedAt: new Date().toISOString(), scenes: {} };
  for (const s of DATA.scenes) { const st = get(s.id);
    out.scenes[s.id] = { reviewed: true, relevant: st.relevant, best: st.best, noneSuitable: st.noneSuitable, notes: st.notes }; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' }));
  a.download = 'judgments.json'; a.click();
};
render();
</script></body></html>`;

fs.writeFileSync(path.join(EVAL_DIR, 'contact-sheet.html'), html);
console.log(`Wrote ${path.join(EVAL_DIR, 'contact-sheet.html')} (${data.scenes.length} scenes).`);
console.log('Open it in a browser, judge every scene, then export judgments.json into the same folder.');