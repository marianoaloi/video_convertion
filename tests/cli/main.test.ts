import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { main } from '../../src/cli/main.js'
import type { MainDeps } from '../../src/cli/main.js'
import type { RunConfig, RunCounters, RunEvent, RunSummary, ToolsStatus } from '../../src/types.js'

class Sink extends Writable {
  text = ''
  columns = 80
  isTTY = false
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    this.text += chunk.toString()
    cb()
  }
}

const counters = (o: Partial<RunCounters> = {}): RunCounters => ({
  total: 2, queued: 0, processing: 0, done: 2, failed: 0, cancelled: 0, skipped: 0, ...o
})

const summary = (o: Partial<RunSummary> = {}): RunSummary => ({
  counters: counters(), startedAt: 0, finishedAt: 1000, outputs: ['/o.mp4'], failures: [], interrupted: false, ...o
})

interface Fake {
  deps: Partial<MainDeps>
  out: Sink
  err: Sink
  calls: string[]
  configs: RunConfig[]
  fireSignal(signal?: string): void
  finish(s: RunSummary): void
}

/** `startRun` that emits the scan-done/counters, then waits for `finish()`. */
function fake(
  opts: { ffmpeg?: string | null; ffprobe?: string | null; auto?: RunSummary; detached?: boolean } = {}
): Fake {
  const out = new Sink()
  const err = new Sink()
  const calls: string[] = []
  const configs: RunConfig[] = []
  let handler: ((s: string) => void) | null = null
  let release: (s: RunSummary) => void = () => {}
  const deps: Partial<MainDeps> = {
    stdout: out as unknown as MainDeps['stdout'],
    stderr: err,
    env: {},
    cwd: process.cwd(),
    platform: 'linux',
    version: '9.9.9',
    pathExists: () => true,
    killAllChildren: () => void calls.push('kill'),
    releaseAllLocks: () => void calls.push('locks'),
    exit: (code) => void calls.push(`exit ${code}`),
    locateTools: () => ({
      ffmpeg: opts.ffmpeg === undefined ? '/bin/ffmpeg' : opts.ffmpeg,
      ffprobe: opts.ffprobe === undefined ? '/bin/ffprobe' : opts.ffprobe,
      warnings: ['using the one on PATH']
    }),
    resolveShims: async (tools) => tools,
    detectConsoleIsolation: async () => ({ detached: opts.detached ?? true }),
    readToolsStatus: async (): Promise<ToolsStatus> => ({
      ffmpeg: { path: '/bin/ffmpeg', version: '6.1' }, ffprobe: { path: '/bin/ffprobe', version: '6.1' },
      h264Encoders: ['libx264'], hwaccels: ['cuda'], error: null
    }),
    onSignal: (h) => {
      handler = h
      return () => {
        handler = null
      }
    },
    startRun: (config, _tools, emit: (e: RunEvent) => void) => {
      configs.push(config)
      emit({ type: 'counters', counters: counters({ processing: 2, done: 0 }) })
      const done = opts.auto
        ? Promise.resolve(opts.auto)
        : new Promise<RunSummary>((resolve) => {
            release = resolve
          })
      return {
        controller: { stopLaunching: () => void calls.push('stop'), abortAll: () => void calls.push('abort') },
        done: done.then((s) => {
          emit({ type: 'finished', summary: s })
          return s
        })
      }
    }
  }
  return { deps, out, err, calls, configs, fireSignal: (signal = 'SIGINT') => handler?.(signal), finish: (s) => release(s) }
}

test('exit 0 when every job is done, 1 when one failed', async () => {
  const ok = fake({ auto: summary() })
  assert.equal(await main(['videos'], ok.deps), 0)
  const bad = fake({ auto: summary({ counters: counters({ failed: 1, done: 1 }), failures: [{ videoPath: '/v', message: 'x', logPath: null }] }) })
  assert.equal(await main(['videos'], bad.deps), 1)
})

test('exit 2 on usage errors with a hint', async () => {
  const f = fake()
  assert.equal(await main(['--bogus'], f.deps), 2)
  assert.match(f.err.text, /--help/)
  assert.equal(await main([], f.deps), 2)
})

test('help and version exit 0', async () => {
  const f = fake()
  assert.equal(await main(['--help'], f.deps), 0)
  assert.match(f.out.text, /USAGE/)
  const g = fake()
  assert.equal(await main(['--version'], g.deps), 0)
  assert.equal(g.out.text, '9.9.9\n')
})

test('missing ffmpeg or ffprobe names the flags and exits 2', async () => {
  const f = fake({ ffmpeg: null })
  assert.equal(await main(['videos'], f.deps), 2)
  assert.match(f.err.text, /ffmpeg not found/)
  assert.match(f.err.text, /--ffmpeg/)
  assert.match(f.err.text, /PATH/)
  assert.equal(f.configs.length, 0)
  const g = fake({ ffprobe: null })
  assert.equal(await main(['videos'], g.deps), 2)
  assert.match(g.err.text, /--ffprobe/)
})

test('locate warnings are printed to stderr', async () => {
  const f = fake({ auto: summary() })
  await main(['videos'], f.deps)
  assert.match(f.err.text, /using the one on PATH/)
})

