import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Renders a silent slideslow video from an ordered visual timeline
 * using FFmpeg's concat demuxer (Owner brief §9 — the standard, explicit,
 * inspectable way to compose timed still images/clips without a
 * filter-graph abstraction). Two explicit, separate FFmpeg invocations
 * (this + muxAudio below) rather than one complex filter_complex command
 * — easier to inspect, easier to fail at a specific, attributable step.
 *
 * The FFmpeg concat demuxer requires the final listed file to be
 * repeated without a trailing `duration` directive (a documented FFmpeg
 * quirk: the last file's `duration` is otherwise not honored) — that
 * repetition is applied here, not left to the caller.
 */
export function renderSilentVideo({ visualTiming, width, height, fps, videoEncoder, listPath, outputPath }) {
  if (!visualTiming || visualTiming.length === 0) {
    throw new Error('renderSilentVideo requires at least one visual timing segment');
  }

  const escape = (p) => p.replace(/'/g, "'\\''");
  const lines = [];
  for (const seg of visualTiming) {
    lines.push(`file '${escape(seg.location)}'`);
    lines.push(`duration ${seg.duration_seconds}`);
  }
  const last = visualTiming[visualTiming.length - 1];
  lines.push(`file '${escape(last.location)}'`);
  fs.writeFileSync(listPath, lines.join('\n') + '\n', 'utf8');

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`,
        '-c:v', videoEncoder,
        '-pix_fmt', 'yuv420p',
        outputPath
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

/**
 * Muxes narration audio onto the (already-rendered, video-only) silent
 * video, producing the final container. `-shortest` bounds the output to
 * the shorter of the two streams — since visual timing (§7) is computed
 * to sum exactly to the narration duration, this is a safety bound, not
 * the mechanism that aligns them.
 */
export function muxNarration({ silentVideoPath, narrationPath, audioEncoder, outputPath }) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-i', silentVideoPath,
      '-i', narrationPath,
      '-c:v', 'copy',
      '-c:a', audioEncoder,
      '-shortest',
      '-movflags', '+faststart',
      outputPath
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
}