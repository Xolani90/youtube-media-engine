/**
 * D14 — resolves the authoritative core_question for a Brief via the
 * existing deterministic relationship:
 *
 *   research_projects.opportunity_id -> opportunities.id
 *     -> opportunities.opportunity_proposition (JSON) -> core_question
 *
 * This is the same Discovery-originated value Research already consumes
 * (see src/research/pipeline.js: `proposition.core_question`). Per the
 * accepted D14 clarification, this indirect-but-stable join is the
 * authoritative source — no `research_projects.core_question` column is
 * required or introduced.
 *
 * Only whitespace-level normalization is applied (trim + collapse internal
 * whitespace runs). This function performs no semantic rewriting; it is a
 * deterministic copy, never an LLM call.
 *
 * @param {import('../storage/StorageDriver.js').StorageDriver} storage
 * @param {string} researchProjectId
 * @returns {{ok: true, coreQuestion: string, researchProject: object, opportunity: object} | {ok: false, reason: string}}
 */
export function resolveAuthoritativeCoreQuestion(storage, researchProjectId) {
  const researchProject = storage.get('SELECT * FROM research_projects WHERE id = ?', [researchProjectId]);
  if (!researchProject) {
    return { ok: false, reason: 'RESEARCH_PROJECT_NOT_FOUND' };
  }

  const opportunity = storage.get('SELECT * FROM opportunities WHERE id = ?', [researchProject.opportunity_id]);
  if (!opportunity) {
    // research_projects.opportunity_id is NOT NULL and FK-referenced, so
    // this is unreachable under foreign_keys=ON, but Brief must not assume
    // that pragma is enabled by every possible storage driver/config.
    return { ok: false, reason: 'OPPORTUNITY_NOT_FOUND' };
  }

  let proposition;
  try {
    proposition = JSON.parse(opportunity.opportunity_proposition);
  } catch {
    return { ok: false, reason: 'UNPARSEABLE_OPPORTUNITY_PROPOSITION' };
  }

  const raw = proposition?.core_question;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'MISSING_CORE_QUESTION' };
  }

  const coreQuestion = raw.trim().replace(/\s+/g, ' ');
  return { ok: true, coreQuestion, researchProject, opportunity };
}

/**
 * Deterministic equality check used to validate that a Brief's persisted
 * core_question matches the authoritative value up to the permitted
 * whitespace normalization (Brief Specification §13).
 */
export function coreQuestionMatches(candidate, authoritative) {
  if (typeof candidate !== 'string') return false;
  return candidate.trim().replace(/\s+/g, ' ') === authoritative;
}