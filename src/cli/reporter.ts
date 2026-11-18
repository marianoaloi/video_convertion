import type { OutputMode, RunCounters, RunEvent } from '../types.js'
import {
  bar,
  baseName,
  cleanLine,
  counterParts,
  fit,
  formatDuration,
  makePaint,
  percent,
  plural,
  scanHeadline,
  summaryLines,
  zeroCounters
} from './format.js'

export type ReporterStream = NodeJS.WritableStream & { columns?: number; rows?: number; isTTY?: boolean }

export interface ReporterOptions {
  quiet: boolean
  verbose: boolean
  ignoreErrors: boolean
  dryRun: boolean
  /** `--list`: print the jobs found (with --verbose) and no run summary. */
  listOnly?: boolean
  out: ReporterStream
  err: NodeJS.WritableStream
  color: boolean
  now?: () => number
}

export interface Reporter {
  handle(e: RunEvent): void
  close(): void
}

const MAX_SKIPPED_SHOWN = 20
const PANEL_INTERVAL_MS = 200
const PLAIN_COUNTERS_MS = 10_000
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

interface RunningJob {
  name: string
  progress: number
  stepIndex: number
  stepCount: number
  speed: number | null
  startedAt: number
}

/** What the text modes know about the run so far. */
class RunView {
  counters: RunCounters = zeroCounters()
  readonly names = new Map<number, string>()
  readonly running = new Map<number, RunningJob>()
  /** Done + failed + cancelled, counted from events (the counters event comes after them). */
  finished = 0
  timedJobs = 0
  timedMs = 0
  maxProcessing = 1
  runStart: number | null = null

  nameOf(id: number): string {
    return this.names.get(id) ?? `job ${id}`
  }

  finish(id: number, durationMs?: number): void {
    this.running.delete(id)
    this.finished++
    if (durationMs !== undefined) {
      this.timedJobs++
      this.timedMs += durationMs
    }
  }

  fraction(): number {
    const c = this.counters
    if (c.total <= 0) return 0
    let partial = 0
    for (const j of this.running.values()) partial += j.progress
    return Math.min(1, (c.done + c.failed + c.cancelled + partial) / c.total)
  }

  etaMs(): number | null {
    const c = this.counters
    if (this.timedJobs === 0) return null
    const left = c.total - this.fraction() * c.total
    if (left <= 0) return 0
    return (left * (this.timedMs / this.timedJobs)) / Math.max(1, this.maxProcessing)
  }
}

export function createReporter(mode: OutputMode, opts: ReporterOptions): Reporter {
  if (mode === 'json') return createJsonReporter(opts)
  return createTextReporter(mode, opts)
}

const MAX_JSON_SKIPPED = 1000

/** A huge skipped list would make one enormous line: keep the first 1000 and the total. */
function trimScan(e: RunEvent): object {
  if (e.type !== 'scan-done') return e
  const skipped = e.result.skipped.slice(0, MAX_JSON_SKIPPED)
  return { ...e, result: { ...e.result, skipped, skippedTotal: e.result.skipped.length } }
}

function createJsonReporter(opts: ReporterOptions): Reporter {
  return {
    handle(e) {
      opts.out.write(JSON.stringify(trimScan(e)) + '\n')
    },
    close() {}
  }
}

