import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { createReporter } from '../../src/cli/reporter.js'
import type { ReporterOptions, ReporterStream } from '../../src/cli/reporter.js'
import { formatDuration, visibleLength } from '../../src/cli/format.js'
import type { OutputMode, PlannedJob, RunCounters, RunEvent, RunSummary } from '../../src/types.js'

class Sink extends Writable {
  text = ''
  columns = 80
  rows = 30
  isTTY = true
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString()
    cb()
  }
}

function setup(mode: OutputMode, extra: Partial<ReporterOptions> = {}) {
  const out = new Sink()
  const err = new Sink()
  let t = 0
  const clock = { advance: (ms: number) => (t += ms) }
  const reporter = createReporter(mode, {
    quiet: false, verbose: false, ignoreErrors: false, dryRun: false, color: false,
    out: out as unknown as ReporterStream, err, now: () => t, ...extra
  })
  return { out, err, reporter, clock }
}

const job = (id: number, name: string): PlannedJob => ({
  id, videoPath: `/v/${name}`, jsonPath: null, warnings: [], root: '/v', expectedOutputs: [],
  job: {} as PlannedJob['job']
})

const counters = (o: Partial<RunCounters>): RunCounters => ({
  total: 3, queued: 0, processing: 0, done: 0, failed: 0, cancelled: 0, skipped: 2, ...o
})

const scan: RunEvent = {
  type: 'scan-done',
  result: {
    jobs: [job(1, 'a.mp4'), job(2, 'b.mp4'), job(3, 'c.mp4')],
    skipped: [{ path: '/v/old.mp4', reason: 'already done', movedTo: null }, { path: '/v/x.json', reason: 'orphan job file', movedTo: null }],
    counts: { videos: 5, withJson: 1, wholeVideo: 2, alreadyDone: 1, invalid: 1 }
  }
}

const summary = (o: Partial<RunSummary> = {}): RunSummary => ({
  counters: counters({ done: 2, failed: 1 }), startedAt: 0, finishedAt: 83_000,
  outputs: ['/v/a.mp4', '/v/b.1.mp4', '/v/b.2.mp4'], failures: [{ videoPath: '/v/c.mp4', message: 'boom', logPath: '/v/c.mp4.log' }],
  interrupted: false, ...o
})

/** Lets the throttle pass and sends one more event, so the panel is redrawn. */
function tick(r: { handle(e: RunEvent): void }, clock: { advance(ms: number): number }, c: RunCounters): void {
  clock.advance(300)
  r.handle({ type: 'counters', counters: c })
}

function script(r: { handle(e: RunEvent): void }, clock: { advance(ms: number): number }): void {
  r.handle(scan)
  r.handle({ type: 'counters', counters: counters({ queued: 3 }) })
  r.handle({ type: 'started', jobId: 1, videoPath: '/v/a.mp4', at: 0 })
  r.handle({ type: 'started', jobId: 2, videoPath: '/v/b.mp4', at: 0 })
  r.handle({ type: 'counters', counters: counters({ queued: 1, processing: 2 }) })
  r.handle({ type: 'progress', jobId: 1, progress: 0.45, stepIndex: 0, stepCount: 2, outTimeMs: 1, speed: 2.3 })
  r.handle({ type: 'log', jobId: 1, line: '$ ffmpeg -i a.mp4', level: 'info' })
  r.handle({ type: 'log', jobId: 1, line: 'deprecated thing', level: 'warn' })
  r.handle({ type: 'log', jobId: 1, line: 'frame=1 stderr', level: 'stderr' })
  clock.advance(83_000)
  r.handle({ type: 'done', jobId: 1, outputs: ['/v/a.mp4', '/v/a.1.mp4'], durationMs: 83_000 })
  r.handle({ type: 'counters', counters: counters({ queued: 1, processing: 1, done: 1 }) })
  r.handle({ type: 'error', jobId: 2, message: 'encoder failed', logPath: '/v/b.mp4.log' })
  r.handle({ type: 'cancelled', jobId: 3 })
  r.handle({ type: 'counters', counters: counters({ done: 1, failed: 1, cancelled: 1 }) })
  r.handle({ type: 'finished', summary: summary() })
}

test('formatDuration', () => {
  assert.equal(formatDuration(5000), '5s')
  assert.equal(formatDuration(83_000), '1m23s')
  assert.equal(formatDuration(3_720_000), '1h02m')
})

