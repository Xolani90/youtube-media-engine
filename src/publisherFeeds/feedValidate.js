import { parsePublisherUrl } from './urlMatch.js';

/**
 * Strict, fail-closed parsing of a fetched publisher feed. This module REPLACES
 * the shared lenient Discovery parser (src/discovery/rssParser.js, untouched)
 * for publisher-feed annotation: the document is first checked for XML
 * well-formedness and then the items are extracted from the checked tree. If
 * ANY check fails the whole feed is rejected and no items are returned, so a
 * malformed document can never yield a partial set of annotations.
 *
 * WHAT IS CHECKED (a deliberately small, self-contained XML 1.0 subset; no
 * dependency was added: the project has no direct XML parser dependency, and
 * `sax` is only present transitively via duck-duck-scrape):
 *   - characters: no NUL/control characters, no lone surrogates, no U+FFFE/FFFF
 *   - XML declaration only at the very start; version 1.0; declared encoding,
 *     if any, must be UTF-8 (the client decodes UTF-8)
 *   - comments (no `--` inside), CDATA (inside the root only), processing
 *     instructions (target must not be `xml`), each must terminate
 *   - DOCTYPE and every other `<!...>` declaration are refused (no entity
 *     definitions, no DTD): only the five predefined entities and valid
 *     numeric character references are allowed; any other `&name;`, a bare
 *     `&`, and `]]>` in text are errors
 *   - start tags: valid names, whitespace-separated attributes, quoted
 *     values without `<`, valid entity references in values, NO duplicate
 *     attribute names
 *   - tag balance and nesting, exactly one root, nothing but whitespace,
 *     comments and PIs after the root closes, nesting depth <= MAX_DEPTH
 *   - work bounds, counted WHILE parsing (before an element object is allocated): at most MAX_ELEMENTS
 *     elements and MAX_ITEMS items/entries; independent of the response byte cap in feedClient.js
 *   - structure: root `rss` with exactly one `channel` whose direct `item`
 *     children are the items; root `feed` (Atom) whose direct `entry`
 *     children are the items; root `rdf:RDF` whose direct `item` children are
 *     the items. An unprefixed `item`/`entry` anywhere else is an error.
 *   - items: RSS/RDF item has exactly ONE direct `link` child whose text is a
 *     usable absolute http(s) URL (see urlMatch.js) and has no child
 *     elements; at most one `guid`, not empty. Atom entry has exactly ONE
 *     direct `link` with rel absent or `alternate` and a usable absolute
 *     `href`; links with other rel values (self, enclosure, ...) are ignored
 *     and never used as the item link.
 *
 * KNOWN LIMITATIONS (this is NOT a complete XML validator and is not claimed
 * to be): XML Namespaces are not enforced (undeclared prefixes are accepted);
 * no schema/RSS-profile validation beyond the structure above; `xml:base`
 * and relative links are not resolved (relative links are rejected);
 * element/attribute names are limited to the BMP; attribute-value whitespace
 * normalization and external entities do not apply (DTDs are refused);
 * an Atom entry with several `alternate` links is rejected as ambiguous; HTML
 * entities such as `&nbsp;` are undefined in XML and are rejected, so a feed
 * that uses them fails closed.
 */
export const MAX_DEPTH = 100;
// Parser work bounds. The response byte cap (8 MiB, feedClient.js) does not bound the tree: an 8 MiB
// document of `<a/>` would otherwise allocate about two million element objects. The real OpenAI feed is
// about 0.8 MB with about 1.3k items, so these leave roughly 7x headroom on items and far more on elements
// (10,000 items of ~600 bytes still fit under the byte cap) while capping the tree at tens of MB.
export const MAX_ELEMENTS = 200000;
export const MAX_ITEMS = 10000;

