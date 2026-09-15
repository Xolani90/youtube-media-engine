import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Validates a rendered media file via FFprobe (Owner brief §10 — FFmpeg
 * exiting 0 is never sufficient). Checks file existence/non-emptiness,
 * a positive measured duration, presence of both a video and an audio
 * stream, and that both streams' codecs and the video resolution match
 * what was requested. Returns { valid: false, reason } on the first
 * failing check rather than throwing — the caller decides what to do
 * with an invalid artifact (never persist it).
 */
export function validateMediaArtifact(filePath, expected) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, reason: 'FILE_MISSING' };
  }
  if (fs.statSync(filePath).size <= 0) {
    return { valid: false, reason: 'FILE_EMPTY' };
  }

  let probe;
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    ).toString();
    probe = JSON.parse(out);
  } catch (err) {
    return { valid: false, reason: `FFPROBE_FAILED_${err.message}` };
  }

  const duration = parseFloat(probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    return { valid: false, reason: 'INVALID_DURATION' };
  }

  const streams = probe.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  if (!videoStream) return { valid: false, reason: 'NO_VIDEO_STREAM' };
  if (!audioStream) return { valid: false, reason: 'NO_AUDIO_STREAM' };
  if (videoStream.codec_name !== expected.videoCodecName) {
    return { valid: false, reason: `UNEXPECTED_VIDEO_CODEC_${videoStream.codec_name}` };
  }
  if (audioStream.codec_name !== expected.audioCodecName) {
    return { valid: false, reason: `UNEXPECTED_AUDIO_CODEC_${audioStream.codec_name}` };
  }
  if (videoStream.width !== expected.width || videoStream.height !== expected.height) {
    return { valid: false, reason: `UNEXPECTED_RESOLUTION_${videoStream.width}x${videoStream.height}` };
  }

  return {
    valid: true,
    duration,
    width: videoStream.width,
    height: videoStream.height,
    videoCodec: videoStream.codec_name,
    audioCodec: audioStream.codec_name
  };
}