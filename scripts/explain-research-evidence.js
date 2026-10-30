#!/usr/bin/env node
/**
 * Read-only explanation of why load-bearing research claims are not VERIFIED.
 *
 * Usage: node scripts/explain-research-evidence.js <sqlite-db-path>
 *
 * This script performs no network, LLM, or database-write operation. It uses
 * the production evidence diagnostic (`explainEvidenceSources`) and the same
 * policy file as the research pipeline.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { explainEvidenceSources } from '../src/research/evidenceGrading.js';

const policy = JSON.parse(fs.readFileSync(new URL('../config/research_policy.json', import.meta.url), 'utf8'));

function clip(value, limit = 180) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function whyNotVerified(explanation) {
  if (explanation.hasPrimaryAuthoritative) return 'verified_by_primary_authoritative';
  if (explanation.eligibleContradictingSourceIds.length > 0) return 'eligible_contradicting_source';
  if (explanation.independentCount < explanation.required) {
    return `independent_reporting_${explanation.independentCount}_of_${explanation.required}`;
  }
  return 'not_verified_by_current_evidence_policy';
}

export function explainLoadBearingClaims(db, { nowMs = Date.now() } = {}) {
  const claims = db.prepare(`
    SELECT id, claim, claim_type, evidence_status
    FROM claims WHERE is_load_bearing = 1 ORDER BY created_at, id
  `).all();
  const linksFor = db.prepare('SELECT claim_id, source_id, role FROM claim_sources WHERE claim_id = ? ORDER BY source_id, role');
  const sourceFor = db.prepare('SELECT * FROM sources WHERE id = ?');
  return claims.map((claim) => {
    const links = linksFor.all(claim.id);
    const sourcesById = new Map(links.map((link) => [link.source_id, sourceFor.get(link.source_id)]).filter(([, source]) => source));
    const explanation = explainEvidenceSources({ claimSourceLinks: links, sourcesById, policy, nowMs });
    return { claim, explanation, why: claim.evidence_status === 'VERIFIED' ? null : whyNotVerified(explanation) };
  });
}

export function formatClaimExplanation({ claim, explanation, why }) {
  const lines = [
    `[research-evidence] claim=${claim.id}`,
    `claim_type=${claim.claim_type} evidence_status=${claim.evidence_status}`,
    `claim=${clip(claim.claim)}`,
    `verification=${claim.evidence_status === 'VERIFIED' ? 'VERIFIED' : `NOT_VERIFIED:${why}`}`,
    `independent_reporting=${explanation.independentCount}/${explanation.required} primary_authoritative=${explanation.hasPrimaryAuthoritative}`
  ];
  if (explanation.sources.length === 0) lines.push('source=none');
  for (const source of explanation.sources) {
    lines.push(
      `source=${source.sourceId} role=${source.role ?? 'UNKNOWN'} quality_tier=${source.qualityTier ?? 'UNKNOWN'} ` +
      `retrieval_status=${source.retrievalStatus ?? 'UNKNOWN'} independence_key=${source.domain ?? 'NONE'} ` +
      `eligible=${source.eligible}`
    );
  }
  return lines.join('\n');
}

export function run(dbPath, out = console.log) {
  if (!dbPath) throw new Error('usage: node scripts/explain-research-evidence.js <sqlite-db-path>');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = explainLoadBearingClaims(db);
    if (rows.length === 0) out('[research-evidence] no load-bearing claims');
    for (const row of rows) out(formatClaimExplanation(row));
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { run(process.argv[2]); } catch (error) { console.error(error.message); process.exitCode = 2; }
}
