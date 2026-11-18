/**
 * Shared helpers of the integration suite: the built CLI spawned as a user would (argv, no
 * shell), real ffmpeg clips, temp folders, NDJSON parsing and counters checks.
 *
 * Build and run (from the project root):
 *   npx tsc -p tsconfig.json --outDir .tmp/tester
 *   node --test --test-concurrency=1 ".tmp/tester/tests/integration/**\/*.test.js"
 *
 * VCONV_IT_FFMPEG overrides the ffmpeg used to make clips and passed to `--ffmpeg` tests.
 */
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { locateTools, resolveShims } from '../../src/ffmpeg/locate.js'
import type { RunCounters, RunEvent } from '../../src/types.js'

const execFileP = promisify(execFile)

export const HERE = path.dirname(fileURLToPath(import.meta.url))
/** The built CLI entry point, next to this compiled file's tree. */
export const CLI = path.resolve(HERE, '../../src/cli/main.js')
export const IS_WIN = process.platform === 'win32'

/** ffmpeg/ffprobe as found on PATH (possibly console shims) and the real binaries behind them. */
async function findTools(): Promise<{ pathFfmpeg: string | null; ffmpeg: string | null; ffprobe: string | null }> {
  const configured = process.env['VCONV_IT_FFMPEG'] ?? null
  const located = locateTools({ ffmpegPath: configured, ffprobePath: null }, { noCache: true })
  const real = await resolveShims(located)
  return { pathFfmpeg: located.ffmpeg, ffmpeg: real.ffmpeg, ffprobe: real.ffprobe }
}

export const TOOLS = await findTools()
export const HAVE_FFMPEG = TOOLS.ffmpeg !== null && TOOLS.ffprobe !== null
export const SKIP = HAVE_FFMPEG ? false : 'ffmpeg/ffprobe not found'

/** Flags that make every conversion CPU-only and deterministic. */
export const CPU = ['--cpu', '--encoders', 'libx264'] as const

// ---- temp folders -----------------------------------------------------------------------------

export interface Tmp {
  readonly dir: string
  cleanup(): Promise<void>
}

export async function makeTmp(prefix = 'vconv-it-'): Promise<Tmp> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) }
}

export async function put(file: string, content: string | Buffer = ''): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

export const exists = (file: string): Promise<boolean> => access(file).then(() => true, () => false)

export async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort()
}

/** Every file under `dir` (relative paths with `/`), sorted. */
export async function tree(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.isDirectory()) await walk(path.join(d, e.name), r)
      else out.push(r)
    }
  }
  await walk(dir, '')
  return out.sort()
}

export async function md5(file: string): Promise<string> {
  return createHash('md5').update(await readFile(file)).digest('hex')
}

// ---- clips ------------------------------------------------------------------------------------

export interface ClipSpec {
  readonly w?: number
  readonly h?: number
  readonly seconds?: number
  readonly audio?: boolean
  readonly container?: 'mp4' | 'mkv'
}

