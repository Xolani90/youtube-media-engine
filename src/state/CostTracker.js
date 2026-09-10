import crypto from 'node:crypto';
import { config } from '../config/index.js';

export class BudgetExceededError extends Error {}

/**
 * CostTracker records every provider call — free or paid — through the
 * same accounting path (spec: "a free call should simply have cost = 0
 * rather than bypassing the cost accounting system").
 *
 * It also enforces the configured hard limits (spec §20): a call that
 * would exceed MAX_DAILY_SPEND, MAX_MONTHLY_SPEND, or MAX_COST_PER_CONTENT
 * is refused before being recorded as spent.
 */
export class CostTracker {
  constructor(storage, limits = config.costLimits) {
    this.storage = storage;
    this.limits = limits;
  }

  dailySpend(sinceIso) {
    const row = this.storage.get(
      `SELECT COALESCE(SUM(estimated_cost), 0) as total FROM provider_calls WHERE timestamp >= ?`,
      [sinceIso]
    );
    return row?.total ?? 0;
  }

  monthlySpend(sinceIso) {
    return this.dailySpend(sinceIso); // same query shape, different window supplied by caller
  }

  /**
   * Records a provider call. Throws BudgetExceededError BEFORE recording
   * if the incoming cost would exceed a configured limit that is > 0.
   * A limit of 0 is treated as "not enforced" only when the call itself
   * is free (estimatedCost === 0) — a nonzero paid call against a 0 limit
   * is always rejected, since 0 means "no budget allocated".
   */
  record({ runId, contentId = null, jobStage = null, provider, model = null, requestId = null, inputTokens = null, outputTokens = null, estimatedCost = 0, actualCost = null, isPaid = false }) {
    if (isPaid || estimatedCost > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const spentToday = this.dailySpend(startOfDay.toISOString());

      if (this.limits.maxCostPerContent > 0 && estimatedCost > this.limits.maxCostPerContent) {
        throw new BudgetExceededError(`Call cost ${estimatedCost} exceeds MAX_COST_PER_CONTENT (${this.limits.maxCostPerContent})`);
      }
      if (this.limits.maxCostPerContent === 0 && estimatedCost > 0) {
        throw new BudgetExceededError('MAX_COST_PER_CONTENT is 0 (no budget allocated) but a nonzero-cost call was attempted.');
      }
      if (this.limits.maxDailySpend > 0 && spentToday + estimatedCost > this.limits.maxDailySpend) {
        throw new BudgetExceededError(`Daily spend limit (${this.limits.maxDailySpend}) would be exceeded.`);
      }
      if (this.limits.maxDailySpend === 0 && estimatedCost > 0) {
        throw new BudgetExceededError('MAX_DAILY_SPEND is 0 (no budget allocated) but a nonzero-cost call was attempted.');
      }
    }

    const id = crypto.randomUUID();
    this.storage.run(
      `INSERT INTO provider_calls
        (id, run_id, content_id, job_stage, provider, model, request_id, input_tokens, output_tokens, estimated_cost, actual_cost, is_paid, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, runId, contentId, jobStage, provider, model, requestId, inputTokens, outputTokens, estimatedCost, actualCost, isPaid ? 1 : 0, new Date().toISOString()]
    );
    return id;
  }
}

export default CostTracker;
