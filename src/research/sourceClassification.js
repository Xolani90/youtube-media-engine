import { SOURCE_ROLE, SOURCE_QUALITY, RETRIEVAL_STATUS } from './constants.js';

/**
 * Deterministic-first source role classification (v0.3 S5 / v0.4).
 * Role and quality are independent dimensions — this function decides
 * ONLY role.
 *
 * Domain diversity is an independence heuristic, not proof of
 * independence (v0.4): a caller-supplied domain->role map is the
 * deterministic mechanism (e.g. the opportunity's own subject/company
 * domain is `primary_authoritative`, known aggregators/wire-copy domains
 * are `syndicated`). Everything else defaults to `independent_reporting`.
 * An LLM fallback is intentionally NOT wired in by default — deterministic
 * classification is not "genuinely ambiguous" for the common case, and no
 * LLM call should be spent where a domain lookup suffices; a genuinely
 * ambiguous case can be escalated by the caller via `ambiguous: true`.
 */
export function classifySourceRole(url, { authoritativeDomains = [], syndicatedDomains = [] } = {}) {
  const domain = extractDomain(url);
  if (domain && authoritativeDomains.includes(domain)) {
    return { role: SOURCE_ROLE.PRIMARY_AUTHORITATIVE, ambiguous: false };
  }
  if (domain && syndicatedDomains.includes(domain)) {
    return { role: SOURCE_ROLE.SYNDICATED, ambiguous: false };
  }
  if (!domain) {
    // Malformed/unparseable URL: genuinely ambiguous, deterministic
    // classification cannot proceed safely — flagged rather than guessed.
    return { role: SOURCE_ROLE.INDEPENDENT_REPORTING, ambiguous: true };
  }
  return { role: SOURCE_ROLE.INDEPENDENT_REPORTING, ambiguous: false };
}

/**
 * Deterministic source quality tiering (v0.3 S3/S10). A source that failed
 * retrieval or extraction is always UNUSABLE regardless of role. Otherwise
 * quality is a config-driven heuristic keyed by role, same deterministic-
 * first pattern as role classification.
 */
export function classifySourceQuality(retrievalStatus, role) {
  if (retrievalStatus !== RETRIEVAL_STATUS.SUCCESS) {
    return SOURCE_QUALITY.UNUSABLE;
  }
  if (role === SOURCE_ROLE.PRIMARY_AUTHORITATIVE) return SOURCE_QUALITY.HIGH;
  if (role === SOURCE_ROLE.SYNDICATED) return SOURCE_QUALITY.LOW;
  return SOURCE_QUALITY.MEDIUM; // independent_reporting default
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}