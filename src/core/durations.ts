/**
 * Expected output durations and names of a job (the app's `jobPost.ts`), used to verify outputs
 * before "delete original" and to know which outputs a planned job leaves behind.
 */
import { DEFAULTS } from '../types.js'
import type { VideoJob } from '../types.js'
import { resolveRanges } from './ffmpegArgs.js'

type JobShape = Pick<VideoJob, 'times' | 'posExecution'>

/** Expected output durations: one per range, or their sum when the job concatenates. */
export function expectedDurationsMs(job: JobShape, sourceMs: number): number[] {
  const spans = resolveRanges(job, {
    durationMs: sourceMs,
    width: 0,
    height: 0,
    bitrateKbps: null,
    rotation: 0,
    hasAudio: false
  })
  const each = spans.map((s) => (s.start < 0 ? sourceMs : s.end - s.start))
  return job.posExecution === 2 ? [each.reduce((a, b) => a + b, 0)] : each
}

/** Allowed difference between an output and its expected duration (encoder frame/keyframe slack). */
export function withinTolerance(
  actualMs: number,
  expectedMs: number,
  ratio: number = DEFAULTS.durationToleranceRatio
): boolean {
  const slack = Math.max(DEFAULTS.durationToleranceMs, expectedMs * ratio)
  return Math.abs(actualMs - expectedMs) <= slack
}

/**
 * Final output names of a job, in the order `buildFfmpegArgs` produces them: cut mode gives
 * `<video>.<i>.mp4` for every range (one for the whole video when `times` is empty), concat
 * (posExecution 2) gives `<video>.mp4`.
 */
export function expectedOutputNames(job: JobShape, videoPath: string): string[] {
  if (job.posExecution === 2) return [`${videoPath}.mp4`]
  const count = Math.max(1, job.times.length)
  return Array.from({ length: count }, (_, i) => `${videoPath}.${i}.mp4`)
}
