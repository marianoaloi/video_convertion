/**
 * The run orchestrator: state ledger, scan, queue, post steps, upload-all, log file.
 * `startRun` returns the controller immediately (it also works during the scan).
 */
import { createWriteStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { createLadderMemory } from '../ffmpeg/ladderMemory.js'
import { probeMedia } from '../ffmpeg/probe.js'
import { createProcessExecutor } from '../ffmpeg/steps.js'
import type { CommandTemplate, DeleteMode, ExecHandle, ExecOutcome, HookOutcome, LadderMemory, LogLevel, MediaInfo, PlannedJob, SpawnPolicy } from '../types.js'
import type { RunConfig, RunController, RunEvent, RunSummary, ScanResult, StepExecutor } from '../types.js'
import { executeJob, type ExecutorDeps } from './executor.js'
import { md5OfFile, runHook, type HookRunner } from './hooks.js'
import { acquireLock } from './lock.js'
import { LogSink } from './logSink.js'
import { messageOf } from './paths.js'
import { postJob, runUploadAll, type PostDeps } from './post.js'
import { runQueue } from './queue.js'
import { scanInputs } from './scan.js'
import { openStateLedger, type StateLedger } from './state.js'
import { removeFile } from './trash.js'

export interface RunDeps {
  probe(path: string, ffprobePath: string, signal?: AbortSignal): Promise<MediaInfo>
  remove(path: string, mode: DeleteMode): Promise<void>
  runHook: HookRunner
  md5(path: string): Promise<string>
  stepExecutor?(ffmpegPath: string): StepExecutor
  now(): number
  /** Run-wide ladder circuit breaker; default: a fresh one per run. */
  ladderMemory?: LadderMemory
  /** Overrides the queue's progress throttle (tests). */
  progressIntervalMs?: number
}

export interface RunTools {
  readonly ffmpeg: string
  readonly ffprobe: string
  /** From `detectConsoleIsolation`; omitted = the platform default of `runProcess`. */
  readonly spawn?: SpawnPolicy
}

/** The real probe/executor, started with the run's spawn policy (Ctrl+C isolation). */
function defaultDeps(policy: SpawnPolicy | undefined): RunDeps {
  const detached = policy === undefined ? {} : { detached: policy.detached }
  return {
    probe: (file, ffprobePath, signal) => probeMedia(file, { ffprobePath, ...detached, ...(signal ? { signal } : {}) }),
    remove: (target, mode) => removeFile(target, mode),
    runHook,
    md5: md5OfFile,
    ...(policy === undefined ? {} : { stepExecutor: (ffmpegPath: string) => createProcessExecutor(ffmpegPath, policy) }),
    now: () => Date.now()
  }
}

export function startRun(
  config: RunConfig,
  tools: RunTools,
  emit: (event: RunEvent) => void,
  deps: Partial<RunDeps> = {}
): { controller: RunController; done: Promise<RunSummary> } {
  const all: RunDeps = { ...defaultDeps(tools.spawn), ...deps }
  const run = new Run(config, { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }, emit, all)
  return { controller: run.controller, done: run.execute() }
}

class Run {
  readonly controller: RunController = {
    stopLaunching: () => {
      this.stopRequested = true
      this.scanAbort.abort()
      this.inner?.stopLaunching()
    },
    abortAll: () => {
      this.stopRequested = true
      this.abortRequested = true
      this.scanAbort.abort()
      this.inner?.abortAll()
    }
  }

  private inner: RunController | null = null
  private stopRequested = false
  private abortRequested = false
  private ledger: StateLedger | null = null
  private logSink: LogSink | null = null
  private readonly scanAbort = new AbortController()
  private readonly ladderMemory: LadderMemory
  private readonly releases = new Map<number, () => Promise<void>>()
  private jobs: readonly PlannedJob[] = []

  constructor(
    private readonly config: RunConfig,
    private readonly tools: { ffmpeg: string; ffprobe: string },
    private readonly outer: (event: RunEvent) => void,
    private readonly deps: RunDeps
  ) {
    this.ladderMemory = deps.ladderMemory ?? createLadderMemory()
  }

  async execute(): Promise<RunSummary> {
    const startedAt = this.deps.now()
    await this.openLogFile()
    let summary: RunSummary
    try {
      summary = await this.runAll(startedAt)
    } finally {
      await this.closeResources()
    }
    this.outer({ type: 'finished', summary })
    return summary
  }

  private async runAll(startedAt: number): Promise<RunSummary> {
    await this.openLedger()
    const scan = await this.scan()
    if (scan === null) return emptySummary(startedAt, this.deps.now(), 'Scan failed')
    this.jobs = scan.jobs
    if (this.scanAbort.signal.aborted) return this.interruptedDuringScan(scan, startedAt)
    if (this.config.listOnly) return this.listOnlySummary(scan, startedAt)
    const queue = runQueue(scan.jobs, this.queueDeps(scan))
    this.inner = queue.controller
    if (this.abortRequested) queue.controller.abortAll()
    else if (this.stopRequested) queue.controller.stopLaunching()
    return { ...(await queue.done), startedAt }
  }

  /** Every event goes to the reporter; log-like events also go to the log file. */
  private emit = (event: RunEvent): void => {
    try {
      this.writeLogFile(event)
      if (event.type === 'finished') return // re-emitted by `execute` once the files are flushed
      this.outer(event)
    } catch {
      // a throwing reporter must not break the run
    }
  }

  private note(line: string, level: 'info' | 'warn' = 'info'): void {
    this.emit({ type: 'log', jobId: null, line, level })
  }

  private async openLedger(): Promise<void> {
    if (this.config.stateFile === null) return
    try {
      this.ledger = await openStateLedger(this.config.stateFile)
      this.note(`State file ${this.config.stateFile}: ${this.ledger.size} known path(s)`)
    } catch (error) {
      this.note(`Could not open the state file ${this.config.stateFile}: ${messageOf(error)}`, 'warn')
    }
  }

  private async scan(): Promise<ScanResult | null> {
    try {
      const result = await scanInputs(this.config, {
        signal: this.scanAbort.signal,
        ...(this.ledger === null ? {} : { ledger: this.ledger })
      })
      this.emit({ type: 'scan-done', result })
      return result
    } catch (error) {
      this.note(`Scan failed: ${messageOf(error)}`, 'warn')
      return null
    }
  }

  private interruptedDuringScan(scan: ScanResult, startedAt: number): RunSummary {
    const counters = { total: 0, queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0, skipped: scan.skipped.length }
    this.emit({ type: 'counters', counters })
    return { counters, startedAt, finishedAt: this.deps.now(), outputs: [], failures: [], interrupted: true }
  }

  private listOnlySummary(scan: ScanResult, startedAt: number): RunSummary {
    const total = scan.jobs.length
    const counters = { total, queued: total, processing: 0, done: 0, failed: 0, cancelled: 0, skipped: scan.skipped.length }
    this.emit({ type: 'counters', counters })
    return { counters, startedAt, finishedAt: this.deps.now(), outputs: [], failures: [], interrupted: false }
  }

  // ---- queue wiring -----------------------------------------------------------------------

  private queueDeps(scan: ScanResult): Parameters<typeof runQueue>[1] {
    const execDeps: ExecutorDeps = {
      tools: this.tools,
      probe: this.deps.probe,
      remove: this.deps.remove,
      ladderMemory: this.ladderMemory,
      ...(this.deps.stepExecutor === undefined ? {} : { stepExecutor: this.deps.stepExecutor })
    }
    const postDeps: PostDeps = {
      probeDurationMs: async (file) => {
        const info = await this.deps.probe(file, this.tools.ffprobe)
        return info.durationMs > 0 ? info.durationMs : null
      },
      remove: this.deps.remove,
      runHook: this.deps.runHook,
      md5: this.deps.md5
    }
    const { config } = this
    return {
      parallel: config.parallel,
      skipped: scan.skipped.length,
      emit: this.emit,
      ...(this.deps.progressIntervalMs === undefined ? {} : { progressIntervalMs: this.deps.progressIntervalMs }),
      now: this.deps.now,
      execute: (job, handle) => this.executeAndRecord(execDeps, job, handle),
      afterDone: (job, outputs, handle) => this.finishJob(postDeps, job, outputs, handle),
      ...(config.uploadAll === null
        ? {}
        : {
            onAllSettled: (done: { job: PlannedJob; outputs: string[] }[], log: (line: string) => void) =>
              this.uploadAll(postDeps, config.uploadAll as CommandTemplate, done, log)
          })
    }
  }

  private async executeAndRecord(deps: ExecutorDeps, job: PlannedJob, handle: ExecHandle): Promise<ExecOutcome> {
    const lock = this.config.dryRun || this.config.listOnly ? null : await acquireLock(job.videoPath)
    if (lock !== null && !lock.ok) {
      handle.log(`Skipped: ${lock.reason}`, 'warn')
      return { kind: 'cancelled' }
    }
    if (lock !== null) this.releases.set(job.id, lock.release)
    try {
      const outcome = await executeJob(deps, job, this.config, handle)
      if (outcome.kind === 'error') await this.recordFailed(job, outcome.message, handle)
      if (outcome.kind !== 'done') await this.releaseLock(job)
      return outcome
    } catch (error) {
      await this.recordFailed(job, messageOf(error), handle)
      await this.releaseLock(job)
      throw error
    }
  }

  private async releaseLock(job: PlannedJob): Promise<void> {
    const release = this.releases.get(job.id)
    this.releases.delete(job.id)
    if (release !== undefined) await release()
  }

  private async recordFailed(job: PlannedJob, message: string, handle: ExecHandle): Promise<void> {
    if (this.ledger === null || this.config.dryRun) return
    try {
      await this.ledger.recordFailed(job.videoPath, message)
    } catch (error) {
      handle.log(`Could not write the state file: ${messageOf(error)}`, 'warn')
    }
  }

  private async finishJob(deps: PostDeps, job: PlannedJob, outputs: string[], handle: ExecHandle): Promise<string[]> {
    if (this.config.dryRun) return outputs
    try {
      return await this.postAndRecord(deps, job, outputs, handle)
    } finally {
      await this.releaseLock(job)
    }
  }

  private async postAndRecord(deps: PostDeps, job: PlannedJob, outputs: string[], handle: ExecHandle): Promise<string[]> {
    const source = await stat(job.videoPath).catch(() => null)
    const final = await postJob(deps, job, outputs, this.config, handle)
    if (this.ledger !== null && source !== null) {
      try {
        await this.ledger.recordDone(job.videoPath, { size: source.size, mtimeMs: source.mtimeMs }, final)
      } catch (error) {
        handle.log(`Could not write the state file: ${messageOf(error)}`, 'warn')
      }
    }
    return final
  }

  private async uploadAll(
    deps: PostDeps,
    template: CommandTemplate,
    done: { job: PlannedJob; outputs: string[] }[],
    log: (line: string, level?: LogLevel) => void
  ): Promise<void> {
    if (this.config.dryRun) return
    const outputs = done.flatMap((d) => d.outputs)
    const outcome: HookOutcome = await runUploadAll(deps, template, outputs, log, this.config.hookTimeoutMs)
    if (outcome === 'failed') log('The upload-all hook failed')
  }

  // ---- log file ---------------------------------------------------------------------------

  private async openLogFile(): Promise<void> {
    const file = this.config.logFile
    if (file === null) return
    try {
      await mkdir(path.dirname(path.resolve(file)), { recursive: true })
      this.logSink = new LogSink(createWriteStream(file, { flags: 'a', encoding: 'utf8' }))
    } catch {
      this.logSink = null
    }
  }

  private writeLogFile(event: RunEvent): void {
    if (this.logSink === null) return
    const label = (id: number | null): string => {
      const job = id === null ? undefined : this.jobs[id - 1]
      return job === undefined ? 'batch' : `#${job.id} ${path.basename(job.videoPath)}`
    }
    let text: string | null = null
    if (event.type === 'log') text = `[${label(event.jobId)}] ${event.line}`
    else if (event.type === 'started') text = `[${label(event.jobId)}] started`
    else if (event.type === 'done') text = `[${label(event.jobId)}] done: ${event.outputs.join(', ')}`
    else if (event.type === 'error') text = `[${label(event.jobId)}] error: ${event.message}`
    else if (event.type === 'cancelled') text = `[${label(event.jobId)}] cancelled`
    if (text !== null) this.logSink.write(`[${new Date(this.deps.now()).toISOString()}] ${text}\n`)
  }

  private async closeResources(): Promise<void> {
    await this.ledger?.close().catch(() => undefined)
    const sink = this.logSink
    this.logSink = null
    await sink?.end()
  }
}

function emptySummary(startedAt: number, finishedAt: number, message: string): RunSummary {
  const counters = { total: 0, queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 }
  return { counters, startedAt, finishedAt, outputs: [], failures: [{ videoPath: '', message, logPath: null }], interrupted: false }
}