function createTextReporter(mode: 'tty' | 'plain', opts: ReporterOptions): Reporter {
  const { out, quiet } = opts
  const now = opts.now ?? Date.now
  const paint = makePaint(opts.color)
  const unicode = mode === 'tty' && opts.color
  const live = mode === 'tty' && !quiet
  const view = new RunView()
  const marks = {
    ok: unicode ? '✓' : 'OK',
    fail: unicode ? '✗' : 'FAIL',
    cancel: unicode ? '–' : 'CANCEL',
    arrow: unicode ? '→' : '->'
  }

  let pending: string[] = []
  let panelLines = 0
  let panelOn = true
  let cursorHidden = false
  let lastRender = Number.NEGATIVE_INFINITY
  let lastPlainCounters = now()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const columns = (): number => Math.max(20, (out.columns ?? 80) - 1)

  function render(): void {
    timer = undefined
    lastRender = now()
    let buf = ''
    if (!cursorHidden) {
      buf += HIDE_CURSOR
      cursorHidden = true
    }
    if (panelLines > 0) buf += `\x1b[${panelLines}A\r\x1b[J`
    for (const line of pending) buf += line + '\n'
    pending = []
    const panel = panelOn ? buildPanel() : []
    for (const line of panel) buf += line + '\n'
    panelLines = panel.length
    out.write(buf)
  }

  function schedule(): void {
    if (closed) return
    const wait = lastRender + PANEL_INTERVAL_MS - now()
    if (wait <= 0) {
      if (timer !== undefined) clearTimeout(timer)
      return render()
    }
    if (timer !== undefined) return
    timer = setTimeout(render, wait)
    timer.unref?.()
  }

  function emit(line: string): void {
    if (live) {
      pending.push(line)
      schedule()
    } else out.write(line + '\n')
  }

  function countersLine(sep: string): string {
    return counterParts(view.counters).join(sep)
  }

  function paintedCounters(): string {
    const c = view.counters
    const parts = counterParts(c).map((p) => {
      if (p.startsWith('Done')) return paint('green', p)
      if (p.startsWith('Failed') && c.failed > 0) return paint('red', p)
      if (p.startsWith('Cancelled')) return paint('yellow', p)
      return p
    })
    return parts.join(' │ ')
  }

  function overallLine(width: number): string {
    const f = view.fraction()
    const elapsed = view.runStart === null ? 0 : now() - view.runStart
    const eta = view.etaMs()
    const barWidth = Math.max(10, Math.min(30, width - 40))
    const etaText = eta === null ? '' : `  ETA ${formatDuration(eta)}`
    return `${paint('cyan', bar(f, barWidth))} ${percent(f)}  elapsed ${formatDuration(elapsed)}${etaText}`
  }

  function runningLine(id: number, j: RunningJob, width: number): string {
    const step = j.stepCount > 1 ? `  step ${Math.min(j.stepIndex + 1, j.stepCount)}/${j.stepCount}` : ''
    const speed = j.speed !== null && j.speed > 0 ? `  ${j.speed.toFixed(1)}x` : ''
    const tail = `  ${bar(j.progress, 10)}  ${percent(j.progress)}${step}${speed}`
    const head = `#${id} `
    const nameWidth = Math.max(8, Math.min(40, width - head.length - tail.length))
    const name = j.name.length > nameWidth ? j.name.slice(0, nameWidth - 1) + '…' : j.name.padEnd(nameWidth)
    return head + name + tail
  }

  function buildPanel(): string[] {
    const width = columns()
    const lines = [fit(paintedCounters(), width), fit(overallLine(width), width)]
    const room = Math.max(1, (out.rows ?? 24) - 5)
    const ids = [...view.running.keys()].sort((a, b) => a - b)
    for (const id of ids.slice(0, room)) {
      const job = view.running.get(id)
      if (job) lines.push(fit(runningLine(id, job, width), width))
    }
    if (ids.length > room) lines.push(fit(`… and ${ids.length - room} more running`, width))
    return lines
  }

  function prefix(): string {
    return `[${view.finished}/${view.counters.total}] `
  }

  function logLine(e: Extract<RunEvent, { type: 'log' }>): void {
    if (quiet) return
    const shown =
      e.level === 'warn' || ((e.level === 'info') && (opts.verbose || opts.dryRun)) ||
      (e.level === 'stderr' && opts.verbose && !opts.ignoreErrors)
    if (!shown) return
    const id = e.jobId === null ? '' : `#${e.jobId} `
    const text = cleanLine(e.line)
    if (e.level === 'warn') emit(paint('yellow', `${id}warning: ${text}`))
    else if (e.level === 'stderr') emit(paint('dim', `${id}${text}`))
    else emit(`${id}${text}`)
  }

  function scanDone(e: Extract<RunEvent, { type: 'scan-done' }>): void {
    const r = e.result
    for (const j of r.jobs) view.names.set(j.id, baseName(j.videoPath))
    const c = view.counters
    if (c.total === 0) view.counters = { ...c, total: r.jobs.length, queued: r.jobs.length, skipped: r.skipped.length }
    if (quiet) return
    emit(scanHeadline(r))
    const shown = opts.verbose ? r.skipped : r.skipped.slice(0, MAX_SKIPPED_SHOWN)
    for (const s of shown) emit(`  skipped ${s.path}: ${cleanLine(s.reason)}`)
    if (r.skipped.length > shown.length) emit(`  … and ${r.skipped.length - shown.length} more (use --verbose)`)
    if (opts.listOnly && opts.verbose) for (const j of r.jobs) emit(`  ${j.videoPath}`)
  }

  function started(e: Extract<RunEvent, { type: 'started' }>): void {
    const name = baseName(e.videoPath)
    view.names.set(e.jobId, name)
    view.runStart ??= now()
    view.running.set(e.jobId, { name, progress: 0, stepIndex: 0, stepCount: 0, speed: null, startedAt: now() })
    view.maxProcessing = Math.max(view.maxProcessing, view.running.size)
    if (!live && !quiet) emit(`${prefix()}START #${e.jobId} ${name}`)
  }

  function progress(e: Extract<RunEvent, { type: 'progress' }>): void {
    const job = view.running.get(e.jobId)
    if (!job) return
    job.progress = Math.min(1, Math.max(0, e.progress))
    job.stepIndex = e.stepIndex
    job.stepCount = e.stepCount
    job.speed = e.speed
    if (live) schedule()
  }

  function done(e: Extract<RunEvent, { type: 'done' }>): void {
    view.finish(e.jobId, e.durationMs)
    if (quiet) return
    const outputs = plural(e.outputs.length, 'output')
    const text = `#${e.jobId} ${view.nameOf(e.jobId)} ${marks.arrow} ${outputs} (${formatDuration(e.durationMs)})`
    emit(live ? `${paint('green', marks.ok)} ${text}` : `${prefix()}${marks.ok} ${text}`)
  }

  function failed(e: Extract<RunEvent, { type: 'error' }>): void {
    const ms = now() - (view.running.get(e.jobId)?.startedAt ?? now())
    view.finish(e.jobId, ms)
    const log = e.logPath ? ` (log: ${e.logPath})` : ''
    const text = `#${e.jobId} ${view.nameOf(e.jobId)}: ${cleanLine(e.message)}${log}`
    emit(live ? `${paint('red', marks.fail)} ${text}` : `${prefix()}${paint('red', marks.fail)} ${text}`)
  }

  function cancelled(e: Extract<RunEvent, { type: 'cancelled' }>): void {
    view.finish(e.jobId)
    if (quiet) return
    const text = `#${e.jobId} ${view.nameOf(e.jobId)} cancelled`
    emit(live ? `${paint('yellow', marks.cancel)} ${text}` : `${prefix()}${marks.cancel} ${text}`)
  }

  function finishedRun(e: Extract<RunEvent, { type: 'finished' }>): void {
    if (live) {
      panelOn = false
      if (timer !== undefined) clearTimeout(timer)
      render()
    }
    if (!opts.listOnly) {
      const lines = summaryLines(e.summary, { maxFailures: 50, paint, unicode })
      out.write(lines.join('\n') + '\n')
    }
    restoreCursor()
  }

  function restoreCursor(): void {
    if (cursorHidden) out.write(SHOW_CURSOR)
    cursorHidden = false
  }

  function plainCounters(): void {
    if (mode !== 'plain' || quiet || now() - lastPlainCounters < PLAIN_COUNTERS_MS) return
    lastPlainCounters = now()
    emit(countersLine(' | '))
  }

  return {
    handle(e) {
      if (closed) return
      switch (e.type) {
        case 'scan-done': return scanDone(e)
        case 'started': started(e); break
        case 'progress': progress(e); break
        case 'log': return logLine(e)
        case 'done': done(e); break
        case 'error': failed(e); break
        case 'cancelled': cancelled(e); break
        case 'counters':
          view.counters = e.counters
          if (live) schedule()
          break
        case 'finished': return finishedRun(e)
      }
      plainCounters()
    },
    close() {
      if (closed) return
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      if (live && panelOn) {
        panelOn = false
        render()
      }
      restoreCursor()
      closed = true
    }
  }
}
