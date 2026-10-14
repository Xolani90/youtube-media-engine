import { execFileSync } from 'node:child_process';

/**
 * Shared FFmpeg failure summary. Persisted decision reasons must carry the
 * actionable FFmpeg error, not the version/build banner and not unbounded
 * stderr. Pure: describeFfmpegFailure never throws.
 */
const BANNER_LINE = /^(ffmpeg version |built with |configuration:|lib(?:avutil|avcodec|avformat|avdevice|avfilter|swscale|swresample|postproc)\s)/;

export const FFMPEG_FAILURE_LIMITS = Object.freeze({
  HEAD_LINES: 3,
  TAIL_LINES: 6,
  MAX_LINE_CHARS: 300,
  MAX_TOTAL_CHARS: 1500
});

function stderrText(err) {
  const raw = err?.stderr;
  if (typeof raw === 'string' && raw.trim()) return raw;
  if (Buffer.isBuffer(raw) && raw.length > 0) return raw.toString('utf8');
  return typeof err?.message === 'string' ? err.message : '';
}

export function describeFfmpegFailure(err, limits = FFMPEG_FAILURE_LIMITS) {
  const lines = stderrText(err)
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !BANNER_LINE.test(l))
    .map((l) => (l.length > limits.MAX_LINE_CHARS ? l.slice(0, limits.MAX_LINE_CHARS) + '...' : l));
  const keep = lines.length > limits.HEAD_LINES + limits.TAIL_LINES
    ? [...lines.slice(0, limits.HEAD_LINES), '...', ...lines.slice(-limits.TAIL_LINES)]
    : lines;
  let detail = keep.join(' | ') || 'no stderr';
  if (detail.length > limits.MAX_TOTAL_CHARS) detail = '...' + detail.slice(-limits.MAX_TOTAL_CHARS);
  return 'exit=' + (err?.status ?? '-') + ' signal=' + (err?.signal ?? '-') + ' code=' + (err?.code ?? '-') + ' | ' + detail;
}

export class FfmpegExecError extends Error {
  constructor(label, cause) {
    super('ffmpeg_' + label + '_failed: ' + describeFfmpegFailure(cause));
    this.name = 'FfmpegExecError';
    this.label = label;
    this.status = cause?.status ?? null;
    this.signal = cause?.signal ?? null;
    this.code = cause?.code ?? null;
    this.cause = cause;
  }
}

/** execFileSync('ffmpeg', ...) that always throws FfmpegExecError (never a raw child-process error). */
export function runFfmpeg(label, args, options) {
  try {
    return execFileSync('ffmpeg', args, options);
  } catch (err) {
    throw new FfmpegExecError(label, err);
  }
}
