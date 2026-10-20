// One-off: wires computeSceneSequencing into src/media/pipeline.js. Fails loudly (changes nothing) if an anchor is not found exactly once.
import fs from 'node:fs';
const p = 'src/media/pipeline.js';
let s = fs.readFileSync(p, 'utf8');
if (s.includes('computeSceneSequencing')) { console.log('already applied'); process.exit(0); }
const edits = [
  ["import { computeVisualSequencing } from './visualSequencing.js';", "import { computeVisualSequencing } from './visualSequencing.js';\nimport { computeSceneSequencing } from './sceneSequencing.js';"],
  ["const sequencedTiming = computeVisualSequencing(visualAssets, captionTiming, narrationDurationSeconds);", "const sequencedTiming = computeSceneSequencing(visualAssets, captionTiming, narrationDurationSeconds)\n    ?? computeVisualSequencing(visualAssets, captionTiming, narrationDurationSeconds);"]
];
for (const [from] of edits) {
  const n = s.split(from).length - 1;
  if (n !== 1) { console.error(`ANCHOR NOT FOUND EXACTLY ONCE (${n}): ${from}`); process.exit(1); }
}
for (const [from, to] of edits) s = s.replace(from, () => to);
fs.writeFileSync(p, s);
console.log('applied');
