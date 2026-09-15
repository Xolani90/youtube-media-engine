import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Smallest local filesystem layout for Media Production artifacts,
 * mirroring src/production/artifactStore.js exactly: one directory per
 * content_version, deterministic filenames within it. Not a generic
 * storage framework.
 *
 * Canonical layout: `<baseDir>/<contentVersionId>/narration.wav` and
 * `<baseDir>/<contentVersionId>/video.mp4`.
 */
export function mediaDir(baseDir, contentVersionId) {
  const dir = path.join(baseDir, contentVersionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Atomically moves a validated artifact from its temporary render path
 * to its final deterministic path (Owner brief §11: "use a temporary
 * output path during rendering... only move/rename it to its final
 * deterministic path after validation succeeds"). rename() on the same
 * filesystem is atomic — a reader never observes a partially-written
 * final file.
 */
export function finalizeArtifact(tmpPath, finalPath) {
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/** sha256 hex digest of a file's actual bytes (the rendered .mp4), as opposed to src/production/manifest.js's sha256() which hashes JSON text. */
export function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}