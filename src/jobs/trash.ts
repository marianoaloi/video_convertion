/**
 * Removes a file permanently or sends it to the trash. A trash request never falls back to a
 * permanent delete: when the file cannot be trashed safely, it is kept and the call rejects.
 *
 * - win32: PowerShell reads the volume's Recycle Bin facts first (`trashPolicy`), the policy
 *   decides, and only then is the file recycled and its `$I` record looked up. The path travels
 *   in `$env:VCONV_TRASH_PATH` only; it is never part of a script or an argument.
 * - linux: `gio trash`, or the freedesktop.org home trash when gio is not installed.
 * - darwin: Finder through `osascript`, the path passed as a script argument.
 *
 * Every platform checks afterwards that the file is really gone.
 */
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runProcess } from '../ffmpeg/process.js'
import { DEFAULTS, type DeleteMode } from '../types.js'
import { errorCodeOf, exists, isNotFound, messageOf } from './paths.js'
import {
  WIN_DELETE_SCRIPT,
  WIN_FACTS_SCRIPT,
  checkRecycled,
  decideWindowsTrash,
  parseTrashFacts,
  type TrashFacts
} from './trashPolicy.js'

/** Runs a program and resolves with its stdout; rejects when it cannot start or fails. */
export type TrashExec = (command: string, args: string[], env: NodeJS.ProcessEnv) => Promise<string | void>

export interface TrashOptions {
  /** Default: `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Default: runs the program with a `DEFAULTS.trashTimeoutMs` timeout. */
  readonly exec?: TrashExec
  /** Base environment of the trash programs, and where `XDG_DATA_HOME`/`HOME` are read. */
  readonly env?: NodeJS.ProcessEnv
}

const STILL_THERE = 'the file is still there after moving it to the trash'
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'] as const

export async function removeFile(target: string, mode: DeleteMode, options: TrashOptions = {}): Promise<void> {
  if (mode === 'permanent') {
    await rm(target)
    return
  }
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? runTool
  const env = options.env ?? process.env
  const absolute = path.resolve(target)
  switch (platform) {
    case 'win32':
      return trashWindows(absolute, exec, env)
    case 'linux':
      return trashLinux(absolute, exec, env)
    case 'darwin':
      return trashMac(absolute, exec, env)
    default:
      throw new Error(`Not moved to the trash: the trash is not supported on ${platform}`)
  }
}

async function trashWindows(absolute: string, exec: TrashExec, baseEnv: NodeJS.ProcessEnv): Promise<void> {
  if (absolute.startsWith('\\\\?\\')) {
    throw new Error('Not moved to the trash: extended-length (\\\\?\\) paths cannot be sent to the Recycle Bin')
  }
  const env: NodeJS.ProcessEnv = { ...baseEnv, VCONV_TRASH_PATH: absolute }
  let facts: TrashFacts
  try {
    facts = parseTrashFacts(String((await exec('powershell.exe', [...PS_ARGS, WIN_FACTS_SCRIPT], env)) ?? ''))
  } catch (error) {
    throw new Error(`Cannot check the Recycle Bin, the file was kept: ${messageOf(error)}`)
  }
  const decision = decideWindowsTrash(facts)
  if (!decision.ok) throw new Error(`Not moved to the trash: ${decision.reason}`)

  let output: string
  try {
    output = String((await exec('powershell.exe', [...PS_ARGS, WIN_DELETE_SCRIPT], env)) ?? '')
  } catch (error) {
    // The script may have died after the delete ran: say which state the file is in.
    const state = (await exists(absolute)) ? 'the file was kept' : 'the file is gone, check the Recycle Bin'
    throw new Error(`${messageOf(error)} (${state})`)
  }
  if (await exists(absolute)) throw new Error(STILL_THERE)
  const check = checkRecycled(output, absolute)
  // When the bin cannot be read the pre-flight's verdict stands; a readable bin without a record
  // means Windows deleted the file for good despite it.
  if (!check.found && check.unreadable === null) {
    throw new Error('the file is gone but the Recycle Bin has no record of it: it may have been deleted permanently')
  }
}

async function trashLinux(absolute: string, exec: TrashExec, env: NodeJS.ProcessEnv): Promise<void> {
  try {
    await exec('gio', ['trash', absolute], env)
  } catch (error) {
    if (errorCodeOf(error) !== 'ENOENT') throw error
    await trashFreedesktop(absolute, env)
    return
  }
  if (await exists(absolute)) throw new Error(STILL_THERE)
}

const MAC_SCRIPT = [
  'on run argv',
  'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
  'end run'
]

async function trashMac(absolute: string, exec: TrashExec, env: NodeJS.ProcessEnv): Promise<void> {
  // `as alias` resolves a symlink to its target, which Finder would then trash instead of the link.
  if ((await lstat(absolute)).isSymbolicLink()) {
    throw new Error('Not moved to the trash: the file is a symbolic link')
  }
  await exec('osascript', [...MAC_SCRIPT.flatMap((line) => ['-e', line]), absolute], env)
  if (await exists(absolute)) throw new Error(STILL_THERE)
}

