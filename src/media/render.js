import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { CAPTION_DEFAULTS } from './constants.js';

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
export function renderSilentVideo({ visualTiming, width, height, fps, videoEncoder, listPath, outputPath, subtitlesPath = null }) {
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

  // Media Production v1.1: captions are burned in by extending this same
  // -vf chain with FFmpeg's `subtitles` filter (libass). The existing
  // scale/pad/fps/format chain is kept intact, not replaced. A render
  // with no caption-worthy text passes no subtitlesPath and renders
  // exactly as v1 did.
  let vf = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p`;
  if (subtitlesPath) {
    const escapedSubtitlesPath = escapeFilterPath(subtitlesPath);
    const forceStyle = [
      `FontName=${CAPTION_DEFAULTS.FONT_NAME}`,
      `FontSize=${CAPTION_DEFAULTS.FONT_SIZE}`,
      `PrimaryColour=${CAPTION_DEFAULTS.PRIMARY_COLOUR}`,
      `OutlineColour=${CAPTION_DEFAULTS.OUTLINE_COLOUR}`,
      `BorderStyle=${CAPTION_DEFAULTS.BORDER_STYLE}`,
      `Outline=${CAPTION_DEFAULTS.OUTLINE}`,
      `Alignment=${CAPTION_DEFAULTS.ALIGNMENT}`,
      `MarginV=${CAPTION_DEFAULTS.MARGIN_V}`
    ].join(',');
    vf += `,subtitles=${escapedSubtitlesPath}:force_style='${forceStyle}'`;
  }

  try {
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', vf,
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

/** Escapes a path for safe use as an FFmpeg filtergraph option value — backslash and colon are both special inside a filter's option string. */
function escapeFilterPath(p) {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

function formatSrtTimestamp(totalSeconds) {
  const totalMs = Math.round(totalSeconds * 1000);
  const hh = Math.floor(totalMs / 3600000);
  const mm = Math.floor((totalMs % 3600000) / 60000);
  const ss = Math.floor((totalMs % 60000) / 1000);
  const mmm = totalMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(mmm, 3)}`;
}

/** Writes a deterministic .srt file from caption timing — pure serialization, no timing decisions made here. */
export function writeSrtFile(captionTiming, srtPath) {
  const blocks = captionTiming.map((c, i) => {
    const start = formatSrtTimestamp(c.start_seconds);
    const end = formatSrtTimestamp(c.start_seconds + c.duration_seconds);
    return `${i + 1}\n${start} --> ${end}\n${c.text}\n`;
  });
  fs.writeFileSync(srtPath, blocks.join('\n'), 'utf8');
  return srtPath;
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