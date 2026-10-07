// READ-ONLY diagnostic. Not part of `npm test`, not part of the runner,
// writes nothing, makes no network or LLM calls, touches no production code.
//
// Purpose: explain, from a KEPT disposable DB (e.g. the dir left behind by
// KEEP_TMP=1 node scripts/prove-fresh-autonomous-to-media.js), exactly why a
// research project ended INSUFFICIENT_EVIDENCE: how many claims the
// extractor marked load-bearing, how they split by type and evidence
// status, and a sample of the load-bearing claims that blocked completion
// (src/research/completeness.js: any UNSUPPORTED load-bearing claim blocks).
//
// Usage:  node scripts/inspect-research-db.js "<path to fresh.db>" [sampleSize]
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const sampleSize = Number(process.argv[3] || 8);
if (!dbPath) { console.error('usage: node scripts/inspect-research-db.js <path-to-db> [sampleSize]'); process.exit(2); }

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const clip = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

const projects = db.prepare(
  `SELECT rp.id, rp.status, rp.stop_reason, o.title
   FROM research_projects rp LEFT JOIN opportunities o ON o.id = rp.opportunity_id
   ORDER BY rp.created_at`).all();

for (const p of projects) {
  console.log(`\n== project ${p.id}\n   topic: ${clip(p.title)}\n   status=${p.status} stop_reason=${p.stop_reason}`);
  const total = db.prepare('SELECT COUNT(*) n FROM claims WHERE research_project_id = ?').get(p.id).n;
  const lb = db.prepare('SELECT COUNT(*) n FROM claims WHERE research_project_id = ? AND is_load_bearing = 1').get(p.id).n;
  console.log(`   claims=${total} load_bearing=${lb} (${total ? Math.round((100 * lb) / total) : 0}%)`);
  console.log('   load-bearing by type/evidence_status:');
  for (const r of db.prepare(
    `SELECT claim_type, evidence_status, COUNT(*) n FROM claims
     WHERE research_project_id = ? AND is_load_bearing = 1
     GROUP BY claim_type, evidence_status ORDER BY n DESC`).all(p.id)) {
    console.log(`     ${r.claim_type.padEnd(10)} ${r.evidence_status.padEnd(20)} ${r.n}`);
  }
  console.log(`   sample load-bearing UNSUPPORTED claims (up to ${sampleSize}):`);
  for (const r of db.prepare(
    `SELECT claim_type, claim FROM claims
     WHERE research_project_id = ? AND is_load_bearing = 1 AND evidence_status = 'UNSUPPORTED'
     ORDER BY created_at LIMIT ?`).all(p.id, sampleSize)) {
    console.log(`     [${r.claim_type}] ${clip(r.claim)}`);
  }
  console.log('   VERIFIED claims (up to 5):');
  for (const r of db.prepare(
    `SELECT claim_type, is_load_bearing lb, claim FROM claims
     WHERE research_project_id = ? AND evidence_status = 'VERIFIED' LIMIT 5`).all(p.id)) {
    console.log(`     [${r.claim_type}${r.lb ? ',load-bearing' : ''}] ${clip(r.claim)}`);
  }
}
db.close();
