/**
 * The job queue (port of the app's `JobQueue`): a fixed number of workers that never die (an
 * exception becomes an `error` outcome and the next job starts), progress throttled to ~4/s.
 *
 * Event order per job: `started`, `progress`* / `log`*, then `done` | `error` | `cancelled`, each
 * followed by a `counters` event. `afterDone` runs inside the worker slot BEFORE `done` is emitted
 * (the job still counts as processing), so `done` carries the final outputs (after a rename).
 *
 * Memory: only the running jobs keep log lines (capped); finished jobs leave outputs + failures.
 */
import type {
  ExecHandle,
  ExecOutcome,
  PlannedJob,
  RunController,
  RunCounters,
  RunEvent,
  RunFailure,
  RunSummary
} from '../types.js'
import { messageOf } from './paths.js'

export interface QueueDeps {
  parallel: number
  /** Jobs skipped at scan time (reported in the counters). */
  skipped: number
  execute(job: PlannedJob, handle: ExecHandle): Promise<ExecOutcome>
  /** Runs after a successful execute, inside the slot. May return the final outputs. Errors are logged. */
  afterDone?(job: PlannedJob, outputs: string[], handle: ExecHandle): Promise<string[] | void>
  /** Once, when every job settled; batch-level log lines go through `log`. */
  onAllSettled?(done: { job: PlannedJob; outputs: string[] }[], log: (line: string) => void): Promise<void>
  emit(event: RunEvent): void
  /** Default 250 ms. */
  progressIntervalMs?: number
  now?(): number
}

export const MAX_LOG_LINES = 5000

interface Running {
  readonly controller: AbortController
  readonly lines: string[]
  logPath: string | null
  lastProgressAt: number
}

export function runQueue(
  jobs: readonly PlannedJob[],
  deps: QueueDeps
): { controller: RunController; done: Promise<RunSummary> } {
  const queue = new JobRun(jobs, deps)
  const done = Promise.resolve().then(() => queue.run())
  return { controller: queue.controller, done }
}

class JobRun {
  readonly controller: RunController = {
    stopLaunching: () => {
      this.stop(false)
    },
    abortAll: () => {
      this.stop(true)
    }
  }

  private readonly counters: RunCounters
  private readonly running = new Map<number, Running>()
  private readonly outputs: string[] = []
  private readonly failures: RunFailure[] = []
  private readonly doneJobs: { job: PlannedJob; outputs: string[] }[] = []
  private next = 0
  private interrupted = false
  private startedAt = 0

