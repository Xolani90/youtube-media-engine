/**
 * LLMProvider is the abstract interface every model provider must implement.
 * Business logic (scoring, research, script generation, etc.) must depend
 * ONLY on this interface, never on a specific provider's SDK or API shape.
 *
 * Providers are pluggable candidates (see ADR-0001) — Gemini/Groq/OpenRouter
 * are initial implementations, not architectural commitments.
 */
export class LLMProvider {
  /** Unique id, referenced in config.llmProviderPriority. */
  get id() {
    throw new Error('not implemented');
  }

  /** Whether this provider is a paid provider (never used unless explicitly enabled). */
  get isPaid() {
    return false;
  }

  /** Cheap check for whether this provider is currently usable (keys present, quota not known-exhausted). */
  async healthCheck() {
    throw new Error('not implemented');
  }

  /**
   * Perform a completion. Must return:
   * { text, model, requestId, inputTokens, outputTokens, estimatedCost, isPaid }
   */
  async complete({ prompt, system, maxTokens }) {
    throw new Error('not implemented');
  }
}

export default LLMProvider;
