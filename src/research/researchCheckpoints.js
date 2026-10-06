import crypto from 'node:crypto';

// ADR-0039 (B4): durable Research recovery checkpoints.
//
// A checkpoint row is only ever written inside the SAME storage transaction as
// the evidence it describes, so "checkpoint present" <=> "that evidence is
// committed, completely". A resumed attempt therefore never re-acquires,
// re-extracts or re-expands what a checkpoint covers, and never duplicates it.
//
//   SOURCES_PERSISTED     the initial acquired sources + their decision rows
//   EXTRACTION_PERSISTED  every claim / claim_source link / identity /
//                         convergence / decision row of the extraction phase
//   EXPANSION_PERSISTED   the optional evidence-expansion sources, plus the
//                         exact expansion budget state (topFactClaimId,
//                         expansionAttemptsUsed, remaining verifier calls)
//
// Payloads are small JSON documents of ids and counters; the evidence itself
// stays in its own tables and is never copied or altered here.

export const RESEARCH_CHECKPOINT = Object.freeze({
  SOURCES_PERSISTED: 'SOURCES_PERSISTED',
  EXTRACTION_PERSISTED: 'EXTRACTION_PERSISTED',
  EXPANSION_PERSISTED: 'EXPANSION_PERSISTED'
});

/** Returns { [checkpointName]: parsedPayload } for the project. A corrupt payload throws (fail closed). */
export function readResearchCheckpoints(storage, researchProjectId) {
  const out = {};
  const rows = storage.all(
    'SELECT checkpoint, payload FROM research_checkpoints WHERE research_project_id = ?',
    [researchProjectId]
  );
  for (const row of rows) {
    try {
      out[row.checkpoint] = JSON.parse(row.payload);
    } catch {
      throw new Error(`research checkpoint ${row.checkpoint} for project ${researchProjectId} has an unparseable payload`);
    }
  }
  return out;
}

/** Inserts one checkpoint. Call inside the transaction that persists the covered evidence. */
export function writeResearchCheckpoint(storage, { researchProjectId, checkpoint, payload }, nowISO = () => new Date().toISOString()) {
  if (!Object.values(RESEARCH_CHECKPOINT).includes(checkpoint)) {
    throw new Error(`unknown research checkpoint: ${checkpoint}`);
  }
  storage.run(
    'INSERT INTO research_checkpoints (id, research_project_id, checkpoint, payload, created_at) VALUES (?, ?, ?, ?, ?)',
    [crypto.randomUUID(), researchProjectId, checkpoint, JSON.stringify(payload ?? {}), nowISO()]
  );
}