test('plain: lines with [done/total] prefix, scan headline, no ANSI', () => {
  const { out, reporter, clock } = setup('plain')
  script(reporter, clock)
  reporter.close()
  const t = out.text
  assert.ok(t.includes('Found 5 videos: 3 to process (1 with job file, 2 whole video), 2 skipped (1 already done, 1 invalid)'))
  assert.ok(t.includes('skipped /v/old.mp4: already done'))
  assert.ok(t.includes('[0/3] START #1 a.mp4'))
  assert.ok(t.includes('[1/3] OK #1 a.mp4 -> 2 outputs (1m23s)'))
  assert.ok(t.includes('[2/3] FAIL #2 b.mp4: encoder failed (log: /v/b.mp4.log)'))
  assert.ok(t.includes('[3/3] CANCEL #3 c.mp4 cancelled'))
  assert.ok(t.includes('#1 warning: deprecated thing'))
  assert.ok(!t.includes('$ ffmpeg'), 'info hidden without verbose/dry-run')
  assert.ok(!t.includes('frame=1 stderr'), 'stderr hidden without verbose')
  assert.ok(t.includes('Outputs written: 3'))
  assert.ok(t.includes('Failures (1):'))
  assert.ok(!t.includes('\x1b'))
})

test('plain: counters line every 10 seconds', () => {
  const { out, reporter, clock } = setup('plain')
  reporter.handle(scan)
  reporter.handle({ type: 'counters', counters: counters({ queued: 3 }) })
  clock.advance(10_500)
  reporter.handle({ type: 'started', jobId: 1, videoPath: '/v/a.mp4', at: 0 })
  assert.ok(out.text.includes('Total 3 | Done 0 | Processing 0 | Queued 3 | Failed 0 | Skipped 2'))
})

test('verbose and dry-run show info lines; stderr only when verbose and not ignoreErrors', () => {
  const dry = setup('plain', { dryRun: true })
  dry.reporter.handle({ type: 'log', jobId: 4, line: '$ ffmpeg -i in.mp4 out.mp4', level: 'info' })
  assert.ok(dry.out.text.includes('#4 $ ffmpeg -i in.mp4 out.mp4'))
  const v = setup('plain', { verbose: true })
  v.reporter.handle({ type: 'log', jobId: 1, line: 'err line', level: 'stderr' })
  assert.ok(v.out.text.includes('err line'))
  const vi = setup('plain', { verbose: true, ignoreErrors: true })
  vi.reporter.handle({ type: 'log', jobId: 1, line: 'err line', level: 'stderr' })
  assert.equal(vi.out.text, '')
})

test('json: every event is one valid JSON line and nothing else', () => {
  const { out, err, reporter, clock } = setup('json')
  script(reporter, clock)
  const lines = out.text.trimEnd().split('\n')
  assert.equal(lines.length, 15)
  const types = lines.map((l) => (JSON.parse(l) as { type: string }).type)
  assert.equal(types[0], 'scan-done')
  assert.equal(types.at(-1), 'finished')
  assert.ok(!out.text.includes('\x1b'))
  assert.equal(err.text, '')
})

test('quiet: only errors and the final summary', () => {
  const { out, reporter, clock } = setup('plain', { quiet: true })
  script(reporter, clock)
  assert.ok(!out.text.includes('Found 5'))
  assert.ok(!out.text.includes('OK #1'))
  assert.ok(!out.text.includes('START'))
  assert.ok(out.text.includes('FAIL #2'))
  assert.ok(out.text.includes('Finished in 1m23s'))
})

