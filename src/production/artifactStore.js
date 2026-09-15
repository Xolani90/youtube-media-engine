import fs from 'node:fs';
import path from 'node:path';

/**
 * Smallest local filesystem storage mechanism for production artifacts
 * (Owner brief §10: "no cloud storage, no S3, no external object
 * storage... must work locally"). Not a generic storage framework — a
 * single write function, one artifact per content_version.
 *
 * Canonical location: `<baseDir>/<contentVersionId>/manifest.json`.
 * Collision behavior: content_version_id is unique per artifact (the
 * `productions` table additionally enforces this at the DB level), so
 * writing here twice for the same content_version_id would only happen
 * on a retried/failed attempt — the write is a plain overwrite of that
 * same deterministic path, which is safe because the content for a given
 * content_version_id is itself deterministic (same inputs -> same
 * bytes). A tmp-file + rename gives atomic replacement so a reader never
 * observes a partially-written file.
 */
export function writeManifestArtifact(baseDir, contentVersionId, manifestJson) {
  const dir = path.join(baseDir, contentVersionId);
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, 'manifest.json');
  const tmpPath = path.join(dir, `.manifest.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, manifestJson, 'utf8');
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}