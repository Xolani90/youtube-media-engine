/**
 * Strict URL matching for publisher feed annotation.
 *
 * A URL is usable only if ALL of these hold:
 *   - it parses as an absolute URL with scheme http: or https:
 *   - it carries no userinfo (no username / password)
 *   - its effective port is the scheme default (WHATWG URL reports a default
 *     port as '' and any other port as non-empty, so `:443` on https is the
 *     default and `:8443`, or `:443` on http, is rejected)
 *   - it has a non-empty hostname
 * Anything else yields null / false: a miss is harmless (no annotation), a
 * false positive would not be. Host comparison is exact after lowercasing and
 * dropping one leading `www.`: no suffix matching, so subdomains and
 * lookalike domains never match. The query and fragment are dropped, trailing
 * slashes are dropped, and the path stays case-sensitive.
 */
export function parsePublisherUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username !== '' || u.password !== '') return null;
  if (u.port !== '') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  return { scheme: u.protocol.slice(0, -1), host, path: u.pathname.replace(/\/+$/, '') };
}

/**
 * Canonical comparison key: `<scheme>://<host><path>`. The SCHEME IS PART OF
 * THE KEY: http://openai.com/x and https://openai.com/x do NOT match. The
 * earlier scheme-less key was ambiguous; the conservative reading is taken
 * because a miss only means "no annotation", whereas a cross-scheme match
 * would link two distinct URLs. Host and port rules (parsePublisherUrl) are
 * unchanged, so the scheme in the key can never authorize another host or a
 * non-default port.
 */
export function normalizePublisherUrl(url) {
  const p = parsePublisherUrl(url);
  return p ? `${p.scheme}://${p.host}${p.path}` : null;
}

export function hostOf(url) {
  return parsePublisherUrl(url)?.host ?? null;
}

/** Exact host match against the authorized host list (no suffix matching). */
export function isAuthorizedHost(url, hosts) {
  const h = hostOf(url);
  return h !== null && Array.isArray(hosts) && hosts.includes(h);
}
