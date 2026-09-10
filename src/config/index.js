// Central configuration. Everything here is read from environment variables
// or config files — nothing is hard-coded business logic.
//
// PRIVACY / SECURITY: no secrets live in this file or in git. See .env.example.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function envBool(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function envList(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
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

  storageDriver: process.env.STORAGE_DRIVER || 'sqlite',
  sqlitePath: process.env.SQLITE_PATH || path.join(REPO_ROOT, 'data', 'media-engine.db'),

  schedulerDriver: process.env.SCHEDULER_DRIVER || 'github-actions',

  costLimits: {
    maxDailySpend: Number(process.env.MAX_DAILY_SPEND ?? 0),
    maxMonthlySpend: Number(process.env.MAX_MONTHLY_SPEND ?? 0),
    maxCostPerContent: Number(process.env.MAX_COST_PER_CONTENT ?? 0)
  },

  scoringWeights: loadScoringWeights(),
  discoveryPolicy: loadDiscoveryPolicy(),
  researchPolicy: loadResearchPolicy(),
  briefPolicy: loadBriefPolicy(),
  scriptPolicy: loadScriptPolicy(),

  // Top-K per run handed to Research (v0.6 §18). Config-driven, initial value 1-3.
  discoveryTopK: Number(process.env.DISCOVERY_TOP_K ?? 2),

  repoRoot: REPO_ROOT
};

export default config;