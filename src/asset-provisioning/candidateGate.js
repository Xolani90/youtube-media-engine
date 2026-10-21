/**
 * Deterministic pre-download screen for stock-asset search hits (no ML, no network, no cost).
 *
 * Scope: Asset Provisioning only. It narrows WHICH of the hits the provider already received
 * is downloaded. It is not a rights, factual or safety verification: every accepted asset is
 * still persisted UNVERIFIED and goes through the unchanged rights gate. The screen can only
 * reject candidates, never promote one.
 *
 * Rules (a hit is rejected by the first that applies):
 *  1. duplicate_of_attached_asset  - its page URL is already attached to this content version.
 *  2. branded_or_ui_capture_tag:T  - its tags contain a brand/UI-capture term (logo, screenshot,
 *     browser, google, ...) that neither the scene text nor the query mentions. Such images are
 *     almost never what narration needs, and Pixabay's licence warns that recognisable marks may
 *     carry extra rights.
 *  3. no_tag_overlap_with_scene    - it has tags, and none shares a word with the query or the
 *     scene narration. (Weak by design: the provider already matched the query; this only removes
 *     hits that matched on something other than their subject.)
 * A hit with no tags passes rules 2-3 (nothing to judge) and is therefore not silently dropped.
 */
import { tokens } from './scenePlan.js';

export const BRANDED_UI_CAPTURE_TAGS = Object.freeze([
  'logo', 'logos', 'brand', 'branding', 'trademark', 'screenshot', 'screen shot', 'screen capture',
  'browser', 'web browser', 'website', 'web page', 'webpage', 'homepage', 'home page', 'search engine',
  'google', 'chrome', 'google chrome', 'facebook', 'twitter', 'instagram', 'youtube', 'tiktok',
  'microsoft', 'windows', 'apple', 'iphone', 'android', 'app icon', 'icon', 'icons', 'social media icons'
]);

export function resolveCandidateGateEnabled(env = process.env) {
  const raw = env.SCENE_CANDIDATE_GATE;
  if (raw === undefined || raw === null) return true;
  const v = String(raw).trim().toLowerCase();
  if (v === 'off' || v === '0' || v === 'false') return false;
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  throw new Error(`SCENE_CANDIDATE_GATE must be one of on, off (got "${v}")`);
}

export function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  return String(tags ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * @param {{sceneText?: string, query?: string, excludeOrigins?: Iterable<string>}} ctx
 * @returns {(hit: {id?: any, pageURL?: string|null, tags?: string|string[]}) => {accept: boolean, reason: string|null}}
 */
export function buildHitScreen({ sceneText = '', query = '', excludeOrigins = [] } = {}) {
  const exclude = new Set(excludeOrigins);
  const context = new Set([...tokens(sceneText), ...tokens(query)]);
  const contextText = `${sceneText} ${query}`.toLowerCase();
  const deny = new Set(BRANDED_UI_CAPTURE_TAGS);
  return (hit) => {
    if (hit?.pageURL && exclude.has(hit.pageURL)) return { accept: false, reason: 'duplicate_of_attached_asset' };
    const tags = parseTags(hit?.tags);
    for (const tag of tags) {
      if (deny.has(tag) && !contextText.includes(tag)) return { accept: false, reason: `branded_or_ui_capture_tag:${tag}` };
    }
    if (tags.length > 0 && context.size > 0) {
      const tagTokens = new Set(tags.flatMap((t) => tokens(t)));
      if (![...context].some((w) => tagTokens.has(w))) return { accept: false, reason: 'no_tag_overlap_with_scene' };
    }
    return { accept: true, reason: null };
  };
}