const NAME_START = ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NAME_RE = new RegExp(`[${NAME_START}][${NAME_CHAR}]*`, 'y');
const BAD_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const WS_RE = /[ \t\r\n]*/y;
const XML_DECL_RE = /^<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/;
const PREDEFINED = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const REF_RE = /&(?:(lt|gt|amp|quot|apos)|#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6}));/y;

class XmlError extends Error {}
const bad = (detail) => { throw new XmlError(detail); };

function isXmlChar(cp) {
  return cp === 0x9 || cp === 0xA || cp === 0xD || (cp >= 0x20 && cp <= 0xD7FF) || (cp >= 0xE000 && cp <= 0xFFFD) || (cp >= 0x10000 && cp <= 0x10FFFF);
}

/** Decodes the five predefined entities and numeric references; any other `&` is an error. */
function decodeRefs(str) {
  if (!str.includes('&')) return str;
  let out = '';
  let last = 0;
  for (let i = str.indexOf('&'); i !== -1; i = str.indexOf('&', last)) {
    out += str.slice(last, i);
    REF_RE.lastIndex = i;
    const m = REF_RE.exec(str);
    if (!m) bad('invalid_or_undefined_entity_reference');
    if (m[1]) out += PREDEFINED[m[1]];
    else {
      const cp = m[2] !== undefined ? Number.parseInt(m[2], 10) : Number.parseInt(m[3], 16);
      if (!isXmlChar(cp)) bad('invalid_character_reference');
      out += String.fromCodePoint(cp);
    }
    last = REF_RE.lastIndex;
  }
  return out + str.slice(last);
}

function readName(s, pos) {
  NAME_RE.lastIndex = pos;
  const m = NAME_RE.exec(s);
  return m ? m[0] : null;
}

function skipWs(s, pos) {
  WS_RE.lastIndex = pos;
  WS_RE.exec(s);
  return WS_RE.lastIndex;
}

const textOf = (el) => {
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? c : textOf(c);
  return out;
};
const elementsNamed = (el, name) => el.children.filter((c) => typeof c !== 'string' && c.name === name);
const hasChildElements = (el) => el.children.some((c) => typeof c !== 'string');

/** Parses one XML document into a tree. Throws XmlError(detail) on any well-formedness problem. */
function parseXml(input) {
  let s = input;
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  if (BAD_CHARS_RE.test(s)) bad('illegal_character');
  let pos = 0;
  if (s.startsWith('<?xml') && /^<\?xml[ \t\r\n?]/.test(s)) {
    const m = XML_DECL_RE.exec(s);
    if (!m) bad('malformed_xml_declaration');
    const enc = m[1] ?? m[2];
    if (enc && !/^utf-8$/i.test(enc)) bad('declared_encoding_not_utf8');
    pos = m[0].length;
  }
  const stack = [];
  let root = null;
  let rootClosed = false;
  let elementCount = 0;
  let itemCount = 0;
  const len = s.length;
  while (pos < len) {
    if (s[pos] !== '<') {
      let next = s.indexOf('<', pos);
      if (next === -1) next = len;
      const text = s.slice(pos, next);
      if (stack.length === 0) { if (text.trim() !== '') bad('text_outside_root'); } else {
        if (text.includes(']]>')) bad('cdata_end_in_text');
        stack[stack.length - 1].children.push(decodeRefs(text));
      }
      pos = next;
      continue;
    }
    if (s.startsWith('<!--', pos)) {
      const end = s.indexOf('-->', pos + 4);
      if (end === -1) bad('unterminated_comment');
      const body = s.slice(pos + 4, end);
      if (body.includes('--') || body.endsWith('-')) bad('malformed_comment');
      pos = end + 3;
    } else if (s.startsWith('<![CDATA[', pos)) {
      if (stack.length === 0) bad('cdata_outside_root');
      const end = s.indexOf(']]>', pos + 9);
      if (end === -1) bad('unterminated_cdata');
      stack[stack.length - 1].children.push(s.slice(pos + 9, end));
      pos = end + 3;
    } else if (s.startsWith('<?', pos)) {
      const end = s.indexOf('?>', pos + 2);
      if (end === -1) bad('unterminated_processing_instruction');
      const target = readName(s, pos + 2);
      if (target === null || /^xml$/i.test(target)) bad('malformed_processing_instruction');
      const after = s[pos + 2 + target.length];
      if (!(after === ' ' || after === '\t' || after === '\r' || after === '\n' || pos + 2 + target.length === end)) bad('malformed_processing_instruction');
      pos = end + 2;
    } else if (s.startsWith('<!', pos)) {
      bad('doctype_or_declaration_not_allowed');
    } else if (s.startsWith('</', pos)) {
      const name = readName(s, pos + 2);
      if (name === null) bad('malformed_end_tag');
      const close = skipWs(s, pos + 2 + name.length);
      if (s[close] !== '>') bad(s[close] === undefined ? 'unterminated_markup' : 'malformed_end_tag');
      const top = stack.pop();
      if (!top || top.name !== name) bad(`mismatched_close_tag:${name}`);
      if (stack.length === 0) rootClosed = true;
      pos = close + 1;
    } else {
      const name = readName(s, pos + 1);
      if (name === null) bad('malformed_start_tag');
      if (rootClosed) bad('content_after_root');
      const attrs = new Map();
      let p = pos + 1 + name.length;
      let selfClosing = false;
      for (;;) {
        const afterWs = skipWs(s, p);
        const hadWs = afterWs > p;
        p = afterWs;
        if (p >= len) bad('unterminated_markup');
        if (s[p] === '>') { p += 1; break; }
        if (s[p] === '/') { if (s[p + 1] !== '>') bad(p + 1 >= len ? 'unterminated_markup' : 'malformed_start_tag'); selfClosing = true; p += 2; break; }
        if (!hadWs) bad('attribute_without_whitespace');
        const an = readName(s, p);
        if (an === null) bad('malformed_attribute_name');
        p = skipWs(s, p + an.length);
        if (s[p] !== '=') bad(p >= len ? 'unterminated_markup' : 'attribute_without_value');
        p = skipWs(s, p + 1);
        const q = s[p];
        if (q !== '"' && q !== "'") bad(p >= len ? 'unterminated_markup' : 'attribute_value_not_quoted');
        const endq = s.indexOf(q, p + 1);
        if (endq === -1) bad('unterminated_markup');
        const raw = s.slice(p + 1, endq);
        if (raw.includes('<')) bad('lt_in_attribute_value');
        if (attrs.has(an)) bad(`duplicate_attribute:${an}`);
        attrs.set(an, decodeRefs(raw));
        p = endq + 1;
      }
      const path = stack.map((e) => e.name);
      if (name === 'item') {
        const ok = (path.length === 2 && path[0] === 'rss' && path[1] === 'channel') || (path.length === 1 && path[0] === 'rdf:RDF');
        if (!ok) bad('misplaced_item');
      } else if (name === 'entry') {
        if (!(path.length === 1 && path[0] === 'feed')) bad('misplaced_entry');
      }
      if (stack.length >= MAX_DEPTH) bad('nesting_too_deep');
      elementCount += 1;
      if (elementCount > MAX_ELEMENTS) bad('too_many_elements');
      if (name === 'item' || name === 'entry') { itemCount += 1; if (itemCount > MAX_ITEMS) bad('too_many_items'); }
      const el = { name, attrs, children: [] };
      if (stack.length > 0) stack[stack.length - 1].children.push(el); else root = el;
      if (selfClosing) { if (stack.length === 0) rootClosed = true; } else stack.push(el);
      pos = p;
    }
  }
  if (stack.length !== 0) bad('unclosed_elements');
  if (root === null || !rootClosed) bad('no_root_element');
  return root;
}

const firstText = (el, ...names) => {
  for (const n of names) {
    const found = elementsNamed(el, n);
    if (found.length > 0) return textOf(found[0]).trim();
  }
  return null;
};

function rssItem(el, i) {
  const links = elementsNamed(el, 'link');
  if (links.length !== 1) bad(`item_${i}_link_count_${links.length}`);
  if (hasChildElements(links[0])) bad(`item_${i}_link_has_child_elements`);
  const link = textOf(links[0]).trim();
  if (parsePublisherUrl(link) === null) bad(`item_${i}_link_invalid`);
  const guids = elementsNamed(el, 'guid');
  if (guids.length > 1) bad(`item_${i}_guid_count_${guids.length}`);
  const guid = guids.length === 1 ? textOf(guids[0]).trim() : null;
  if (guid === '') bad(`item_${i}_guid_empty`);
  return { title: firstText(el, 'title'), link, description: firstText(el, 'description'), pubDate: firstText(el, 'pubDate', 'dc:date'), guid };
}

function atomEntry(el, i) {
  const alternates = elementsNamed(el, 'link').filter((l) => !l.attrs.has('rel') || l.attrs.get('rel') === 'alternate');
  if (alternates.length !== 1) bad(`entry_${i}_alternate_link_count_${alternates.length}`);
  const href = (alternates[0].attrs.get('href') ?? '').trim();
  if (parsePublisherUrl(href) === null) bad(`entry_${i}_link_invalid`);
  const ids = elementsNamed(el, 'id');
  if (ids.length > 1) bad(`entry_${i}_id_count_${ids.length}`);
  const guid = ids.length === 1 ? textOf(ids[0]).trim() : null;
  if (guid === '') bad(`entry_${i}_id_empty`);
  return { title: firstText(el, 'title'), link: href, description: firstText(el, 'summary', 'content'), pubDate: firstText(el, 'updated', 'published'), guid };
}

/**
 * Parses and validates a feed document. Returns { ok:true, rootName, items }
 * (items: { title, link, description, pubDate, guid }) or { ok:false, detail }
 * with NO items. `items` may be empty; the caller decides what that means.
 */
export function parseFeedStrict(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') return { ok: false, detail: 'empty_document' };
  try {
    const root = parseXml(xml);
    let itemEls;
    let build;
    if (root.name === 'rss') {
      const channels = elementsNamed(root, 'channel');
      if (channels.length !== 1) bad(`rss_channel_count_${channels.length}`);
      itemEls = elementsNamed(channels[0], 'item');
      build = rssItem;
    } else if (root.name === 'feed') {
      itemEls = elementsNamed(root, 'entry');
      build = atomEntry;
    } else if (root.name === 'rdf:RDF') {
      itemEls = elementsNamed(root, 'item');
      build = rssItem;
    } else bad('unexpected_root_element');
    return { ok: true, rootName: root.name, items: itemEls.map((el, i) => build(el, i)) };
  } catch (e) {
    if (e instanceof XmlError) return { ok: false, detail: e.message };
    throw e;
  }
}

/** Back-compat wrapper: structural verdict plus the parsed items. */
export function validateFeedStructure(xml) {
  const r = parseFeedStrict(xml);
  return r.ok ? { ok: true, rootName: r.rootName, itemElementCount: r.items.length, items: r.items } : { ok: false, detail: r.detail };
}