  constructor(
    private readonly jobs: readonly PlannedJob[],
    private readonly deps: QueueDeps
  ) {
    this.counters = {
      total: jobs.length,
      queued: jobs.length,
      processing: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
      skipped: deps.skipped
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  /** A throwing reporter or log writer must never kill a worker: its errors are dropped. */
  private emit(event: RunEvent): void {
    try {
      this.deps.emit(event)
    } catch {
      // ignore
    }
  }

  private emitCounters(): void {
    this.emit({ type: 'counters', counters: { ...this.counters } })
  }

  async run(): Promise<RunSummary> {
    this.startedAt = this.now()
    this.emitCounters()
    const size = Math.max(1, Math.min(Math.floor(this.deps.parallel) || 1, this.jobs.length))
    await Promise.all(Array.from({ length: this.jobs.length === 0 ? 0 : size }, () => this.worker()))
    await this.settleAll()
    const summary: RunSummary = {
      counters: { ...this.counters },
      startedAt: this.startedAt,
      finishedAt: this.now(),
      outputs: this.outputs,
      failures: this.failures,
      interrupted: this.interrupted
    }
    this.emit({ type: 'finished', summary })
    return summary
  }

  private stop(abortRunning: boolean): void {
    if (this.next < this.jobs.length || this.running.size > 0) this.interrupted = true
    const rest = this.jobs.slice(this.next)
    this.next = this.jobs.length
    for (const job of rest) {
      this.counters.queued -= 1
      this.counters.cancelled += 1
      this.emit({ type: 'cancelled', jobId: job.id })
    }
    if (rest.length > 0) this.emitCounters()
    if (abortRunning) for (const entry of this.running.values()) entry.controller.abort()
  }

  private async worker(): Promise<void> {
    while (this.next < this.jobs.length) {
      const job = this.jobs[this.next]
      this.next += 1
      if (job !== undefined) await this.runOneSafely(job)
    }
  }

  /** Last line of defence: an unexpected throw fails that job and the worker carries on. */
  private async runOneSafely(job: PlannedJob): Promise<void> {
    try {
      await this.runOne(job)
    } catch (error) {
      const entry = this.running.get(job.id)
      if (entry === undefined) return
      this.running.delete(job.id)
      this.counters.processing -= 1
      this.conclude(job, entry, { kind: 'error', message: `internal error: ${messageOf(error)}` }, 0)
      this.emitCounters()
    }
  }

  private async runOne(job: PlannedJob): Promise<void> {
    const entry: Running = {
      controller: new AbortController(),
      lines: [],
      logPath: null,
      lastProgressAt: Number.NEGATIVE_INFINITY
    }
    this.running.set(job.id, entry)
    this.counters.queued -= 1
    this.counters.processing += 1
    const startedAt = this.now()
    this.emit({ type: 'started', jobId: job.id, videoPath: job.videoPath, at: startedAt })
    this.emitCounters()
    const handle = this.handleFor(job, entry)
    let outcome = await this.execute(job, entry, handle)
    if (outcome.kind === 'done') outcome = await this.afterDone(job, outcome, handle)
    this.running.delete(job.id)
    this.counters.processing -= 1
    this.conclude(job, entry, outcome, this.now() - startedAt)
    this.emitCounters()
  }

  private async execute(job: PlannedJob, entry: Running, handle: ExecHandle): Promise<ExecOutcome> {
    try {
      const outcome = await this.deps.execute(job, handle)
      if (outcome.kind !== 'done' && entry.controller.signal.aborted) return { kind: 'cancelled' }
      return outcome
    } catch (error) {
      if (entry.controller.signal.aborted) return { kind: 'cancelled' }
      return { kind: 'error', message: messageOf(error) }
    }
  }

  private async afterDone(
    job: PlannedJob,
    outcome: Extract<ExecOutcome, { kind: 'done' }>,
    handle: ExecHandle
  ): Promise<ExecOutcome> {
    if (this.deps.afterDone === undefined) return outcome
    try {
      const final = await this.deps.afterDone(job, [...outcome.outputs], handle)
      return final ? { kind: 'done', outputs: final } : outcome
    } catch (error) {
      handle.log(`Post-job step failed: ${messageOf(error)}`, 'warn')
      return outcome
    }
  }

  private conclude(job: PlannedJob, entry: Running, outcome: ExecOutcome, durationMs: number): void {
    if (outcome.kind === 'done') {
      this.counters.done += 1
      this.outputs.push(...outcome.outputs)
      if (this.deps.onAllSettled !== undefined) this.doneJobs.push({ job, outputs: outcome.outputs })
      this.emit({ type: 'done', jobId: job.id, outputs: outcome.outputs, durationMs: Math.max(0, durationMs) })
    } else if (outcome.kind === 'error') {
      this.counters.failed += 1
      this.failures.push({ videoPath: job.videoPath, message: outcome.message, logPath: entry.logPath })
      this.emit({ type: 'error', jobId: job.id, message: outcome.message, logPath: entry.logPath })
    } else {
      this.counters.cancelled += 1
      this.emit({ type: 'cancelled', jobId: job.id })
    }
  }

  private async settleAll(): Promise<void> {
    if (this.deps.onAllSettled === undefined || this.doneJobs.length === 0) return
    const log = (line: string): void => {
      this.emit({ type: 'log', jobId: null, line, level: 'info' })
    }
    try {
      await this.deps.onAllSettled(this.doneJobs, log)
    } catch (error) {
      this.emit({ type: 'log', jobId: null, line: `Batch step failed: ${messageOf(error)}`, level: 'warn' })
    }
  }

  private handleFor(job: PlannedJob, entry: Running): ExecHandle {
    const interval = this.deps.progressIntervalMs ?? 250
    return {
      signal: entry.controller.signal,
      progress: (report) => {
        const progress = Math.min(1, Math.max(0, report.progress))
        const at = this.now()
        if (at - entry.lastProgressAt < interval && progress < 1) return
        entry.lastProgressAt = at
        this.emit({
          type: 'progress',
          jobId: job.id,
          progress,
          stepIndex: report.stepIndex,
          stepCount: report.stepCount,
          outTimeMs: report.outTimeMs,
          speed: report.speed
        })
      },
      log: (line, level = 'info') => {
        entry.lines.push(line)
        if (entry.lines.length > MAX_LOG_LINES) entry.lines.splice(0, entry.lines.length - MAX_LOG_LINES)
        this.emit({ type: 'log', jobId: job.id, line, level })
      },
      lines: () => [...entry.lines],
      setLogPath: (logPath) => {
        entry.logPath = logPath
      }
    }
  }
}