test('tty: panel with counters, overall bar, running job; permanent lines above', () => {
  const { out, reporter, clock } = setup('tty')
  reporter.handle(scan)
  reporter.handle({ type: 'counters', counters: counters({ queued: 3 }) })
  reporter.handle({ type: 'started', jobId: 1, videoPath: '/v/a.mp4', at: 0 })
  reporter.handle({ type: 'counters', counters: counters({ queued: 2, processing: 1 }) })
  reporter.handle({ type: 'progress', jobId: 1, progress: 0.45, stepIndex: 0, stepCount: 2, outTimeMs: 1, speed: 2.3 })
  tick(reporter, clock, counters({ queued: 2, processing: 1 }))
  reporter.close()
  const t = out.text
  assert.ok(t.includes('\x1b[?25l'), 'cursor hidden')
  assert.ok(t.includes('Total 3 │ Done 0 │ Processing 1 │ Queued 2 │ Failed 0 │ Skipped 2'))
  assert.ok(t.includes('Found 5 videos'))
  assert.ok(/#1 a\.mp4 +\[#####-----] +45% +step 1\/2 +2\.3x/.test(t), t)
  assert.ok(t.endsWith('\x1b[?25h'), 'cursor restored on close')
})

test('tty: done and fail lines are permanent, ETA appears after the first finish', () => {
  const { out, reporter, clock } = setup('tty', { color: true })
  reporter.handle(scan)
  reporter.handle({ type: 'counters', counters: counters({ queued: 3 }) })
  reporter.handle({ type: 'started', jobId: 1, videoPath: '/v/a.mp4', at: 0 })
  clock.advance(60_000)
  reporter.handle({ type: 'done', jobId: 1, outputs: ['/v/a.mp4'], durationMs: 60_000 })
  reporter.handle({ type: 'counters', counters: counters({ queued: 2, done: 1 }) })
  reporter.handle({ type: 'error', jobId: 2, message: 'bad', logPath: null })
  tick(reporter, clock, counters({ queued: 1, done: 1, failed: 1 }))
  reporter.close()
  const t = out.text
  assert.ok(t.includes('✓\x1b[0m #1 a.mp4 → 1 output (1m00s)') || t.includes('#1 a.mp4 → 1 output (1m00s)'))
  assert.ok(t.includes('#2 b.mp4: bad') || t.includes('#2 job 2: bad'))
  assert.ok(/ETA \d/.test(t), 'ETA shown')
})

test('tty: every panel line fits the terminal width, also with long names', () => {
  const { out, reporter, clock } = setup('tty')
  out.columns = 40
  const long = `${'x'.repeat(120)}.mp4`
  reporter.handle({ type: 'counters', counters: counters({ queued: 2, processing: 1 }) })
  reporter.handle({ type: 'started', jobId: 1, videoPath: `/v/${long}`, at: 0 })
  reporter.handle({ type: 'progress', jobId: 1, progress: 0.5, stepIndex: 0, stepCount: 2, outTimeMs: 1, speed: 1.5 })
  tick(reporter, clock, counters({ queued: 2, processing: 1 }))
  reporter.close()
  const panel = out.text.split('\n').filter((l) => l.includes('Total') || l.includes('#1 ') || l.includes('elapsed'))
  assert.ok(panel.length >= 3)
  for (const l of panel) assert.ok(visibleLength(l.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')) <= 40, `too wide: ${l}`)
})

test('tty: finished erases the panel, prints the summary and Interrupted', () => {
  const { out, reporter } = setup('tty')
  reporter.handle({ type: 'counters', counters: counters({ queued: 3 }) })
  reporter.handle({ type: 'finished', summary: summary({ interrupted: true }) })
  assert.ok(out.text.includes('\x1b[J'))
  assert.ok(out.text.includes('Interrupted'))
  assert.ok(out.text.includes('Failures (1):'))
  assert.ok(out.text.includes('(log: /v/c.mp4.log)'))
  assert.ok(out.text.endsWith('\x1b[?25h'))
})

test('list-only prints no run summary', () => {
  const { out, reporter } = setup('plain', { listOnly: true, verbose: true })
  reporter.handle(scan)
  reporter.handle({ type: 'finished', summary: summary() })
  assert.ok(out.text.includes('  /v/a.mp4'))
  assert.ok(!out.text.includes('Finished in'))
})

test('json: scan-done carries at most 1000 skipped items plus skippedTotal', () => {
  const { out, reporter } = setup('json')
  const skipped = Array.from({ length: 1500 }, (_, i) => ({ path: `/v/${i}.mp4`, reason: 'already done', movedTo: null }))
  reporter.handle({ type: 'scan-done', result: { jobs: [], skipped, counts: { videos: 1500, withJson: 0, wholeVideo: 0, alreadyDone: 1500, invalid: 0 } } })
  const e = JSON.parse(out.text) as { result: { skipped: unknown[]; skippedTotal: number } }
  assert.equal(e.result.skipped.length, 1000)
  assert.equal(e.result.skippedTotal, 1500)
})
