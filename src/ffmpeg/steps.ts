/**
 * One ffmpeg process (a "step") and its success test:
 * success = exit code 0 AND the output file is at least `minOutputBytes` (1000 B).
 * Nothing here matches on stderr text: `-hwaccel cuda` decoder warnings with exit 0 are a success.
 */
import { rm, stat } from 'node:fs/promises'
import { runnerPrefix } from '../core/ffmpegArgs.js'
import { ProgressParser } from '../core/progress.js'
import type { SpawnPolicy, StepExecutor, StepExit, StepRequest, StepVerdict } from '../types.js'
import { runProcess } from './process.js'

/** Kills the step when no progress block with an advancing `out_time` arrives for `stallMs`. */
class StallWatchdog {
  stalled = false
  private timer: NodeJS.Timeout | null = null
  private lastOutTimeMs = -1

  constructor(
    private readonly stallMs: number,
    private readonly onStall: () => void
  ) {
    if (stallMs > 0) this.arm()
  }

  sample(outTimeMs: number | null): void {
    if (this.stallMs <= 0 || outTimeMs === null || outTimeMs <= this.lastOutTimeMs) return
    this.lastOutTimeMs = outTimeMs
    this.arm()
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  private arm(): void {
    this.stop()
    this.timer = setTimeout(() => {
      this.stalled = true
      this.onStall()
    }, this.stallMs)
    this.timer.unref()
  }
}

/** Runs `command args` as one step: progress parsing, stall watchdog, status mapping. */
export async function runStepProcess(
  command: string,
  args: readonly string[],
  request: StepRequest,
  policy?: SpawnPolicy
): Promise<StepExit> {
  const parser = new ProgressParser()
  const own = new AbortController()
  const forward = (): void => own.abort()
  request.signal?.addEventListener('abort', forward, { once: true })
  if (request.signal?.aborted === true) own.abort()
  const stallMs = request.stallTimeoutMs ?? 0
  const dog = new StallWatchdog(stallMs, () => {
    request.onStderrLine(`vconv: no progress for ${formatDuration(stallMs)}, killing ffmpeg`)
    own.abort()
  })
  try {
    const result = await runProcess({
      command,
      args,
      ...(policy === undefined ? {} : { detached: policy.detached }),
      captureStdout: false,
      captureStderr: false,
      signal: own.signal,
      onStdoutLine: (line) => {
        const sample = parser.feed(line)
        if (sample === null) return
        dog.sample(sample.outTimeMs)
        request.onProgress(sample)
      },
      onStderrLine: request.onStderrLine
    })
    const stalledOnly = dog.stalled && request.signal?.aborted !== true
    const status = stalledOnly ? 'timeout' : result.status
    const base = { status, exitCode: result.exitCode }
    return result.error === undefined ? base : { ...base, spawnError: result.error.message }
  } finally {
    dog.stop()
    request.signal?.removeEventListener('abort', forward)
  }
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`
}

export function createProcessExecutor(ffmpegPath: string, policy?: SpawnPolicy): StepExecutor {
  return (request) => runStepProcess(ffmpegPath, [...runnerPrefix(), ...request.argv], request, policy)
}

/** Size of a file, or `null` when it does not exist. */
export async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return null
    throw error
  }
}

/**
 * Deletes a failed/partial output; a missing file is fine. Never throws (an antivirus lock must not
 * turn a good job into a failure): retries a few times and returns false when it could not remove it.
 */
export async function removeQuietly(path: string): Promise<boolean> {
  try {
    await rm(path, { force: true, maxRetries: 5, retryDelay: 200 })
    return true
  } catch {
    return false
  }
}

/** Applies the success rule to an executed step. */
export async function judgeStep(
  exit: StepExit,
  output: string,
  minOutputBytes: number
): Promise<StepVerdict> {
  if (exit.status === 'spawn-error') {
    return { ok: false, fatal: true, reason: `ffmpeg could not be started: ${exit.spawnError ?? ''}` }
  }
  if (exit.status === 'timeout') return { ok: false, fatal: false, reason: 'ffmpeg timed out' }
  if (exit.status !== 'exited' || exit.exitCode !== 0) {
    return { ok: false, fatal: false, reason: `ffmpeg exited with code ${exit.exitCode ?? 'none'}` }
  }
  const size = await fileSize(output)
  if (size === null) return { ok: false, fatal: false, reason: `ffmpeg wrote no output: ${output}` }
  if (size < minOutputBytes) {
    return {
      ok: false,
      fatal: false,
      reason: `Output is ${size} bytes, below the ${minOutputBytes} byte minimum: ${output}`
    }
  }
  return { ok: true }
}

/** Keeps the last `max` lines (the failure message quotes them). */
export class TailBuffer {
  private lines: string[] = []

  constructor(private readonly max = 60) {}

  push(line: string): void {
    this.lines.push(line)
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max)
  }

  clear(): void {
    this.lines = []
  }

  snapshot(): string[] {
    return [...this.lines]
  }
}
