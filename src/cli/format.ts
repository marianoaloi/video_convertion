import path from 'node:path'
import type { RunCounters, RunSummary, ScanResult } from '../types.js'

/** Wraps text in an ANSI style when colors are on. */
export type Paint = (style: 'red' | 'green' | 'yellow' | 'cyan' | 'dim' | 'bold', text: string) => string

const CODES = { red: 31, green: 32, yellow: 33, cyan: 36, dim: 2, bold: 1 } as const

export function makePaint(color: boolean): Paint {
  return (style, text) => (color ? `\x1b[${CODES[style]}m${text}\x1b[0m` : text)
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/y

/** Visible length of a string (ANSI sequences count 0). */
export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').length
}

/** Cuts a string to `width` visible characters, keeping ANSI sequences intact (adds a reset when cut). */
export function fit(text: string, width: number): string {
  if (visibleLength(text) <= width) return text
  let out = ''
  let seen = 0
  let i = 0
  let hadAnsi = false
  while (i < text.length && seen < width - 1) {
    ANSI.lastIndex = i
    const m = ANSI.exec(text)
    if (m) {
      out += m[0]
      i += m[0].length
      hadAnsi = true
    } else {
      out += text[i]
      i++
      seen++
    }
  }
  return out + '…' + (hadAnsi ? '\x1b[0m' : '')
}

/** Drops control characters (ffmpeg stderr can carry \r and escape codes) and collapses lines. */
export function cleanLine(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0a-\x1f\x7f]+/g, ' ').trim()
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function bar(fraction: number, width: number): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  const filled = Math.round(f * width)
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`
}

export function percent(fraction: number): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  return `${String(Math.floor(f * 100)).padStart(3)}%`
}

export function counterParts(c: RunCounters): string[] {
  const parts = [
    `Total ${c.total}`,
    `Done ${c.done}`,
    `Processing ${c.processing}`,
    `Queued ${c.queued}`,
    `Failed ${c.failed}`,
    `Skipped ${c.skipped}`
  ]
  if (c.cancelled > 0) parts.push(`Cancelled ${c.cancelled}`)
  return parts
}

export function zeroCounters(): RunCounters {
  return { total: 0, queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 }
}

export function baseName(p: string): string {
  return path.basename(p)
}

/** `Found 1234 videos: 1200 to process (30 with job file, 1170 whole video), 34 skipped (20 already done, 14 invalid)` */
export function scanHeadline(r: ScanResult): string {
  const c = r.counts
  const skipped = r.skipped.length
  const why: string[] = []
  if (c.alreadyDone > 0) why.push(`${c.alreadyDone} already done`)
  if (c.invalid > 0) why.push(`${c.invalid} invalid`)
  const other = skipped - c.alreadyDone - c.invalid
  if (other > 0) why.push(`${other} other`)
  const skipText = why.length > 0 ? `${skipped} skipped (${why.join(', ')})` : `${skipped} skipped`
  return (
    `Found ${plural(c.videos, 'video')}: ${r.jobs.length} to process ` +
    `(${c.withJson} with job file, ${c.wholeVideo} whole video), ${skipText}`
  )
}

export interface SummaryOptions {
  maxFailures: number
  paint: Paint
  unicode: boolean
}

/** The block printed when the run ends. */
export function summaryLines(s: RunSummary, o: SummaryOptions): string[] {
  const c = s.counters
  const lines = [
    '',
    `Finished in ${formatDuration(s.finishedAt - s.startedAt)}: ` +
      `${c.done} done, ${c.failed} failed, ${c.cancelled} cancelled, ${c.skipped} skipped (of ${c.total} to process)`,
    `Outputs written: ${s.outputs.length}`
  ]
  if (s.failures.length > 0) {
    lines.push(o.paint('red', `Failures (${s.failures.length}):`))
    for (const f of s.failures.slice(0, o.maxFailures)) {
      const log = f.logPath ? ` (log: ${f.logPath})` : ''
      lines.push(`  ${o.unicode ? '✗' : 'FAIL'} ${f.videoPath}: ${cleanLine(f.message)}${log}`)
    }
    if (s.failures.length > o.maxFailures) lines.push(`  … and ${s.failures.length - o.maxFailures} more`)
  }
  if (s.interrupted) {
    lines.push(o.paint('yellow', `Interrupted: stopped before every job finished (${c.cancelled} cancelled).`))
  }
  return lines
}
