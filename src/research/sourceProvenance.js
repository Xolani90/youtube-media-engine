export const SOURCE_PROVENANCE_SCHEMA = 'source_provenance/v1';

/**
 * Structured provenance stored in the existing sources.notes column (no
 * schema change). Discovery publishedAt is provider-reported and unverified;
 * it is labelled as such and never treated as authoritative publication data.
 */
export function buildSourceProvenance(acquired, { retrievedAt = new Date().toISOString() } = {}) {
  return JSON.stringify({
    schema: SOURCE_PROVENANCE_SCHEMA,
    url: acquired.url,
    discovery: {
      title: acquired.title ?? null,
      snippet: acquired.snippet ?? null,
      publishedAt: acquired.publishedAt ?? null,
      ...(acquired.discoveryQueryType ? { discovery_query_type: acquired.discoveryQueryType } : {}),
      publishedAtProvenance: acquired.publishedAt ? 'provider_reported_unverified' : null
    },
    retrieval: {
      retrievedAt,
      method: acquired.retrievalMethod ?? 'plain',
      status: acquired.status,
      error: acquired.error ?? null,
      fallback: acquired.fallback ?? null,
      contentAssessment: acquired.contentAssessment ?? null
    }
  });
}

export function parseSourceProvenance(notes) {
  try {
    const p = JSON.parse(notes);
    return p && p.schema === SOURCE_PROVENANCE_SCHEMA ? p : null;
  } catch {
    return null;
  }
}