// ---- freedesktop.org home trash ---------------------------------------------------------------

/** The most `name.N` variants tried before giving up. */
const MAX_TRASH_NAMES = 10_000

/**
 * Moves `target` into `$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`) as the
 * freedesktop.org Trash spec describes: the `.trashinfo` file is created exclusively first to
 * reserve the name, then the file is renamed into `files/`. A file on another filesystem than the
 * trash is refused rather than copied.
 */
export async function trashFreedesktop(target: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const absolute = path.resolve(target)
  const dataHome = absoluteOr(env['XDG_DATA_HOME'], () => path.join(absoluteOr(env['HOME'], os.homedir), '.local', 'share'))
  const filesDir = path.join(dataHome, 'Trash', 'files')
  const infoDir = path.join(dataHome, 'Trash', 'info')
  await mkdir(filesDir, { recursive: true, mode: 0o700 })
  await mkdir(infoDir, { recursive: true, mode: 0o700 })

  const base = path.basename(absolute)
  const info = `[Trash Info]\nPath=${encodeTrashPath(absolute)}\nDeletionDate=${deletionDate(new Date())}\n`
  for (let n = 0; n < MAX_TRASH_NAMES; n++) {
    const name = trashName(base, n)
    const infoPath = path.join(infoDir, `${name}.trashinfo`)
    const filePath = path.join(filesDir, name)
    if (!(await reserve(infoPath, info))) continue
    try {
      if (await pathTaken(filePath)) {
        await rm(infoPath, { force: true })
        continue
      }
      await rename(absolute, filePath)
      return
    } catch (error) {
      await rm(infoPath, { force: true })
      if (errorCodeOf(error) === 'EXDEV') {
        throw new Error(`Not moved to the trash: ${absolute} is on another filesystem than ${filesDir}`)
      }
      throw error
    }
  }
  throw new Error(`Not moved to the trash: no free name for ${base} in ${filesDir}`)
}

/** `value` when it is an absolute path, else `fallback()`. */
function absoluteOr(value: string | undefined, fallback: () => string): string {
  return value !== undefined && path.isAbsolute(value) ? value : fallback()
}

const NAME_MAX = 255
const TRASHINFO_SUFFIX = '.trashinfo'

/** `base`, or `base.N`, with the stem shortened so that `<name>.trashinfo` fits in NAME_MAX bytes. */
function trashName(base: string, n: number): string {
  const suffix = n === 0 ? '' : `.${n}`
  let stem = base
  while (Buffer.byteLength(stem + suffix + TRASHINFO_SUFFIX) > NAME_MAX && stem.length > 1) stem = stem.slice(0, -1)
  return stem + suffix
}

/** Creates `file` only when it does not exist yet. False when it already does. */
async function reserve(file: string, content: string): Promise<boolean> {
  let handle
  try {
    handle = await open(file, 'wx', 0o600)
  } catch (error) {
    if (errorCodeOf(error) === 'EEXIST') return false
    throw error
  }
  try {
    await handle.writeFile(content, 'utf8')
  } catch (error) {
    await rm(file, { force: true })
    throw error
  } finally {
    await handle.close()
  }
  return true
}

async function pathTaken(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

/** The absolute path, each segment URL-escaped (RFC 2396) as the spec asks. */
function encodeTrashPath(absolute: string): string {
  return absolute.split(path.sep).map(encodeURIComponent).join('/')
}

/** `YYYY-MM-DDThh:mm:ss` in local time. */
function deletionDate(date: Date): string {
  const two = (v: number): string => String(v).padStart(2, '0')
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}` +
    `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  )
}

// ---- running the trash programs ---------------------------------------------------------------

/** `powershell.exe` by absolute path: a bare name could be hijacked from the working directory. */
function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? env['windir'] ?? 'C:\\Windows'
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

async function runTool(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const program = process.platform === 'win32' && command === 'powershell.exe' ? windowsPowerShellPath(env) : command
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value
  const result = await runProcess({ command: program, args, env: defined, timeoutMs: DEFAULTS.trashTimeoutMs })
  switch (result.status) {
    case 'spawn-error': {
      const error = new Error(`${command} could not start: ${result.error?.message ?? 'unknown error'}`)
      throw result.error?.code === undefined ? error : Object.assign(error, { code: result.error.code })
    }
    case 'timeout':
      throw new Error(`${command} did not finish within ${DEFAULTS.trashTimeoutMs / 1000} s`)
    case 'cancelled':
      throw new Error(`${command} was cancelled`)
    case 'exited':
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim()).replace(/\s+/g, ' ')
        throw new Error(`${command} failed (exit ${result.exitCode})${detail === '' ? '' : `: ${detail}`}`)
      }
      return result.stdout
  }
}