const cacheDir = path.join(os.tmpdir(), `vconv-it-cache-${process.pid}`)
const cache = new Map<string, Promise<string>>()
process.on('exit', () => {
  try {
    rmSync(cacheDir, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

async function generate(spec: Required<ClipSpec>, file: string): Promise<string> {
  mkdirSync(path.dirname(file), { recursive: true })
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${spec.w}x${spec.h}:rate=25`]
  if (spec.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100')
  args.push('-t', String(spec.seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  if (spec.audio) args.push('-c:a', 'aac')
  args.push(file)
  await execFileP(TOOLS.ffmpeg as string, args, { windowsHide: true })
  return file
}

/** A real H.264 clip at `dest` (generated once per spec and process, then copied). */
export async function clip(dest: string, spec: ClipSpec = {}): Promise<string> {
  const full: Required<ClipSpec> = { w: 320, h: 240, seconds: 2, audio: true, container: 'mp4', ...spec }
  const key = `${full.w}x${full.h}-${full.seconds}s-${full.audio ? 'a' : 'na'}.${full.container}`
  let made = cache.get(key)
  if (made === undefined) {
    made = generate(full, path.join(cacheDir, key))
    cache.set(key, made)
  }
  await mkdir(path.dirname(dest), { recursive: true })
  await copyFile(await made, dest)
  return dest
}

export interface Probed {
  readonly durationMs: number
  readonly width: number
  readonly height: number
  readonly hasAudio: boolean
  readonly videoCodec: string | null
}

/** Duration, size and codecs of a media file (real ffprobe). */
export async function probe(file: string): Promise<Probed> {
  const { stdout } = await execFileP(
    TOOLS.ffprobe as string,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { windowsHide: true }
  )
  const json = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[]
  }
  const video = json.streams?.find((s) => s.codec_type === 'video')
  return {
    durationMs: Math.round(Number(json.format?.duration ?? 0) * 1000),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: json.streams?.some((s) => s.codec_type === 'audio') ?? false,
    videoCodec: video?.codec_name ?? null
  }
}

export async function probeMs(file: string): Promise<number> {
  return (await probe(file)).durationMs
}

/** |actual - expected| <= slack (300 ms by default: tighter than the CLI's own 2 s check). */
export function near(actualMs: number, expectedMs: number, slackMs = 300): boolean {
  return Math.abs(actualMs - expectedMs) <= slackMs
}

// ---- running the CLI --------------------------------------------------------------------------

/**
 * The CLI keeps a per-user ledger by default (%LOCALAPPDATA%\vconv\state.jsonl,
 * $XDG_STATE_HOME/vconv/state.jsonl). Tests point it at a throw-away folder so they never read or
 * write the user's real ledger.
 */
export const STATE_HOME = path.join(os.tmpdir(), `vconv-it-state-${process.pid}`)
process.on('exit', () => {
  try {
    rmSync(STATE_HOME, { recursive: true, force: true })
  } catch {
    // best effort
  }
})

/** `env` with the default ledger moved into `STATE_HOME`. */
export function isolatedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, LOCALAPPDATA: STATE_HOME, XDG_STATE_HOME: STATE_HOME }
}

export const DEFAULT_LEDGER = path.join(STATE_HOME, 'vconv', 'state.jsonl')

export interface CliResult {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly wallMs: number
}

export interface CliOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly cwd?: string
  readonly timeoutMs?: number
  /** Extra node flags before the script (e.g. `--import`). */
  readonly nodeArgs?: string[]
}

/** Runs `node <CLI> ...args` with argv only (no shell) and collects everything. */
export function runCli(args: readonly string[], opts: CliOptions = {}): Promise<CliResult> {
  const started = Date.now()
  const env = isolatedEnv(opts.env ?? process.env)
  delete env['FORCE_COLOR']
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), CLI, ...args], {
      shell: false,
      windowsHide: true,
      cwd: opts.cwd ?? process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => err.push(c))
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        wallMs: Date.now() - started
      })
    })
  })
}

/** Every stdout line must be a JSON object with a `type`. */
export function parseEvents(stdout: string): RunEvent[] {
  const lines = stdout.split('\n').filter((l) => l.trim() !== '')
  return lines.map((line, i) => {
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      assert.fail(`stdout line ${i + 1} is not JSON: ${line.slice(0, 200)}`)
    }
    assert.ok(typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string', `line ${i + 1} has no type`)
    return value as RunEvent
  })
}

/** `runCli` with `--json`, plus the parsed events. */
export async function runJson(args: readonly string[], opts: CliOptions = {}): Promise<CliResult & { events: RunEvent[] }> {
  const result = await runCli(['--json', ...args], opts)
  return { ...result, events: parseEvents(result.stdout) }
}

export function ofType<T extends RunEvent['type']>(events: readonly RunEvent[], type: T): Extract<RunEvent, { type: T }>[] {
  return events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type)
}

export function scanOf(events: readonly RunEvent[]): Extract<RunEvent, { type: 'scan-done' }>['result'] {
  const scan = ofType(events, 'scan-done')[0]
  assert.ok(scan, 'no scan-done event')
  return scan.result
}

export function summaryOf(events: readonly RunEvent[]): Extract<RunEvent, { type: 'finished' }>['summary'] {
  const last = events.at(-1)
  assert.equal(last?.type, 'finished', 'the last event must be finished')
  return (last as Extract<RunEvent, { type: 'finished' }>).summary
}

export function maxProcessing(events: readonly RunEvent[]): number {
  return Math.max(0, ...ofType(events, 'counters').map((e) => e.counters.processing))
}

/** Invariants every `counters` event and the summary must keep. */
export function assertCountersConsistent(events: readonly RunEvent[]): RunCounters {
  for (const { counters: c } of ofType(events, 'counters')) {
    assert.equal(c.queued + c.processing + c.done + c.failed + c.cancelled, c.total, `counters do not add up: ${JSON.stringify(c)}`)
    for (const v of Object.values(c)) assert.ok(v >= 0, `negative counter: ${JSON.stringify(c)}`)
  }
  const final = summaryOf(events).counters
  assert.equal(final.total, final.done + final.failed + final.cancelled, `final counters: ${JSON.stringify(final)}`)
  assert.equal(final.queued, 0)
  assert.equal(final.processing, 0)
  return final
}

/** Basenames of a list of paths. */
export const base = (files: readonly string[]): string[] => files.map((f) => path.basename(f)).sort()

/** A node script that appends `{ argv }` as one JSON line to `<log>`; exits with `code`. */
export async function hookScript(dir: string, log: string, code = 0): Promise<string> {
  const script = path.join(dir, `hook-${code}.cjs`)
  const body =
    `const fs = require('fs');\n` +
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');\n` +
    `process.exit(${code});\n`
  await put(script, body)
  return script
}

export async function hookCalls(log: string): Promise<string[][]> {
  if (!(await exists(log))) return []
  const text = await readFile(log, 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => (JSON.parse(l) as { argv: string[] }).argv)
}

/** A command-line string for `--upload`: every word double-quoted. */
export function commandLine(...words: string[]): string {
  return words.map((w) => (/^[{][a-z]+[}]$/.test(w) ? w : `"${w.replace(/(["\\])/g, '\\$1')}"`)).join(' ')
}

export function noAnsi(text: string): void {
  assert.ok(!text.includes('\x1b'), `ANSI escape found in: ${JSON.stringify(text.slice(0, 300))}`)
}
