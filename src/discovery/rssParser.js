/**
 * A minimal, dependency-free RSS 2.0 / Atom parser. This is intentionally
 * not a full-spec XML parser — it extracts the handful of fields discovery
 * needs (title, link, description, publish date, guid) via targeted regex
 * matching, which is sufficient for the well-formed feeds this is expected
 * to consume and keeps R0 (no added dependency, no network beyond the feed
 * fetch itself).
 */

function decodeEntities(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : null;
}

function extractAtomLink(block) {
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  return m ? m[1] : null;
}

/**
 * Parses raw RSS/Atom XML text into an array of raw items:
 * { title, link, description, pubDate, guid }
 */
export function parseFeed(xml) {
  if (!xml || typeof xml !== 'string') return [];

  const items = [];
  const rssItemRe = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = rssItemRe.exec(xml)) !== null) {
    const block = match[1];
    items.push({
      title: extractTag(block, 'title'),
      link: extractTag(block, 'link'),
      description: extractTag(block, 'description'),
      pubDate: extractTag(block, 'pubDate') || extractTag(block, 'dc:date'),
      guid: extractTag(block, 'guid')
    });
  }

  if (items.length === 0) {
    // Try Atom <entry> format.
    const atomEntryRe = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    while ((match = atomEntryRe.exec(xml)) !== null) {
      const block = match[1];
      items.push({
        title: extractTag(block, 'title'),
        link: extractAtomLink(block),
        description: extractTag(block, 'summary') || extractTag(block, 'content'),
        pubDate: extractTag(block, 'updated') || extractTag(block, 'published'),
        guid: extractTag(block, 'id')
      });
    }
  }

  return items.filter((i) => i.title || i.link);
}

export default parseFeed;
