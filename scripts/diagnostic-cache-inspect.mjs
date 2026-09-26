import Database from 'better-sqlite3';
import fs from 'node:fs';

const PROJECT_IDS = [
  'ef8acbec-f7ff-45c0-b1c0-1a8399c1ae7d',
  '913ee289-ddc4-4988-b6b6-8981225621c4'
];
const DB_PATH = 'data/media-engine.db';
const CACHE_KEY = 'media-engine-sqlite-36226763460-1';
const CACHE_ID = 8145219106;

const lines = [];
const log = (s = '') => lines.push(s);

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const size = fs.statSync(DB_PATH).size;
const rpCount = db.prepare('SELECT COUNT(*) AS n FROM research_projects').get().n;
const claimCount = db.prepare('SELECT COUNT(*) AS n FROM claims').get().n;
const relCount = db.prepare('SELECT COUNT(*) AS n FROM claim_relations').get().n;

log(`cache key restored: ${CACHE_KEY}`);
log(`cache id: ${CACHE_ID}`);
log(`db file size (bytes): ${size}`);
log(`research_projects count: ${rpCount}`);
log(`claims count: ${claimCount}`);
log(`claim_relations count: ${relCount}`);
log('');

const placeholders = PROJECT_IDS.map(() => '?').join(',');

const projects = db.prepare(
  `SELECT * FROM research_projects WHERE id IN (${placeholders})`
).all(...PROJECT_IDS);
log('=== research_projects rows ===');
log(JSON.stringify(projects, null, 2));
log('');

const claims = db.prepare(
  `SELECT id, research_project_id, claim_type, evidence_status, is_load_bearing, claim
   FROM claims WHERE research_project_id IN (${placeholders})
   ORDER BY research_project_id, id`
).all(...PROJECT_IDS);
log('=== claims rows ===');
log(JSON.stringify(claims, null, 2));
log('');

const claimIds = claims.map((c) => c.id);
let relations = [];
if (claimIds.length > 0) {
  const relPlaceholders = claimIds.map(() => '?').join(',');
  relations = db.prepare(
    `SELECT id, claim_id, related_claim_id, relation_type, created_at
     FROM claim_relations
     WHERE relation_type = 'CONTRADICTS'
       AND (claim_id IN (${relPlaceholders}) OR related_claim_id IN (${relPlaceholders}))
     ORDER BY id`
  ).all(...claimIds, ...claimIds);
}
log('=== claim_relations (CONTRADICTS) rows ===');
log(JSON.stringify(relations, null, 2));
log('');

const contradictedIds = new Set();
for (const r of relations) {
  contradictedIds.add(r.claim_id);
  contradictedIds.add(r.related_claim_id);
}

log('=== eligibility table ===');
log('project | claim_id | type | evidence_status | load_bearing | contradiction | brief_eligible');
const summary = {};
for (const c of claims) {
  const hasContradiction = contradictedIds.has(c.id);
  const eligible =
    (c.claim_type === 'FACT' || c.claim_type === 'INFERENCE') &&
    c.evidence_status === 'VERIFIED' &&
    !hasContradiction;
  log(`${c.research_project_id} | ${c.id} | ${c.claim_type} | ${c.evidence_status} | ${c.is_load_bearing} | ${hasContradiction ? 'YES' : 'no'} | ${eligible ? 'YES' : 'no'}`);

  const s = (summary[c.research_project_id] ??= {
    total: 0, FACT: 0, INFERENCE: 0, OPINION: 0,
    VERIFIED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTESTED: 0,
    contradicted: 0, eligible: 0
  });
  s.total++;
  s[c.claim_type]++;
  s[c.evidence_status]++;
  if (hasContradiction) s.contradicted++;
  if (eligible) s.eligible++;
}
log('');

log('=== per-project summary ===');
for (const [pid, s] of Object.entries(summary)) {
  log(`project: ${pid}`);
  log(JSON.stringify(s, null, 2));
  log('');
}

for (const pid of PROJECT_IDS) {
  if (!summary[pid]) {
    log(`project: ${pid}`);
    log('NO CLAIMS FOUND FOR THIS PROJECT ID AT ALL (0 rows in claims table).');
    log('');
  }
}

log('=== root cause conclusion ===');
for (const pid of PROJECT_IDS) {
  const s = summary[pid];
  if (!s) {
    log(`${pid}: cause = "claims persisted under a different research project ID, or claim persistence/mapping bug" (zero claims rows found for this exact ID)`);
    continue;
  }
  if (s.eligible > 0) {
    log(`${pid}: eligible claims = ${s.eligible} -- contradicts NO_ELIGIBLE_KEY_CLAIMS; re-check gate logic / stale read`);
    continue;
  }
  if (s.FACT + s.INFERENCE === 0) {
    log(`${pid}: cause = "all claims are non-FACT/INFERENCE" (FACT=${s.FACT}, INFERENCE=${s.INFERENCE}, OPINION=${s.OPINION})`);
  } else if (s.VERIFIED === 0) {
    log(`${pid}: cause = "no VERIFIED claims" (VERIFIED=${s.VERIFIED}, PARTIALLY_SUPPORTED=${s.PARTIALLY_SUPPORTED}, UNSUPPORTED=${s.UNSUPPORTED}, CONTESTED=${s.CONTESTED})`);
  } else if (s.contradicted >= (s.FACT + s.INFERENCE)) {
    log(`${pid}: cause = "all otherwise eligible claims have unresolved CONTRADICTS relations" (contradicted=${s.contradicted})`);
  } else {
    log(`${pid}: cause = "combination -- see summary above for exact counts"`);
  }
}

db.close();

fs.writeFileSync('historical-cache-diagnostic.txt', lines.join('\n'), 'utf8');
console.log('Wrote historical-cache-diagnostic.txt');
console.log(lines.join('\n'));