test('--tools prints versions; exit 2 when ffmpeg is missing; --json prints JSON', async () => {
  const f = fake()
  assert.equal(await main(['--tools'], f.deps), 0)
  assert.match(f.out.text, /ffmpeg\s+\/bin\/ffmpeg\s+\(version 6\.1\)/)
  assert.match(f.out.text, /H\.264 encoders: libx264/)
  assert.match(f.out.text, /Hwaccels: cuda/)
  const j = fake()
  assert.equal(await main(['--tools', '--json'], j.deps), 0)
  assert.equal((JSON.parse(j.out.text) as ToolsStatus).h264Encoders[0], 'libx264')
  const none = fake()
  none.deps.readToolsStatus = async () => ({ ffmpeg: null, ffprobe: null, h264Encoders: [], hwaccels: [], error: null })
  assert.equal(await main(['--tools'], none.deps), 2)
  assert.match(none.out.text, /not found/)
})

test('two-stage Ctrl+C: stopLaunching, then abortAll, exit 130', async () => {
  const f = fake()
  const result = main(['videos'], f.deps)
  await new Promise((r) => setImmediate(r))
  f.fireSignal()
  assert.deepEqual(f.calls, ['stop'])
  assert.match(f.err.text, /Stopping: no new jobs; waiting for 2 running job\(s\)\. Press Ctrl\+C again to kill them\./)
  f.fireSignal()
  assert.deepEqual(f.calls, ['stop', 'abort'])
  f.fireSignal()
  assert.deepEqual(f.calls, ['stop', 'abort', 'kill', 'locks', 'exit 130'], 'a third press force-quits')
  f.finish(summary({ interrupted: true, counters: counters({ cancelled: 2, done: 0 }) }))
  assert.equal(await result, 130)
})

test('Ctrl+C without console isolation (unresolvable win32 shim) cancels the running jobs at once', async () => {
  const f = fake({ detached: false })
  const result = main(['videos'], f.deps)
  await new Promise((r) => setImmediate(r))
  f.fireSignal()
  assert.deepEqual(f.calls, ['abort'])
  assert.match(f.err.text, /Ctrl\+C also reached the running ffmpeg processes/)
  f.finish(summary({ interrupted: true, counters: counters({ cancelled: 2, done: 0 }) }))
  assert.equal(await result, 130)
})

test('the spawn policy and the resolved shim targets reach startRun', async () => {
  const f = fake({ auto: summary(), detached: true })
  let seen: unknown = null
  const startRun = f.deps.startRun!
  f.deps.resolveShims = async (t) => ({ ...t, ffmpeg: '/real/ffmpeg' })
  f.deps.startRun = (config, tools, emit) => {
    seen = tools
    return startRun(config, tools, emit)
  }
  assert.equal(await main(['videos'], f.deps), 0)
  assert.deepEqual(seen, { ffmpeg: '/real/ffmpeg', ffprobe: '/bin/ffprobe', spawn: { detached: true } })
})

test('--json writes only JSON lines to stdout', async () => {
  const f = fake({ auto: summary() })
  assert.equal(await main(['--json', 'videos'], f.deps), 0)
  const lines = f.out.text.trimEnd().split('\n')
  assert.ok(lines.length >= 2)
  for (const l of lines) JSON.parse(l)
  assert.equal(f.configs[0]?.output, 'json')
})

test('tty is chosen only when stdout is a terminal; --plain forces plain', async () => {
  const a = fake({ auto: summary() })
  await main(['videos'], a.deps)
  assert.equal(a.configs[0]?.output, 'plain')
  const b = fake({ auto: summary() })
  b.out.isTTY = true
  await main(['videos'], b.deps)
  assert.equal(b.configs[0]?.output, 'tty')
  assert.ok(b.out.text.includes('\x1b[?25l'))
  const c = fake({ auto: summary() })
  c.out.isTTY = true
  await main(['--plain', 'videos'], c.deps)
  assert.equal(c.configs[0]?.output, 'plain')
  assert.ok(!c.out.text.includes('\x1b'))
})

test('missing inputs are listed and exit 2 before anything starts', async () => {
  const f = fake({ auto: summary() })
  f.deps.pathExists = (p) => !p.endsWith('gone')
  assert.equal(await main(['here', 'gone', 'also-gone'], f.deps), 2)
  assert.match(f.err.text, /input not found/)
  assert.match(f.err.text, /gone/)
  assert.equal(f.configs.length, 0)
})

test('third Ctrl+C kills children, releases locks and exits 130', async () => {
  const f = fake()
  const result = main(['videos'], f.deps)
  await new Promise((r) => setImmediate(r))
  f.fireSignal()
  f.fireSignal()
  f.fireSignal()
  assert.deepEqual(f.calls, ['stop', 'abort', 'kill', 'locks', 'exit 130'])
  f.finish(summary({ interrupted: true }))
  await result
})

test('SIGTERM and SIGHUP abort the running jobs at once', async () => {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    const f = fake()
    const result = main(['videos'], f.deps)
    await new Promise((r) => setImmediate(r))
    f.fireSignal(sig)
    assert.deepEqual(f.calls, ['abort'], sig)
    f.finish(summary({ interrupted: true }))
    assert.equal(await result, 130)
  }
})

test('Ctrl+C during the scan says so instead of "0 running jobs"', async () => {
  const f = fake()
  let release: (s: RunSummary) => void = () => {}
  f.deps.startRun = (_config, _t, emit) => {
    emit({ type: 'counters', counters: counters({ processing: 0, done: 0 }) })
    return {
      controller: { stopLaunching: () => void f.calls.push('stop'), abortAll: () => void f.calls.push('abort') },
      done: new Promise<RunSummary>((r) => {
        release = r
      })
    }
  }
  const run = main(['videos'], f.deps)
  await new Promise((r) => setImmediate(r))
  f.fireSignal()
  assert.match(f.err.text, /Stopping the scan/)
  assert.ok(!f.err.text.includes('0 running'))
  release(summary({ interrupted: true }))
  assert.equal(await run, 130)
})
