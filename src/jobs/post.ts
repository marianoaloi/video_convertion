/**
 * Steps after a successful job: upload hook, then (only with `deleteOriginal`) verify every
 * output's duration, remove the source video + json, and let a single output take the source's
 * name. The original is kept whenever anything is doubtful; a failed removal never falls back
 * from the trash to a permanent delete.
 */
import path from 'node:path'
import { expectedDurationsMs, withinTolerance } from '../core/durations.js'
import { templateReferences } from '../core/template.js'
import { isAlreadyExists, moveExclusive } from '../ffmpeg/outputs.js'
import { DEFAULTS } from '../types.js'
import type { CommandTemplate, DeleteMode, ExecHandle, HookContext, HookOutcome, LogLevel, PlannedJob, RunConfig } from '../types.js'
import type { HookRunner } from './hooks.js'
import { exists, messageOf } from './paths.js'

export interface PostDeps {
  /** Probed duration in ms; null when the file has none. */
  probeDurationMs(path: string): Promise<number | null>
  remove(path: string, mode: DeleteMode): Promise<void>
  runHook: HookRunner
  md5(path: string): Promise<string>
}

type Log = (line: string, level?: LogLevel) => void

/** `null` when every output matches the expected duration, else why the source must be kept. */
export async function verifyOutputDurations(
  deps: PostDeps,
  job: PlannedJob,
  outputs: readonly string[],
  ratio: number = DEFAULTS.durationToleranceRatio
): Promise<string | null> {
  try {
    const sourceMs = (await deps.probeDurationMs(job.videoPath)) ?? 0
    const expected = expectedDurationsMs(job.job, sourceMs)
    if (expected.length !== outputs.length) {
      return `expected ${expected.length} output(s) but the job produced ${outputs.length}`
    }
    for (const [index, output] of outputs.entries()) {
      const want = expected[index] ?? 0
      const actual = await deps.probeDurationMs(output)
      if (actual === null || !withinTolerance(actual, want, ratio)) {
        return `${path.basename(output)} lasts ${actual ?? 'an unknown number of'} ms, expected about ${want} ms`
      }
    }
    return null
  } catch (error) {
    return `the outputs could not be verified (${messageOf(error)})`
  }
}

async function uploadOutputs(
  deps: PostDeps,
  template: CommandTemplate,
  job: PlannedJob,
  outputs: readonly string[],
  log: Log,
  signal: AbortSignal,
  timeoutMs: number
): Promise<HookOutcome> {
  const context: HookContext = {
    file: job.videoPath,
    outputs: [...outputs],
    dir: path.dirname(job.videoPath),
    root: job.root
  }
  try {
    if (templateReferences(template, 'md5')) context.md5 = await deps.md5(job.videoPath)
  } catch (error) {
    log(`Upload hook skipped: could not hash ${job.videoPath} (${messageOf(error)})`, 'warn')
    return 'failed'
  }
  return deps.runHook(template, context, log, { signal, timeoutMs })
}

/** Removes the video, then its job file. False when the video could not be removed. */
async function removeOriginal(deps: PostDeps, job: PlannedJob, mode: DeleteMode, log: Log): Promise<boolean> {
  for (const target of [job.videoPath, job.jsonPath]) {
    if (target === null) continue
    try {
      if (!(await exists(target))) continue
      await deps.remove(target, mode)
      log(mode === 'trash' ? `Sent to the trash: ${target}` : `Deleted: ${target}`)
    } catch (error) {
      log(`Could not remove ${target} (${messageOf(error)}); the original was kept`, 'warn')
      if (target === job.videoPath) return false
    }
  }
  return true
}

/** A single output takes the original's name once the source is gone. Returns the final outputs. */
async function renameToOriginal(job: PlannedJob, outputs: readonly string[], log: Log): Promise<string[]> {
  const [output, ...rest] = outputs
  if (output === undefined || rest.length > 0 || output === job.videoPath) return [...outputs]
  try {
    await moveExclusive(output, job.videoPath)
    log(`Renamed ${output} to ${job.videoPath}`)
    return [job.videoPath]
  } catch (error) {
    const why = isAlreadyExists(error) ? 'a file with that name already exists' : messageOf(error)
    log(`Could not rename the output to ${job.videoPath}: ${why}`, 'warn')
    return [...outputs]
  }
}

/**
 * The queue's `afterDone` step. Returns the outputs as they are on disk afterwards (a rename
 * changes them). Never runs in a dry run.
 */
export async function postJob(
  deps: PostDeps,
  job: PlannedJob,
  outputs: readonly string[],
  config: RunConfig,
  handle: ExecHandle
): Promise<string[]> {
  if (config.dryRun) return [...outputs]
  const log: Log = (line, level = 'info') => {
    handle.log(line, level)
  }
  let upload: HookOutcome = 'skipped'
  if (config.upload !== null && outputs.length > 0) {
    upload = await uploadOutputs(deps, config.upload, job, outputs, log, handle.signal, config.hookTimeoutMs)
  }
  if (!config.deleteOriginal) return [...outputs]
  if (upload === 'failed') {
    log('The original was kept because the upload hook failed', 'warn')
    return [...outputs]
  }
  const mismatch = await verifyOutputDurations(deps, job, outputs, toleranceRatio(config))
  if (mismatch !== null) {
    log(`The original was kept: ${mismatch}`, 'warn')
    return [...outputs]
  }
  if (!(await removeOriginal(deps, job, config.deleteMode, log))) return [...outputs]
  return renameToOriginal(job, outputs, log)
}

function toleranceRatio(config: RunConfig): number {
  return config.deleteMode === 'permanent' ? DEFAULTS.durationToleranceRatioPermanent : DEFAULTS.durationToleranceRatio
}

/** `uploadAll`: one call with every output of the run's successful jobs. */
export async function runUploadAll(
  deps: Pick<PostDeps, 'runHook'>,
  template: CommandTemplate,
  outputs: readonly string[],
  log: (line: string, level?: LogLevel) => void,
  timeoutMs = 0
): Promise<HookOutcome> {
  const first = outputs[0]
  if (first === undefined) return 'skipped'
  return deps.runHook(template, { outputs: [...outputs], files: [...outputs], dir: path.dirname(first) }, log, { timeoutMs })
}
