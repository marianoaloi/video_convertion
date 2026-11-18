/**
 * The only way vconv starts external programs: `spawn(command, argsArray, { shell: false })`.
 * File names are argv entries, never part of a command string.
 *
 * - `runProcess()` resolves with a typed `ProcessResult` and never rejects (spawn failures,
 *   cancellation and timeouts are statuses). Output can be consumed line by line while it is produced.
 * - An `AbortSignal` or a timeout kills the whole process tree: `taskkill /pid <pid> /T /F` on
 *   Windows; on POSIX SIGTERM to the process group, then SIGKILL after `KILL_GRACE_MS`.
 * - Captured stdout/stderr keep only the LAST `MAX_CAPTURE_BYTES` so a 4-hour ffmpeg run cannot
 *   grow memory.
 */
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { ProcessRequest, ProcessResult } from '../types.js'

/** Per captured stream; the END is kept. */
export const MAX_CAPTURE_BYTES = 1024 * 1024
/** POSIX: time between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3000
/** After the process exited, how long to wait for its stdio to close before giving up on it. */
const CLOSE_GRACE_MS = 2000
const LINE_BREAK = /\r\n|\n|\r/

/** `taskkill.exe` by absolute path: a bare name could be hijacked from the working directory. */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? 'C:\\Windows'
  return path.win32.join(systemRoot, 'System32', 'taskkill.exe')
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** Live children, so they can be killed when vconv itself dies. */
const liveChildren = new Set<ChildProcess>()

/**
 * Kills every live child (and its tree) synchronously; safe to call from `process.on('exit')`.
 * POSIX: SIGKILL to each process group. win32: `taskkill /pid <pid> /T /F`. Errors are ignored.
 */
export function killAllChildrenSync(): void {
  for (const child of liveChildren) {
    const pid = child.pid
    if (pid === undefined) continue
    try {
      if (process.platform === 'win32') {
        spawnSync(taskkillPath(), ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' })
      } else {
        process.kill(-pid, 'SIGKILL')
      }
    } catch {
      // already gone
    }
  }
  liveChildren.clear()
}

/** Asks `child` and everything it started to end. Never throws. */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn(taskkillPath(), ['/pid', String(pid), '/T', '/F'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    })
    killer.on('error', () => {
      child.kill('SIGKILL')
    })
    return
  }
  signalGroup(child, 'SIGTERM')
  const timer = setTimeout(() => {
    signalGroup(child, 'SIGKILL')
  }, KILL_GRACE_MS)
  timer.unref()
  child.once('exit', () => {
    clearTimeout(timer)
    // Members of the group may outlive the leader: make sure none keeps the pipes open.
    signalGroup(child, 'SIGKILL')
  })
}

/** Splits a byte stream into lines, flushing the partial last line at the end. */
class LineSplitter {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: Buffer): void {
    this.feed(this.decoder.write(chunk))
  }

  end(): void {
    this.feed(this.decoder.end())
    if (this.pending.length > 0) this.onLine(this.pending)
    this.pending = ''
  }

  private feed(text: string): void {
    if (text.length === 0) return
    const parts = (this.pending + text).split(LINE_BREAK)
    this.pending = parts.pop() ?? ''
    for (const line of parts) this.onLine(line)
  }
}

/** Keeps the last `limit` bytes of a stream. */
class TailCapture {
  private chunks: Buffer[] = []
  private size = 0

  constructor(
    private readonly enabled: boolean,
    private readonly limit: number
  ) {}

  push(chunk: Buffer): void {
    if (!this.enabled) return
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.chunks.length > 1 && this.size - (this.chunks[0]?.length ?? 0) >= this.limit) {
      this.size -= this.chunks.shift()?.length ?? 0
    }
  }

  text(): string {
    const all = Buffer.concat(this.chunks)
    return (all.length > this.limit ? all.subarray(all.length - this.limit) : all).toString('utf8')
  }
}

