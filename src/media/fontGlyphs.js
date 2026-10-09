/**
 * Minimal, dependency-free TrueType/OpenType `cmap` reader (formats 4 and 12).
 *
 * Purpose: the thumbnail renderer must never claim to support a character the
 * bundled font cannot draw. Rendering "completes" even for a missing glyph (the
 * font's .notdef box is drawn), so success of the render is not evidence of
 * support. This module answers the question from the font file itself.
 *
 * Pure functions over a Buffer; no I/O, no native code, no network.
 */

const TAG_CMAP = 'cmap';

function readTables(buf) {
  if (buf.length < 12) throw new Error('font_too_short');
  const numTables = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (rec + 16 > buf.length) throw new Error('font_table_directory_truncated');
    tables.set(buf.toString('latin1', rec, rec + 4), { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) });
  }
  return tables;
}

function format4Lookup(buf, base) {
  const segCount = buf.readUInt16BE(base + 6) / 2;
  const endCodes = base + 14;
  const startCodes = endCodes + segCount * 2 + 2;
  const idDeltas = startCodes + segCount * 2;
  const idRangeOffsets = idDeltas + segCount * 2;
  return (cp) => {
    if (cp > 0xffff) return false;
    for (let i = 0; i < segCount; i++) {
      if (buf.readUInt16BE(endCodes + i * 2) < cp) continue;
      if (buf.readUInt16BE(startCodes + i * 2) > cp) return false;
      const delta = buf.readInt16BE(idDeltas + i * 2);
      const rangeOffset = buf.readUInt16BE(idRangeOffsets + i * 2);
      if (rangeOffset === 0) return ((cp + delta) & 0xffff) !== 0;
      const addr = idRangeOffsets + i * 2 + rangeOffset + (cp - buf.readUInt16BE(startCodes + i * 2)) * 2;
      if (addr + 2 > buf.length) return false;
      const glyph = buf.readUInt16BE(addr);
      return glyph !== 0 && ((glyph + delta) & 0xffff) !== 0;
    }
    return false;
  };
}

function format12Lookup(buf, base) {
  const numGroups = buf.readUInt32BE(base + 12);
  return (cp) => {
    for (let i = 0; i < numGroups; i++) {
      const g = base + 16 + i * 12;
      const start = buf.readUInt32BE(g);
      const end = buf.readUInt32BE(g + 4);
      if (cp >= start && cp <= end) return buf.readUInt32BE(g + 8) + (cp - start) !== 0;
      if (start > cp) return false;
    }
    return false;
  };
}

/**
 * @param {Buffer} fontBuffer raw .ttf bytes
 * @returns {{ has(codePoint: number): boolean }}
 */
export function loadGlyphCoverage(fontBuffer) {
  const cmap = readTables(fontBuffer).get(TAG_CMAP);
  if (!cmap) throw new Error('font_has_no_cmap');
  const numSubtables = fontBuffer.readUInt16BE(cmap.offset + 2);
  const lookups = [];
  for (let i = 0; i < numSubtables; i++) {
    const subOffset = cmap.offset + fontBuffer.readUInt32BE(cmap.offset + 4 + i * 8 + 4);
    const format = fontBuffer.readUInt16BE(subOffset);
    if (format === 4) lookups.push(format4Lookup(fontBuffer, subOffset));
    else if (format === 12) lookups.push(format12Lookup(fontBuffer, subOffset));
  }
  if (lookups.length === 0) throw new Error('font_has_no_supported_cmap_subtable');
  return { has: (cp) => lookups.some((fn) => fn(cp)) };
}

// Code points that are drawn as nothing and need no glyph: variation selectors
// (U+FE00-FE0F) and zero-width joiner/non-joiner (U+200C/U+200D).
function isInvisibleFormatting(cp) {
  return (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200c || cp === 0x200d;
}

/** Returns the distinct code points of `text` that the font cannot draw (in first-seen order). */
export function findUnsupportedCodePoints(text, coverage) {
  const missing = [];
  const seen = new Set();
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (seen.has(cp) || isInvisibleFormatting(cp)) continue;
    seen.add(cp);
    if (!coverage.has(cp)) missing.push(cp);
  }
  return missing;
}
