#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  LocatedTools,
  OutputMode,
  RunConfig,
  RunController,
  RunEvent,
  RunSummary,
  SpawnPolicy,
  ToolsConfig,
  ToolsStatus
} from '../types.js'
import { parseCliArgs, usage } from './args.js'
import { createReporter } from './reporter.js'
import type { ReporterStream } from './reporter.js'

export type StartRunFn = (
  config: RunConfig,
  tools: { ffmpeg: string; ffprobe: string; spawn?: SpawnPolicy },
  emit: (e: RunEvent) => void
) => { controller: RunController; done: Promise<RunSummary> }

export interface MainDeps {
  startRun: StartRunFn
  locateTools: (config: ToolsConfig) => LocatedTools
  /** win32: replaces Chocolatey/Scoop shims with the real binaries. */
  resolveShims: (tools: LocatedTools) => Promise<LocatedTools>
  /** Whether ffmpeg can run in its own process group (first Ctrl+C lets running jobs finish). */
  detectConsoleIsolation: (ffmpegPath: string) => Promise<SpawnPolicy>
  readToolsStatus: (config: ToolsConfig) => Promise<ToolsStatus>
  stdout: ReporterStream
  stderr: NodeJS.WritableStream
  env: NodeJS.ProcessEnv
  cwd: string
  platform: NodeJS.Platform
  /** Subscribes to SIGINT/SIGTERM; returns the unsubscribe function. */
  onSignal: (handler: (signal: string) => void) => () => void
  version: string
  /** Whether an input path exists. */
  pathExists: (p: string) => boolean
  /** Kills every ffmpeg child right now (synchronous; used by the third Ctrl+C and on exit). */
  killAllChildren: () => void
  /** Removes every lock file this process holds (synchronous). */
  releaseAllLocks: () => void
  exit: (code: number) => void
}

export const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const

function findPackageJson(fromFile: string): string | null {
  let dir = path.dirname(fromFile)
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'package.json')
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

