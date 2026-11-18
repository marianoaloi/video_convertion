/**
 * Runs one planned job: probe, optional `convert` pre-step, the ffmpeg ladder, and the per-job
 * failure log (`<video>.log`, written on failure only, never on success).
 */
import { writeFile } from 'node:fs/promises'
import { buildConvertStep } from '../core/ffmpegArgs.js'
import { partPath } from '../ffmpeg/outputs.js'
import { runFfmpegJob } from '../ffmpeg/runner.js'
import { createProcessExecutor, judgeStep, removeQuietly } from '../ffmpeg/steps.js'
import type {
  DeleteMode,
  ExecHandle,
  ExecOutcome,
  MediaInfo,
  PlannedJob,
  LadderMemory,
  RunConfig,
  StepExecutor
} from '../types.js'
import { messageOf } from './paths.js'
import { StderrLimiter } from './stderrLimit.js'

/** Windows MAX_PATH: longer paths fail in tools that are not long-path aware. */
const MAX_PATH = 260

export interface ExecutorDeps {
  readonly tools: { readonly ffmpeg: string; readonly ffprobe: string }
  probe(path: string, ffprobePath: string, signal?: AbortSignal): Promise<MediaInfo>
  remove(path: string, mode: DeleteMode): Promise<void>
  /** Run-wide circuit breaker for failing ladder rungs; shared by every job. */
  readonly ladderMemory?: LadderMemory
  /** Test seam: replaces the real ffmpeg process. */
  stepExecutor?(ffmpegPath: string): StepExecutor
}

interface Prepared {
  readonly inputPath: string
  readonly media: MediaInfo
  readonly temp: string | null
}

export async function executeJob(
  deps: ExecutorDeps,
  job: PlannedJob,
  config: RunConfig,
  handle: ExecHandle
): Promise<ExecOutcome> {
  let media: MediaInfo
  try {
    media = await deps.probe(job.videoPath, deps.tools.ffprobe, handle.signal)
    if (!media.hasVideo) throw new Error('The file has no video stream')
  } catch (error) {
    if (handle.signal.aborted) return { kind: 'cancelled' }
    const message = messageOf(error)
    handle.log(`Failed: ${message}`, 'warn')
    if (config.failureLog && !config.dryRun) await writeFailureLog(job.videoPath, handle, [])
    return { kind: 'error', message }
  }
  warnLongPaths(job, handle)
  const input = await prepareInput(deps, job, config, media, handle)
  try {
    if (handle.signal.aborted) return { kind: 'cancelled' }
    return await runLadder(deps, job, config, handle, input)
  } finally {
    if (input.temp !== null) await removeQuietly(input.temp)
  }
}

/** Windows: warns when a working `.part` path reaches MAX_PATH. */
function warnLongPaths(job: PlannedJob, handle: ExecHandle, platform = process.platform): void {
  if (platform !== 'win32') return
  const longest = Math.max(0, ...job.expectedOutputs.map((o) => partPath(o).length))
  if (longest >= MAX_PATH) {
    handle.log(
      `path is ${longest} characters; enable Windows long paths if the conversion fails`,
      'warn'
    )
  }
}

/** `convert: true`: re-encode the whole file to a NEW temp file and use that as the input. */
async function prepareInput(
  deps: ExecutorDeps,
  job: PlannedJob,
  config: RunConfig,
  media: MediaInfo,
  handle: ExecHandle
): Promise<Prepared> {
  const same: Prepared = { inputPath: job.videoPath, media, temp: null }
  if (!job.job.convert) return same
  const step = buildConvertStep(job.videoPath, { hasAudio: media.hasAudio, verbose: config.verboseFfmpeg })
  handle.log('Converting the source to a clean H.264/MP4 first')
  handle.log(`$ ffmpeg ${step.argv.join(' ')}`)
  if (config.dryRun) return same
  const exec = deps.stepExecutor?.(deps.tools.ffmpeg) ?? createProcessExecutor(deps.tools.ffmpeg)
  const limiter = new StderrLimiter((line) => handle.log(line, 'stderr'))
  const exit = await exec({
    argv: step.argv,
    signal: handle.signal,
    stallTimeoutMs: config.stallTimeoutMs,
    onProgress: () => undefined,
    onStderrLine: (line) => {
      limiter.push(line)
    }
  })
  limiter.finish()
  const verdict = await judgeStep(exit, step.output, config.minOutputBytes)
  if (!verdict.ok) {
    await removeQuietly(step.output)
    handle.log(`Convert failed (${verdict.reason}); continuing with the original file`, 'warn')
    return same
  }
  try {
    const converted = await deps.probe(step.output, deps.tools.ffprobe, handle.signal)
    return { inputPath: step.output, media: converted, temp: step.output }
  } catch (error) {
    await removeQuietly(step.output)
    handle.log(`Could not probe the converted file: ${messageOf(error)}`, 'warn')
    return same
  }
}

async function runLadder(
  deps: ExecutorDeps,
  job: PlannedJob,
  config: RunConfig,
  handle: ExecHandle,
  input: Prepared
): Promise<ExecOutcome> {
  const ffmpegPath = deps.tools.ffmpeg
  const limiter = new StderrLimiter((line) => handle.log(line, 'stderr'))
  const result = await runFfmpegJob({
    ffmpegPath,
    job: job.job,
    media: input.media,
    inputPath: input.inputPath,
    outputBase: job.videoPath,
    encoders: config.encoders,
    gpu: config.hwaccel === 'cuda' || config.hwaccel === 'auto',
    sameSize: config.sameSize,
    verbose: config.verboseFfmpeg,
    maxRateKbps: config.maxRateKbps,
    maxSide: config.maxSide,
    minOutputBytes: config.minOutputBytes,
    keepParts: config.keepParts,
    dryRun: config.dryRun,
    stallTimeoutMs: config.stallTimeoutMs,
    ...(deps.ladderMemory === undefined ? {} : { ladderMemory: deps.ladderMemory }),
    signal: handle.signal,
    onProgress: (p) => {
      handle.progress(p)
    },
    onLog: (line, source) => {
      if (source === 'stderr') limiter.push(line)
      else handle.log(line, 'info')
    },
    // Concat parts are our own temp files: remove them for good.
    trashPart: (target) => deps.remove(target, 'permanent'),
    // An existing output is only ever sent to the trash, whatever --delete-mode says; when that
    // fails the new file takes a collision name instead.
    ...(config.existing === 'replace' ? { trashExisting: (target: string) => deps.remove(target, 'trash') } : {}),
    ...(deps.stepExecutor === undefined ? {} : { executor: deps.stepExecutor(ffmpegPath) })
  })
  limiter.finish()
  if (result.ok) return { kind: 'done', outputs: result.outputs }
  if (result.cancelled) return { kind: 'cancelled' }
  handle.log(`Failed: ${result.error}`, 'warn')
  if (config.failureLog && !config.dryRun) await writeFailureLog(job.videoPath, handle, result.lastLines)
  return { kind: 'error', message: result.error }
}

async function writeFailureLog(videoPath: string, handle: ExecHandle, tail: readonly string[]): Promise<void> {
  const logPath = `${videoPath}.log`
  const lines = [...handle.lines(), '--- last ffmpeg output ---', ...tail]
  try {
    await writeFile(logPath, `${lines.join('\n')}\n`, 'utf8')
    handle.setLogPath(logPath)
  } catch (error) {
    handle.log(`Could not write ${logPath}: ${messageOf(error)}`, 'warn')
  }
}
