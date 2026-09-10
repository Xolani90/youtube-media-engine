import crypto from 'node:crypto';

/**
 * CONTRADICTS is undirected (v0.4): (A,B) and (B,A) must not both be
 * stored. Canonical ordering (lexicographically smaller claim_id first)
 * is the application-layer half of that guarantee; the database's
 * UNIQUE(claim_id, related_claim_id, relation_type) index is the other
 * half — together they prevent mirrored duplicates even under retry.
 */
export function canonicalizePair(claimIdA, claimIdB) {
  return claimIdA < claimIdB ? [claimIdA, claimIdB] : [claimIdB, claimIdA];
}

/**
 * Records a CONTRADICTS relation between two claims. Idempotent: if the
 * (canonicalized) pair already exists, this is a no-op rather than an
 * error — a retry or a re-detection of the same contradiction must not
 * fail the pipeline.
 *
 * Detection of contradiction (a semantic judgment) is NOT this function's
 * job — see requiring code, which uses an LLM-assisted checker (v0.3 S2)
 * and calls this only once a contradiction has been judged to exist. This
 * function's only responsibility is deterministic, safe persistence.
 */
export function recordContradiction(storage, { claimId, relatedClaimId }, nowISO = () => new Date().toISOString()) {
  if (claimId === relatedClaimId) {
    throw new Error('a claim cannot contradict itself');
  }
  const [a, b] = canonicalizePair(claimId, relatedClaimId);
  const id = crypto.randomUUID();
  try {
    storage.run(
      `INSERT INTO claim_relations (id, claim_id, related_claim_id, relation_type, created_at)
       VALUES (?, ?, ?, 'CONTRADICTS', ?)`,
      [id, a, b, nowISO()]
    );
    return { inserted: true, id, claimId: a, relatedClaimId: b };
  } catch (err) {
    if (/UNIQUE constraint failed/.test(err.message)) {
      return { inserted: false, reason: 'ALREADY_RECORDED', claimId: a, relatedClaimId: b };
    }
    throw err;
  }
}

/**
 * True if the given claim participates in ANY recorded CONTRADICTS
 * relation (as either side — the relation is undirected).
 */
export function hasUnresolvedContradiction(storage, claimId) {
  const row = storage.get(
    `SELECT 1 FROM claim_relations
     WHERE relation_type = 'CONTRADICTS' AND (claim_id = ? OR related_claim_id = ?)
     LIMIT 1`,
    [claimId, claimId]
  );
  return !!row;
}