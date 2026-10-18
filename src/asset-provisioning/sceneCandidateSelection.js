/**
 * Per-scene candidate selection for multi-scene Asset Provisioning (EXPERIMENTAL,
 * proof-only until the owner approves integration). Pure and deterministic.
 *
 * Each scene owns its OWN candidate pool (results of that scene's query). The
 * ranker scores pool images against that scene's narration text, and the
 * winner is chosen from the scene's own pool only. There is NO global
 * one-to-one assignment, so an unrelated image can never be pulled into a scene
 * just to avoid a repeat. Narration-aligned spans are untouched: the chosen
 * asset is persisted with the same span usage_context as before.
 *
 * Reuse: if a scene's best candidate is the image already chosen for the
 * IMMEDIATELY PREVIOUS scene, it is kept (the caller's duplicate guard then
 * folds the scene into the previous one, i.e. the same image legitimately
 * covers both adjacent spans). A candidate already used by a non-adjacent
 * earlier scene is skipped in favour of the next best.
 *
 * Fallback: when scores are missing/invalid for a scene (ranker failed, image
 * undecodable) the scene keeps today's behaviour, its first-hit candidate.
 * Ranking is a signal only; it is not a rights, factual or safety check, and
 * every chosen asset still goes through the unchanged rights verification.
 *
 * Near-tie diagnostics (report only, never changes a pick): each scored scene also
 * records runnerUp / runnerUpScore, margin (best minus runner-up), spread (best
 * minus worst score) and nearTie (spread > 0 and margin <= nearTieFraction * spread).
 * nearTieFraction is a diagnostic flag threshold, not a selection rule; it is not
 * calibrated, and is meant to show how fragile a pick was until real data justifies
 * an actual tie rule.
 *
 * Diagnostics describe the decision actually made, so they are computed over the
 * ELIGIBLE candidates only: scored candidates that were not used by a non-adjacent
 * earlier scene. A candidate skipped by the reuse rule is not a runner-up, is not part
 * of the margin or spread, and cannot make a pick look like a near-tie. `skippedUsed`
 * is true when one or more higher-scoring candidates were skipped for that reason, so a
 * pick forced by the reuse rule can be told apart from a genuinely close choice. If every
 * scored candidate was used earlier, none is excluded (the policy falls back to the top
 * score) and the diagnostics cover all scored candidates with skippedUsed false.
 *
 * Exact ties: nearTie is relative to the pool spread. When the eligible scores are all
 * identical (spread 0) the ranking carries no signal at all, the pick falls to the lowest
 * index, and nearTie stays false by design (pinned by scene-candidate-near-tie.test.js).
 * That state is still visible as margin 0 with spread 0.
 */
export const NEAR_TIE_FRACTION = 0.1;

export function selectPerScene({ scenes, pools, scoreFor, nearTieFraction = NEAR_TIE_FRACTION }) {
  const chosen = [];
  scenes.forEach((scene, si) => {
    const pool = pools[si] ?? [];
    if (pool.length === 0) { chosen.push({ scene: si, pick: null, reason: 'empty_pool' }); return; }
    const scored = pool
      .map((c, ci) => ({ ci, id: c.id, score: scoreFor(si, c) }))
      .filter((e) => Number.isFinite(e.score));
    if (scored.length === 0) {
      chosen.push({ scene: si, pick: pool[0].id, ci: 0, reason: 'unscored_first_hit', score: null, firstHitScore: null });
      return;
    }
    const usedEarlier = new Set(chosen.slice(0, Math.max(0, si - 1)).map((c) => c.pick).filter(Boolean));
    const order = [...scored].sort((a, b) => (b.score - a.score) || (a.ci - b.ci));
    const unused = order.filter((e) => !usedEarlier.has(e.id));
    // Eligible = candidates the reuse rule allows; when none is left the policy keeps the
    // top score, so every scored candidate is eligible.
    const eligible = unused.length > 0 ? unused : order;
    const best = eligible[0];
    const first = scored.find((e) => e.ci === 0) ?? null;
    const runnerUp = eligible[1] ?? null;
    const spread = best.score - eligible[eligible.length - 1].score;
    const margin = runnerUp ? round6(best.score - runnerUp.score) : null;
    chosen.push({
      scene: si, pick: best.id, ci: best.ci, score: best.score,
      firstHitScore: first ? first.score : null,
      reason: best.ci === 0 ? 'first_hit_is_best' : 'ranked_over_first_hit',
      reusesPrevious: si > 0 && chosen[si - 1]?.pick === best.id,
      skippedUsed: unused.length > 0 && order[0].ci !== best.ci,
      runnerUp: runnerUp ? runnerUp.id : null,
      runnerUpScore: runnerUp ? runnerUp.score : null,
      margin,
      spread: round6(spread),
      nearTie: margin !== null && spread > 0 && margin <= nearTieFraction * spread
    });
  });
  return chosen;
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }
