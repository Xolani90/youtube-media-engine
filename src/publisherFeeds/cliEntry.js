import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when the module at `metaUrl` is the script Node was launched with
 * (process.argv[1]). Compares filesystem paths, not URL strings, so it works
 * for Windows paths (drive letters, backslashes, percent-encoding, spaces).
 * `windows` selects win32 semantics (default: the current platform); on
 * Windows the comparison is case-insensitive.
 */
export function isCliEntry(metaUrl, argv1, { windows = process.platform === 'win32' } = {}) {
  if (typeof argv1 !== 'string' || argv1 === '') return false;
  const p = windows ? path.win32 : path.posix;
  let self;
  try { self = p.resolve(fileURLToPath(metaUrl, { windows })); } catch { return false; }
  const entry = p.resolve(argv1);
  return windows ? self.toLowerCase() === entry.toLowerCase() : self === entry;
}
