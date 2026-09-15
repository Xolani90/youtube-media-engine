/**
 * Builds the provider-neutral publication request from the existing
 * content model (content_brief / script / media_artifact) — the sole
 * source of truth for metadata (Publication v1 spec §14). No LLM is
 * invoked here and no field is invented: every field is either copied
 * verbatim from an existing record or explicitly left null/default when
 * the source data doesn't have it. A provider adapter (see
 * ./youtube/YouTubeAdapter.js) is responsible for translating this into
 * its own provider-specific request shape — this module knows nothing
 * about YouTube, or any other provider.
 *
 * `requestedPublishAt` is carried through as a plain value (or null)
 * purely so a provider adapter *may* use it if that provider supports
 * scheduling (Publication v1 spec §15) — the core does not interpret,
 * validate, or default it, and does not itself add a new lifecycle
 * concept for scheduling.
 *
 * @param {object} args
 * @param {object} args.contentVersion
 * @param {object} args.script
 * @param {object} args.contentBrief
 * @param {object} args.mediaArtifact
 * @param {string|null} [args.requestedPublishAt] - ISO 8601 timestamp, or null for "publish now"
 */
export function buildPublicationRequest({ contentVersion, script, contentBrief, mediaArtifact, requestedPublishAt = null }) {
  const title = contentBrief.working_title ?? `Untitled (${contentVersion.id})`;
  // No separate "video description" field exists on content_briefs yet;
  // viewer_promise is the closest existing authoritative field
  // describing what the video delivers to a viewer. Falls back to an
  // empty string rather than fabricating copy.
  const description = contentBrief.viewer_promise ?? '';

  return {
    contentVersionId: contentVersion.id,
    scriptId: script.id,
    contentBriefId: contentBrief.id,
    mediaArtifactId: mediaArtifact.id,
    title,
    description,
    mediaFilePath: mediaArtifact.artifact_path,
    mediaChecksum: mediaArtifact.artifact_checksum,
    durationSeconds: mediaArtifact.duration_seconds,
    requestedPublishAt
  };
}
