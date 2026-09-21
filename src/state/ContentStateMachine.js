export const STATES = Object.freeze([
  'DISCOVERED',
  'SCORED',
  'SELECTED',
  'RESEARCHING',
  'RESEARCH_COMPLETE',
  'BRIEF_CREATED',
  'SCRIPT_DRAFT',
  'FACT_CHECK',
  'ORIGINALITY_CHECK',
  'QUALITY_GATE',
  'PRODUCTION_READY',
  'PRODUCED',
  // ADR-0032: Gate 2 / FINAL_COMPLIANCE sits between PRODUCED and PUBLISHED.
  // Because canTransition() only permits the immediately-next state, this
  // placement alone makes PRODUCED -> PUBLISHED illegal (no Gate-2-bypassing
  // path), FINAL_COMPLIANCE -> PUBLISHED the successful-publication step,
  // and both FINAL_COMPLIANCE -> FINAL_COMPLIANCE (same-state) and
  // FINAL_COMPLIANCE -> PRODUCED (backward) illegal.
  'FINAL_COMPLIANCE',
  'PUBLISHED',
  'ANALYZING',
  'LEARNED'
]);

export const FAILURE_STATES = Object.freeze(['REJECTED', 'BLOCKED', 'NEEDS_REVIEW', 'FAILED']);

// Only forward transitions along the pipeline, or into a failure state
// from any non-terminal state. No state may skip ahead (spec §14: "No
// content should silently jump from discovery to publication").
const ORDER = new Map(STATES.map((s, i) => [s, i]));

export function canTransition(from, to) {
  if (FAILURE_STATES.includes(to)) return true; // any state can fail
  if (!ORDER.has(from) || !ORDER.has(to)) return false;
  return ORDER.get(to) === ORDER.get(from) + 1;
}

export class InvalidTransitionError extends Error {}

export function transition(from, to) {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(`Illegal transition: ${from} -> ${to}`);
  }
  return to;
}
