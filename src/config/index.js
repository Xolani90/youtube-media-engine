// Central configuration. Everything here is read from environment variables
// or config files — nothing is hard-coded business logic.
//
// PRIVACY / SECURITY: no secrets live in this file or in git. See .env.example.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_REGISTRY } from '../publication/providerRegistry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Optional repository-root .env loading. This must happen before the
// environment-dependent config object below is evaluated.
const envFilePath = path.join(REPO_ROOT, '.env');
if (fs.existsSync(envFilePath)) {
  process.loadEnvFile(envFilePath);
}

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

// ADR-0034 §3.2.1: DISCOVERY_FRESH_EVALUATION_BUDGET has exactly two valid
// states -- absent (use `fallback`), or explicitly supplied and a
// non-negative integer ("0", "1", "25", ...). Any other explicitly supplied
// value (negative, fractional, non-numeric, "NaN", "Infinity", "", or
// whitespace-only) is invalid and MUST fail config load immediately, before
// any fresh evaluation begins -- never silently coerced to 0, never falling
// back to `fallback`, never left unbounded.
function envNonNegativeInt(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  if (!/^\d+$/.test(v)) {
    throw new Error(
      `${name} must be a non-negative integer when set (e.g. "0", "1", "25"); ` +
      `got ${JSON.stringify(v)}. Unset the variable to use the default of ${fallback}. See ADR-0034 §3.2.1.`
    );
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new Error(
      `${name} must be a non-negative integer when set (e.g. "0", "1", "25"); ` +
      `got ${JSON.stringify(v)}, which is not a finite number. Unset the variable to use the default of ${fallback}. See ADR-0034 §3.2.1.`
    );
  }
  return n;
}

function envList(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// V1 production-wiring audit (Part 1): PUBLICATION_PROVIDER_PRIORITY must
// fail closed on anything that could silently misconfigure the autonomous
// runner's publication fan-out (src/autonomous/runner.js#buildStages):
//   - an id not in PROVIDER_REGISTRY would only surface as a thrown
//     "Unknown publication provider" error deep inside runPublication, at
//     first sweep time, not at config load -- reject it here instead so a
//     bad env var is caught immediately and loudly.
//   - a duplicate id would silently build two identical publication
//     sub-stages (same provider, same selector, same adapter), each
//     independently attempting/racing the same (content_version, provider)
//     row -- de-duplicate, preserving the first occurrence's position so
//     ordering stays deterministic and intentional.
//   - an explicitly-supplied env var that resolves to zero usable ids
//     (empty string, whitespace-only, or "," alone) must not silently
//     disable publication or silently fall back to the default -- fail
//     loudly instead, since falling back would hide a real config typo and
//     silently disabling would hide a missing feature.
function envPublicationProviders(name, fallback) {
  // envList() treats an explicitly-supplied empty string as "not set" (its
  // own `if (!v) return fallback` guard) and returns `fallback` before ever
  // reaching the empty-list check below -- which would silently defeat the
  // "explicitly empty must fail loudly" contract above for that one input.
  // Route that case around envList() directly; every other explicit value
  // (whitespace-only, ",", a real list) still goes through envList() as
  // before, and an actually-absent variable is unaffected.
  const raw = process.env[name];
  const ids = raw === '' ? [] : envList(name, fallback);
  const seen = new Set();
  const deduped = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }
  const unknown = deduped.filter((id) => !Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, id));
  if (unknown.length > 0) {
    throw new Error(
      `${name} contains unknown publication provider id(s): ${unknown.join(', ')}. ` +
      `Known provider ids: ${Object.keys(PROVIDER_REGISTRY).join(', ')}. ` +
      'Fix or unset the variable to use the default.'
    );
  }
  if (deduped.length === 0) {
    throw new Error(
      `${name} resolved to an empty publication-provider list, which would silently disable all ` +
      'publication. Unset the variable to use the V1 default, or supply at least one known provider id.'
    );
  }
  return deduped;
}

