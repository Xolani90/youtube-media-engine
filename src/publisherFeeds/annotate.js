import crypto from 'node:crypto';
import { FEED_ORIGIN, FAILURE_CLASS, FAILURE_UNCLASSIFIED, MAX_SUMMARY_CHARS } from './constants.js';
import { classifySourceFailure } from './failureClass.js';
import { normalizePublisherUrl, isAuthorizedHost } from './urlMatch.js';

/**
 * Blocked-source annotation (Phase 1). Reads FAILED `sources` rows (SELECT
 * only) and records matching publisher feed items in `publisher_feed_items`.
 * This module is the ONLY writer of that table and writes nothing else.
 */

export function tableExists(all) {
  return all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'publisher_feed_items'", []).length === 1;
}

/** Stable dedup key: the feed's guid when present, else the normalized item link. */
export function itemKeyOf(item) {
  const guid = typeof item?.guid === 'string' ? item.guid.trim() : '';
  if (guid) return `guid:${guid}`;
  const n = normalizePublisherUrl(item?.link);
  return n ? `url:${n}` : null;
}

export function buildFeedIndex(items, feed) {
  const byUrl = new Map();
  let droppedOffHost = 0;
  let droppedNoKey = 0;
  for (const item of items) {
    if (itemKeyOf(item) === null) { droppedNoKey += 1; continue; }
    if (!item?.link || !isAuthorizedHost(item.link, feed.hosts)) { droppedOffHost += 1; continue; }
    const keys = new Set([normalizePublisherUrl(item.link)]);
    if (item.guid && isAuthorizedHost(item.guid, feed.hosts)) keys.add(normalizePublisherUrl(item.guid));
    for (const k of keys) {
      if (!k) continue;
      if (!byUrl.has(k)) byUrl.set(k, []);
      byUrl.get(k).push(item);
    }
  }
  return { byUrl, droppedOffHost, droppedNoKey };
}

/** Pure planning step: no I/O. */
export function planAnnotations({ sourceRows, feed, feedResult, annotatedAt }) {
  const index = buildFeedIndex(feedResult.items, feed);
  const entries = [];
  const rows = [];
  for (const s of sourceRows) {
    if (s.retrieval_status !== 'FAILED') continue;
    const c = classifySourceFailure(s.notes);
    const entry = {
      sourceId: s.id, url: s.url, failureClass: c.failureClass, httpStatus: c.httpStatus,
      originalError: c.originalError, detail: c.detail, matchedItemKeys: [], skipped: null
    };
    entries.push(entry);
    if (!isAuthorizedHost(s.url, feed.hosts)) { entry.skipped = 'host_not_in_authorized_feed'; continue; }
    // Only an established failure class may become an annotation (migration 0032 CHECK). An unclassified
    // failure stays visible in the summary but is never recorded.
    if (c.failureClass === FAILURE_UNCLASSIFIED) { entry.skipped = 'failure_unclassified'; continue; }
    const norm = normalizePublisherUrl(s.url);
    const hits = norm ? (index.byUrl.get(norm) ?? []) : [];
    const seen = new Set();
    for (const item of hits) {
      const itemKey = itemKeyOf(item);
      if (seen.has(itemKey)) continue;
      seen.add(itemKey);
      entry.matchedItemKeys.push(itemKey);
      const summary = typeof item.description === 'string' ? item.description.slice(0, MAX_SUMMARY_CHARS) : null;
      rows.push({
        feed_url: feedResult.feedUrl, item_key: itemKey, item_guid: item.guid ?? null, item_link: item.link,
        item_url_normalized: normalizePublisherUrl(item.link), title: item.title ?? null,
        summary_text: summary,
        summary_sha256: typeof item.description === 'string' ? crypto.createHash('sha256').update(item.description).digest('hex') : null,
        published_at_feed: item.pubDate ?? null, feed_fetched_at: feedResult.fetchedAt, annotated_at: annotatedAt,
        blocked_source_id: s.id, blocked_source_url: s.url, research_project_id: s.research_project_id ?? null,
        blocked_retrieval_status: s.retrieval_status, blocked_retrieval_method: c.retrievalMethod,
        blocked_error_text: c.originalError, blocked_http_status: c.httpStatus, failure_class: c.failureClass
      });
    }
    if (entry.matchedItemKeys.length === 0) entry.skipped = 'no_matching_feed_item';
  }
  return { entries, rows, droppedOffHost: index.droppedOffHost, droppedNoKey: index.droppedNoKey };
}

const INSERT_SQL = `
  INSERT INTO publisher_feed_items (
    id, feed_url, item_key, item_guid, item_link, item_url_normalized, title, summary_text, summary_sha256,
    published_at_feed, feed_fetched_at, annotated_at, blocked_source_id, blocked_source_url, research_project_id,
    blocked_retrieval_status, blocked_retrieval_method, blocked_error_text, blocked_http_status, failure_class, origin, evidentiary
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  ON CONFLICT (feed_url, item_key, blocked_source_id) DO NOTHING`;

/**
 * @param {{all: Function, run?: Function, transaction?: Function}} db - read access, plus write access unless dryRun
 */
export function annotateBlockedSources({ db, feed, feedResult, dryRun = false, now = () => new Date().toISOString() }) {
  const sourceRows = db.all(
    "SELECT id, research_project_id, url, retrieval_status, notes FROM sources WHERE retrieval_status = 'FAILED' ORDER BY retrieved_at, id", []);
  const plan = planAnnotations({ sourceRows, feed, feedResult, annotatedAt: now() });
  const byFailureClass = Object.fromEntries([...Object.values(FAILURE_CLASS), FAILURE_UNCLASSIFIED].map((k) => [k, 0]));
  for (const e of plan.entries) byFailureClass[e.failureClass] += 1;
  const summary = {
    dryRun, blockedSourcesConsidered: plan.entries.length, byFailureClass,
    sourcesWithMatch: plan.entries.filter((e) => e.matchedItemKeys.length > 0).length,
    plannedRows: plan.rows.length, inserted: 0, duplicates: 0,
    feedItemsParsed: feedResult.items.length, feedItemsOffHost: plan.droppedOffHost, feedItemsDroppedNoKey: plan.droppedNoKey, entries: plan.entries
  };
  if (dryRun || plan.rows.length === 0) return summary;
  db.transaction(() => {
    for (const r of plan.rows) {
      const res = db.run(INSERT_SQL, [
        crypto.randomUUID(), r.feed_url, r.item_key, r.item_guid, r.item_link, r.item_url_normalized, r.title, r.summary_text,
        r.summary_sha256, r.published_at_feed, r.feed_fetched_at, r.annotated_at, r.blocked_source_id, r.blocked_source_url,
        r.research_project_id, r.blocked_retrieval_status, r.blocked_retrieval_method, r.blocked_error_text,
        r.blocked_http_status, r.failure_class, FEED_ORIGIN]);
      if (res.changes === 1) summary.inserted += 1; else summary.duplicates += 1;
    }
  });
  return summary;
}
