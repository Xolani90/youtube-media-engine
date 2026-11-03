import { tableExists } from './annotate.js';
import { FEED_LABEL } from './constants.js';
import { classifySourceFailure } from './failureClass.js';

/** Read-only helpers shared by the diagnostic scripts. `all(sql, params)` must be SELECT-capable. */
export function readFeedAnnotations(all) {
  if (!tableExists(all)) return [];
  return all(`SELECT feed_url, item_key, item_guid, item_link, title, published_at_feed, annotated_at,
                     blocked_source_id, blocked_source_url, blocked_http_status, blocked_error_text, failure_class
              FROM publisher_feed_items ORDER BY blocked_source_url, item_key`, []);
}

export function formatFailureLines(notes) {
  const c = classifySourceFailure(notes);
  const lines = [`failure_class=${c.failureClass}`, `http_status=${c.httpStatus ?? 'NONE'}`, `retrieval_error=${c.originalError ?? 'NONE'}`];
  if (c.detail) lines.push(`failure_detail=${c.detail}`);
  return lines;
}

export function formatAnnotationBlock(a) {
  return [
    '[publisher-feed-metadata]',
    `label=${FEED_LABEL}`,
    `blocked_source=${a.blocked_source_id}`,
    `publisher_url=${a.blocked_source_url}`,
    `failure_class=${a.failure_class}`,
    `http_status=${a.blocked_http_status ?? 'NONE'}`,
    `feed_url=${a.feed_url}`,
    `feed_item=${a.item_guid ?? a.item_key}`,
    `feed_published_at=${a.published_at_feed ?? 'UNKNOWN'}`,
    `annotated_at=${a.annotated_at}`
  ].join('\n');
}