function loadScoringWeights() {
  const p = path.join(REPO_ROOT, 'config', 'scoring_weights.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  // Documented default — the Owner can override via config/scoring_weights.json
  // without touching application code. Matches Opportunity Discovery v0.6 §9's
  // eleven equally-weighted value-score dimensions.
  return {
    version: '0.1',
    weights: {
      novelty: 1.0,
      competition: 1.0,
      story_potential: 1.0,
      evidence_availability: 1.0,
      production_difficulty: 1.0,
      audience_potential: 1.0,
      commercial_intent: 1.0,
      affiliate_potential: 1.0,
      lead_generation_potential: 1.0,
      product_adjacency: 1.0,
      sponsorship_potential: 1.0
    }
  };
}

function loadDiscoveryPolicy() {
  const p = path.join(REPO_ROOT, 'config', 'discovery_policy.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('config/discovery_policy.json is required by Opportunity Discovery v0.6 and was not found.');
}

function loadResearchPolicy() {
  const p = path.join(REPO_ROOT, 'config', 'research_policy.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('config/research_policy.json is required by the Research Subsystem Specification v0.4 and was not found.');
}

function loadBriefPolicy() {
  const p = path.join(REPO_ROOT, 'config', 'brief_policy.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('config/brief_policy.json is required by the Brief Specification and was not found.');
}

function loadScriptPolicy() {
  const p = path.join(REPO_ROOT, 'config', 'script_policy.json');
  if (fs.existsSync(p)) {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  throw new Error('config/script_policy.json is required by the Script Specification and was not found.');
}

export const config = {
  // Global autonomous-operation switch (spec §6, Owner Override).
  // If disabled, autonomous jobs must refuse to execute and record why.
  autonomousEnabled: envBool('AUTONOMOUS_ENABLED', false),

  // SIMULATION is the safe default. LIVE must be explicitly requested.
  // Persisted per system_run record — never inferred.
  runMode: (process.env.RUN_MODE || 'SIMULATION').toUpperCase(), // SIMULATION | LIVE

  // R0-first: paid providers are opt-in only, never a silent fallback.
  allowPaidProviders: envBool('ALLOW_PAID_PROVIDERS', false),

  // Ordered list of LLM provider IDs to try, in priority order.
  // These are pluggable candidates, not architectural commitments — see ADR-0001.
  llmProviderPriority: envList('LLM_PROVIDER_PRIORITY', ['gemini-free', 'groq-free', 'openrouter-free']),

  opportunityProviderPriority: envList('OPPORTUNITY_PROVIDER_PRIORITY', ['rss']),

  // V1 production-wiring audit fix: the autonomous production entrypoint
  // (src/index.js) previously never supplied deps.publication.provider,
  // so runAutonomousOperation's publication stage always fell back to
  // its single hardcoded 'youtube' default (src/publication/pipeline.js,
  // src/autonomous/workSelection.js#selectEligiblePublications) --
  // youtube_shorts, tiktok, and facebook_reels were registered
  // (src/publication/providerRegistry.js) but structurally unreachable
  // through the real production path. This is the ordered list of
  // publication provider ids the autonomous runner fans out to, one
  // publication sub-stage per provider (see buildStages in
  // src/autonomous/runner.js), so a single production invocation's
  // sweep loop attempts every V1 target for each eligible content
  // version. Configurable for ops; defaults to exactly the V1
  // publication targets.
  publicationProviderPriority: envPublicationProviders('PUBLICATION_PROVIDER_PRIORITY', ['youtube_shorts', 'tiktok', 'facebook_reels']),

  // D-C2 (ADR-0002 / ADR-0008): path to the Owner-controlled external
  // side-effect authorization file. Deliberately NOT loaded/cached here —
  // src/state/SideEffectAuthorization.js reads it fresh on every check.
  authorizedExternalActionsPath: path.join(REPO_ROOT, 'config', 'authorized_external_actions.json'),

  // ADR-0032 (Gate 2 / FINAL_COMPLIANCE): path to the versioned Gate 2 policy
  // pack. Deliberately NOT loaded/cached here -- src/compliance/policy.js reads
  // it fresh on every Gate 2 evaluation and every publication-boundary
  // verification (mirrors authorizedExternalActionsPath above).
  gate2PolicyPath: path.join(REPO_ROOT, 'config', 'gate2_policy.json'),

  storageDriver: process.env.STORAGE_DRIVER || 'sqlite',
  sqlitePath: process.env.SQLITE_PATH || path.join(REPO_ROOT, 'data', 'media-engine.db'),

  // Production MVP (0008_production.sql): local filesystem location for
  // deterministic production manifests (src/production/). Referenced by
  // src/production/pipeline.js's default parameter but never actually
  // defined here — every existing caller (all current tests) passes
  // artifactsDir explicitly, so the gap never surfaced. Added now, as a
  // pure addition, because Real Media Production (src/media/) needs the
  // same config-driven-default pattern and this is the same missing
  // piece. No existing Production MVP behavior changes: this only fills
  // in the default a caller gets when it omits artifactsDir.
  productionArtifactsDir: process.env.PRODUCTION_ARTIFACTS_DIR || path.join(REPO_ROOT, 'data', 'artifacts'),

  // Real Media Production v1 (src/media/): local filesystem location for
  // narration audio + rendered .mp4 artifacts. Local only, mirrors
  // productionArtifactsDir exactly — no cloud/object storage.
  mediaArtifactsDir: process.env.MEDIA_ARTIFACTS_DIR || path.join(REPO_ROOT, 'data', 'media_artifacts'),

  schedulerDriver: process.env.SCHEDULER_DRIVER || 'github-actions',

  costLimits: {
    maxDailySpend: Number(process.env.MAX_DAILY_SPEND ?? 0),
    maxMonthlySpend: Number(process.env.MAX_MONTHLY_SPEND ?? 0),
    maxCostPerContent: Number(process.env.MAX_COST_PER_CONTENT ?? 0),
    // D-B2 (ADR pending closure): lifetime cumulative ceiling for a single
    // content_id, spanning all job_stages. Additive to maxCostPerContent
    // (the existing D-B1 per-call ceiling) — neither replaces the other.
    // Same "0 = no budget allocated" convention as the limits above.
    maxCumulativeCostPerContent: Number(process.env.MAX_CUMULATIVE_COST_PER_CONTENT ?? 0)
  },

  scoringWeights: loadScoringWeights(),
  discoveryPolicy: loadDiscoveryPolicy(),
  researchClassification: Object.freeze({
    authoritativeDomains: Object.freeze([]),
    syndicatedDomains: Object.freeze([]),
  }),
  researchPolicy: loadResearchPolicy(),
  briefPolicy: loadBriefPolicy(),
  scriptPolicy: loadScriptPolicy(),

  // Top-K per run handed to Research (v0.6 §18). Config-driven, initial value 1-3.
  discoveryTopK: Number(process.env.DISCOVERY_TOP_K ?? 2),

  // ADR-0034: successful fresh Discovery evaluations permitted in a single
  // Discovery run (durable reuse and budget-skips consume none of it).
  discoveryFreshEvaluationBudget: envNonNegativeInt('DISCOVERY_FRESH_EVALUATION_BUDGET', 25),

  repoRoot: REPO_ROOT
};

export default config;