function spawnOptions(request: ProcessRequest): SpawnOptions {
  return {
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // POSIX: a new process group lets us signal the whole tree and keeps the terminal's SIGINT
    // away from the child. win32: `detached` (DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP) keeps
    // the console's Ctrl+C away too, but a console shim (chocolatey/scoop) loses its output
    // then, so the default stays off there; see `detectConsoleIsolation`.
    detached: request.detached ?? process.platform !== 'win32',
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    env: request.env === undefined ? process.env : { ...process.env, ...request.env }
  }
}

interface ErrorInfo {
  code?: string
  message: string
}

function errorInfo(error: unknown): ErrorInfo {
  const err = error instanceof Error ? error : new Error(String(error))
  const code: unknown = Reflect.get(err, 'code')
  return typeof code === 'string' ? { code, message: err.message } : { message: err.message }
}

type Finish = (status: ProcessResult['status'], exitCode: number | null, error?: ErrorInfo) => ProcessResult

/** Runs a program to completion. Never rejects. */
export function runProcess(request: ProcessRequest): Promise<ProcessResult> {
  const outCapture = new TailCapture(request.captureStdout !== false, request.maxCaptureBytes ?? MAX_CAPTURE_BYTES)
  const errCapture = new TailCapture(request.captureStderr !== false, request.maxCaptureBytes ?? MAX_CAPTURE_BYTES)
  const finish: Finish = (status, exitCode, error) => ({
    status,
    exitCode,
    stdout: outCapture.text(),
    stderr: errCapture.text(),
    ...(error === undefined ? {} : { error })
  })
  if (request.signal?.aborted === true) return Promise.resolve(finish('cancelled', null))

  let child: ChildProcess
  try {
    child = spawn(request.command, [...request.args], spawnOptions(request))
  } catch (error: unknown) {
    // spawn throws synchronously for invalid arguments (e.g. NUL bytes).
    return Promise.resolve(finish('spawn-error', null, errorInfo(error)))
  }
  liveChildren.add(child)
  child.once('exit', () => liveChildren.delete(child))
  return new Promise<ProcessResult>((resolve) => {
    watch(child, request, { out: outCapture, err: errCapture }, finish, resolve)
  })
}

interface Captures {
  readonly out: TailCapture
  readonly err: TailCapture
}

function watch(
  child: ChildProcess,
  request: ProcessRequest,
  captures: Captures,
  finish: Finish,
  resolve: (result: ProcessResult) => void
): void {
  const { signal } = request
  let cancelled = false
  let timedOut = false
  let spawnError: Error | null = null
  let settled = false
  let exitTimer: NodeJS.Timeout | null = null

  const outLines = request.onStdoutLine === undefined ? null : new LineSplitter(request.onStdoutLine)
  const errLines = request.onStderrLine === undefined ? null : new LineSplitter(request.onStderrLine)

  const onAbort = (): void => {
    cancelled = true
    killProcessTree(child)
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  const timer =
    request.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true
          killProcessTree(child)
        }, request.timeoutMs)

  child.stdout?.on('data', (chunk: Buffer) => {
    captures.out.push(chunk)
    outLines?.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    captures.err.push(chunk)
    errLines?.push(chunk)
  })

  const settle = (code: number | null): void => {
    if (settled) return
    settled = true
    if (timer !== null) clearTimeout(timer)
    if (exitTimer !== null) clearTimeout(exitTimer)
    signal?.removeEventListener('abort', onAbort)
    outLines?.end()
    errLines?.end()
    if (spawnError !== null && child.pid === undefined) {
      resolve(finish('spawn-error', null, errorInfo(spawnError)))
      return
    }
    resolve(finish(timedOut ? 'timeout' : cancelled ? 'cancelled' : 'exited', code))
  }

  child.once('error', (error: Error) => {
    spawnError = error
    // A failed spawn may emit no `close`.
    if (child.pid === undefined) settle(null)
  })
  // `close` fires after the process ended AND its stdio streams closed.
  child.once('close', (code: number | null) => {
    settle(code)
  })
  // A grandchild that keeps the pipes open must not hang the promise.
  child.once('exit', (code: number | null) => {
    exitTimer = setTimeout(() => {
      child.stdout?.destroy()
      child.stderr?.destroy()
      settle(code)
    }, CLOSE_GRACE_MS)
    exitTimer.unref()
  })
}