export function readVersion(): string {
  try {
    const file = findPackageJson(fileURLToPath(import.meta.url))
    const json = file ? (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }) : null
    return typeof json?.version === 'string' ? json.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

function defaultOnSignal(handler: (signal: string) => void): () => void {
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP']
  const listener = (s: NodeJS.Signals): void => handler(s)
  for (const s of signals) process.on(s, listener)
  return () => {
    for (const s of signals) process.off(s, listener)
  }
}

/** Fills the dependencies the caller did not inject; the heavy modules load only when needed. */
async function resolveDeps(deps: Partial<MainDeps> | undefined): Promise<MainDeps> {
  const d = deps ?? {}
  return {
    startRun: d.startRun ?? (await import('../jobs/run.js')).startRun,
    locateTools: d.locateTools ?? (await import('../ffmpeg/locate.js')).locateTools,
    resolveShims: d.resolveShims ?? (await import('../ffmpeg/locate.js')).resolveShims,
    detectConsoleIsolation:
      d.detectConsoleIsolation ?? (await import('../ffmpeg/isolation.js')).detectConsoleIsolation,
    readToolsStatus: d.readToolsStatus ?? (await import('../ffmpeg/tools.js')).readToolsStatus,
    stdout: d.stdout ?? process.stdout,
    stderr: d.stderr ?? process.stderr,
    env: d.env ?? process.env,
    cwd: d.cwd ?? process.cwd(),
    platform: d.platform ?? process.platform,
    onSignal: d.onSignal ?? defaultOnSignal,
    version: d.version ?? readVersion(),
    pathExists: d.pathExists ?? existsSync,
    killAllChildren: d.killAllChildren ?? (() => {}),
    releaseAllLocks: d.releaseAllLocks ?? (() => {}),
    exit: d.exit ?? ((code) => process.exit(code))
  }
}

function missingToolMessage(tool: 'ffmpeg' | 'ffprobe', platform: NodeJS.Platform): string {
  const exe = platform === 'win32' ? `${tool}.exe` : tool
  return (
    `vconv: ${tool} not found. Put ${exe} on PATH, pass --${tool} <file|folder>, ` +
    `or set VCONV_${tool.toUpperCase()}.`
  )
}

function toolsText(s: ToolsStatus, platform: NodeJS.Platform): string {
  const row = (name: string, t: ToolsStatus['ffmpeg']): string =>
    `${name.padEnd(8)}${t ? `${t.path}${t.version ? `  (version ${t.version})` : ''}` : 'not found'}`
  const lines = [row('ffmpeg', s.ffmpeg), row('ffprobe', s.ffprobe)]
  if (!s.ffmpeg) lines.push(missingToolMessage('ffmpeg', platform).replace('vconv: ', ''))
  lines.push(`H.264 encoders: ${s.h264Encoders.length > 0 ? s.h264Encoders.join(', ') : '(none)'}`)
  lines.push(`Hwaccels: ${s.hwaccels.length > 0 ? s.hwaccels.join(', ') : '(none)'}`)
  if (s.error) lines.push(`Error: ${s.error}`)
  return lines.join('\n') + '\n'
}

async function showTools(d: MainDeps, tools: ToolsConfig, json: boolean): Promise<number> {
  const status = await d.readToolsStatus(tools)
  d.stdout.write(json ? JSON.stringify(status, null, 2) + '\n' : toolsText(status, d.platform))
  return status.ffmpeg ? EXIT.ok : EXIT.usage
}

function chooseMode(requested: OutputMode, d: MainDeps): { mode: OutputMode; color: boolean } {
  const isTty = d.stdout.isTTY === true && d.env['TERM'] !== 'dumb'
  const mode: OutputMode = requested === 'tty' && !isTty ? 'plain' : requested
  const color = mode === 'tty' && d.env['NO_COLOR'] === undefined
  return { mode, color }
}

function exitCodeFor(summary: RunSummary, signals: number): number {
  if (summary.interrupted || signals > 0) return EXIT.interrupted
  return summary.counters.failed > 0 || summary.failures.length > 0 ? EXIT.failed : EXIT.ok
}

/** Runs the batch and maps the outcome to the exit code. */
async function runBatch(d: MainDeps, config: RunConfig, verbose: boolean): Promise<number> {
  const missing = config.inputs.filter((p) => !d.pathExists(p))
  if (missing.length > 0) {
    d.stderr.write(['vconv: input not found:', ...missing.map((p) => `  ${p}`), ''].join('\n'))
    return EXIT.usage
  }
  const located = await d.resolveShims(d.locateTools({ ffmpegPath: config.ffmpegPath, ffprobePath: config.ffprobePath }))
  for (const w of located.warnings) d.stderr.write(`vconv: warning: ${w}\n`)
  if (!located.ffmpeg || !located.ffprobe) {
    const tool = located.ffmpeg ? 'ffprobe' : 'ffmpeg'
    d.stderr.write(missingToolMessage(tool, d.platform) + '\n')
    return EXIT.usage
  }
  const spawn = await d.detectConsoleIsolation(located.ffmpeg)
  const { mode, color } = chooseMode(config.output, d)
  const reporter = createReporter(mode, {
    quiet: config.quiet,
    verbose,
    ignoreErrors: config.ignoreErrors,
    dryRun: config.dryRun,
    listOnly: config.listOnly,
    out: d.stdout,
    err: d.stderr,
    color
  })
  let processing = 0
  let started = false
  let sigints = 0
  let signals = 0
  let controller: RunController | null = null
  const say = (msg: string): void => {
    if (mode === 'tty' && !config.quiet) reporter.handle({ type: 'log', jobId: null, line: msg, level: 'warn' })
    else d.stderr.write(msg + '\n')
  }
  const firstInterrupt = (): void => {
    if (!spawn.detached) {
      // The console delivered Ctrl+C to the ffmpeg children too (they could not be isolated, e.g.
      // an unresolvable console shim): they are already dying, so cancel them cleanly instead of
      // letting the attempt ladder retry them.
      say('Stopping: Ctrl+C also reached the running ffmpeg processes; cancelling them.')
      controller?.abortAll()
    } else if (!started && processing === 0) {
      say('Stopping the scan... Press Ctrl+C again to abort.')
      controller?.stopLaunching()
    } else {
      say(`Stopping: no new jobs; waiting for ${processing} running job(s). Press Ctrl+C again to kill them.`)
      controller?.stopLaunching()
    }
  }
  const forceQuit = (): void => {
    d.killAllChildren()
    d.releaseAllLocks()
    d.exit(EXIT.interrupted)
  }
  const unsubscribe = d.onSignal((signal) => {
    signals++
    if (signal !== 'SIGINT') {
      say(`Received ${signal}: killing the running jobs...`)
      controller?.abortAll()
      return
    }
    sigints++
    if (sigints === 1) firstInterrupt()
    else if (sigints === 2) {
      say('Killing the running jobs...')
      controller?.abortAll()
    } else forceQuit()
  })
  try {
    const tools = { ffmpeg: located.ffmpeg, ffprobe: located.ffprobe, spawn }
    const run = d.startRun({ ...config, output: mode }, tools, (e) => {
      if (e.type === 'counters') processing = e.counters.processing
      if (e.type === 'started') started = true
      reporter.handle(e)
    })
    controller = run.controller
    return exitCodeFor(await run.done, signals)
  } catch (err) {
    reporter.close()
    d.stderr.write(`vconv: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.failed
  } finally {
    unsubscribe()
    reporter.close()
  }
}

export async function main(argv: string[], deps?: Partial<MainDeps>): Promise<number> {
  const d = await resolveDeps(deps)
  const parsed = parseCliArgs(argv, d.env, d.cwd, d.platform)
  switch (parsed.kind) {
    case 'error':
      d.stderr.write(`vconv: ${parsed.message}\nTry 'vconv --help' for usage.\n`)
      return EXIT.usage
    case 'help':
      d.stdout.write(usage())
      return EXIT.ok
    case 'version':
      d.stdout.write(`${d.version}\n`)
      return EXIT.ok
    case 'tools':
      return showTools(d, parsed.tools, parsed.json)
    case 'run':
      return runBatch(d, parsed.config, parsed.verbose)
  }
}

function sameFile(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isEntryPoint(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return sameFile(realpathSync(fileURLToPath(import.meta.url)), realpathSync(entry))
  } catch {
    return false
  }
}

/** The synchronous cleanups of the other modules; looked up by name so a missing one is harmless. */
async function loadCleanups(): Promise<{ killAllChildren: () => void; releaseAllLocks: () => void }> {
  const pick = async (files: string[], name: string): Promise<() => void> => {
    for (const file of files) {
      try {
        const fn = ((await import(file)) as Record<string, unknown>)[name]
        if (typeof fn === 'function') return fn as () => void
      } catch {
        // try the next candidate
      }
    }
    return () => {}
  }
  return {
    killAllChildren: await pick(['../ffmpeg/process.js'], 'killAllChildrenSync'),
    releaseAllLocks: await pick(['../jobs/lock.js'], 'releaseAllLocksSync')
  }
}

async function runAsEntryPoint(): Promise<number> {
  const cleanups = await loadCleanups()
  process.on('exit', () => {
    cleanups.killAllChildren()
    cleanups.releaseAllLocks()
  })
  return main(process.argv.slice(2), cleanups)
}

if (isEntryPoint()) {
  process.stdout.on('error', () => {})
  runAsEntryPoint().then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      process.stderr.write(`vconv: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
      process.exitCode = EXIT.failed
    }
  )
}
