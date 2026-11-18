/**
 * Finds ffmpeg / ffprobe: the explicit path first (a file, or a folder that contains the tool,
 * also its `bin` sub-folder as in a downloaded build), then a PATH walk (with PATHEXT on Windows).
 *
 * - An explicit `ffmpegPath` that does not resolve gives `ffmpeg: null` plus a warning: the user
 *   asked for that binary, so PATH is NOT used as a silent fallback (same for `ffprobePath`).
 * - ffprobe order: explicit `ffprobePath` -> `ffprobe` next to the resolved ffmpeg -> PATH.
 * - `.cmd` / `.bat` shims are skipped on purpose: they cannot be started with `shell: false`.
 * - Results are cached per configuration and PATH value; pass `noCache` (a CLI resolves once) or
 *   call `clearToolCache()` to look again.
 */
import { accessSync, constants, statSync, type Stats } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { LocatedTools, ToolsConfig } from '../types.js'
import { runProcess } from './process.js'

export type ToolName = 'ffmpeg' | 'ffprobe'

export interface LocateOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  /** Injectable for tests. */
  readonly isFile?: (candidate: string) => boolean
  /** Injectable for tests. */
  readonly isDir?: (candidate: string) => boolean
  /** Bypass the cache. */
  readonly noCache?: boolean
}

function statTest(test: (s: Stats) => boolean): (candidate: string) => boolean {
  return (candidate) => {
    try {
      return test(statSync(candidate))
    } catch {
      return false
    }
  }
}

const defaultIsFile = statTest((s) => s.isFile())
/** PATH lookups: on POSIX only executable files count (a non-executable `ffmpeg` is skipped). */
function defaultIsExecutable(candidate: string): boolean {
  if (!defaultIsFile(candidate)) return false
  if (process.platform === 'win32') return true
  try {
    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const defaultIsDir = statTest((s) => s.isDirectory())

function envValue(env: NodeJS.ProcessEnv, key: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return env[key] ?? ''
  const actual = Object.keys(env).find((k) => k.toUpperCase() === key.toUpperCase())
  return actual === undefined ? '' : (env[actual] ?? '')
}

function executableExtensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['']
  const raw = envValue(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD'
  const exts = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0)
    .filter((e) => !/^\.(cmd|bat)$/i.test(e))
  // Always try the bare name too: the user may have typed "ffmpeg.exe".
  return ['', ...(exts.length > 0 ? exts : ['.exe'])]
}

function pathLib(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** Pure PATH walk. Returns the first match or `null`. */
export function findOnPath(
  command: string,
  options: Pick<LocateOptions, 'env' | 'platform' | 'isFile'> = {}
): string | null {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const isFile = options.isFile ?? defaultIsExecutable
  const lib = pathLib(platform)
  const dirs = envValue(env, 'PATH', platform)
    .split(lib.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d.length > 0)
  const exts = executableExtensions(env, platform)
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = lib.join(dir, command + ext)
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

interface Probe {
  readonly platform: NodeJS.Platform
  readonly isFile: (candidate: string) => boolean
  readonly isDir: (candidate: string) => boolean
}

/** `name` inside `dir` (`name.exe` first on win32). */
function toolInDir(name: ToolName, dir: string, probe: Probe): string | null {
  const lib = pathLib(probe.platform)
  const exts = probe.platform === 'win32' ? ['.exe', ''] : ['']
  for (const ext of exts) {
    const candidate = lib.join(dir, `${name}${ext}`)
    if (probe.isFile(candidate)) return candidate
  }
  return null
}

/** An explicit path: a file as is, or a folder holding the tool (or its `bin` sub-folder). */
function resolveExplicit(name: ToolName, configured: string, probe: Probe): string | null {
  if (probe.isFile(configured)) return configured
  if (!probe.isDir(configured)) return null
  const lib = pathLib(probe.platform)
  return toolInDir(name, configured, probe) ?? toolInDir(name, lib.join(configured, 'bin'), probe)
}

function isGiven(value: string | null): value is string {
  return value !== null && value.length > 0
}

function explicitOrWarn(
  name: ToolName,
  configured: string,
  probe: Probe,
  warnings: string[]
): string | null {
  const found = resolveExplicit(name, configured, probe)
  if (found === null) warnings.push(`Configured ${name} path does not exist or has no ${name}: ${configured}`)
  return found
}

function siblingProbe(ffmpeg: string, probe: Probe): string | null {
  return toolInDir('ffprobe', pathLib(probe.platform).dirname(ffmpeg), probe)
}

const cache = new Map<string, LocatedTools>()

export function clearToolCache(): void {
  cache.clear()
}

/**
 * Both tools (synchronous). `ffmpeg`/`ffprobe` are `null` when not found; `warnings` explains an
 * explicit path that did not resolve.
 */
export function locateTools(config: ToolsConfig, options: LocateOptions = {}): LocatedTools {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const probe: Probe = {
    platform,
    isFile: options.isFile ?? defaultIsFile,
    isDir: options.isDir ?? defaultIsDir
  }
  const key = [config.ffmpegPath ?? '', config.ffprobePath ?? '', envValue(env, 'PATH', platform)].join('|')
  const useCache = options.noCache !== true && options.isFile === undefined
  const hit = useCache ? cache.get(key) : undefined
  if (hit !== undefined) return hit

  const warnings: string[] = []
  const pathFile = (name: ToolName): string | null => findOnPath(name, { env, platform, isFile: options.isFile ?? defaultIsExecutable })
  const ffmpeg = isGiven(config.ffmpegPath)
    ? explicitOrWarn('ffmpeg', config.ffmpegPath, probe, warnings)
    : pathFile('ffmpeg')
  let ffprobe: string | null
  if (isGiven(config.ffprobePath)) {
    ffprobe = explicitOrWarn('ffprobe', config.ffprobePath, probe, warnings)
  } else {
    ffprobe = (ffmpeg === null ? null : siblingProbe(ffmpeg, probe)) ?? pathFile('ffprobe')
  }
  const result: LocatedTools = { ffmpeg, ffprobe, warnings }
  if (useCache) cache.set(key, result)
  return result
}

// ---- console shims (win32) ---------------------------------------------------------------------

/** Scoop `<name>.shim`: a line `path = "C:\...\ffmpeg.exe"` (quotes optional). */
export function parseScoopShim(text: string): string | null {
  const match = /^\s*path\s*=\s*(.+?)\s*$/im.exec(text)
  const raw = match?.[1]?.trim().replace(/^"(.*)"$/, '$1')
  return raw === undefined || raw.length === 0 ? null : raw
}

/** Chocolatey shimgen `--shimgen-help`: ` Target: '...'` or `path to executable: ...`. */
export function parseShimgenHelp(text: string): string | null {
  const quoted = /^\s*Target:\s*'([^']+)'/im.exec(text)
  if (quoted?.[1] !== undefined) return quoted[1]
  const plain = /path to executable:\s*(.+?)\s*$/im.exec(text)
  const raw = plain?.[1]?.trim().replace(/^['"](.*)['"]$/, '$1')
  return raw === undefined || raw.length === 0 ? null : raw
}

export interface ShimOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly isFile?: (candidate: string) => boolean
  /** Runs `<shim> --shimgen-help` and returns its stdout (injectable for tests). */
  readonly shimgenHelp?: (shimPath: string) => Promise<string>
}

async function defaultShimgenHelp(shimPath: string): Promise<string> {
  const result = await runProcess({ command: shimPath, args: ['--shimgen-help'], timeoutMs: 5000 })
  return result.status === 'exited' ? `${result.stdout}\n${result.stderr}` : ''
}

function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => path.win32.normalize(p).replace(/[\\/]+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Resolves one tool; returns the real path, or the shim itself plus a warning when it cannot tell. */
async function resolveShim(
  exe: string,
  options: Required<Pick<ShimOptions, 'isFile' | 'shimgenHelp'>> & { env: NodeJS.ProcessEnv },
  warnings: string[]
): Promise<string> {
  const lib = path.win32
  if (!exe.toLowerCase().endsWith('.exe')) return exe
  const scoop = exe.slice(0, -'.exe'.length) + '.shim'
  if (options.isFile(scoop)) {
    const target = parseScoopShim(await readShim(scoop))
    if (target !== null && options.isFile(target)) return target
    warnings.push(`Could not resolve the Scoop shim ${exe}; using the shim itself`)
    return exe
  }
  const chocoRoot = envValue(options.env, 'ChocolateyInstall', 'win32')
  const inChocoBin = chocoRoot.length > 0 && sameDir(lib.dirname(exe), lib.join(chocoRoot, 'bin'))
  if (!inChocoBin && !options.isFile(`${exe}.ignore`) && !options.isFile(`${exe}.gui`)) return exe
  const target = parseShimgenHelp(await options.shimgenHelp(exe))
  if (target === null) return exe // not a shimgen shim (a real binary in that folder)
  if (options.isFile(target)) return target
  warnings.push(`The shim ${exe} points to ${target}, which does not exist; using the shim itself`)
  return exe
}

async function readShim(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * win32 only: replaces a Scoop or Chocolatey shim with the real executable it starts. Console
 * shims lose their output when spawned detached, and the real binary also receives the kill.
 * ffprobe is looked up next to the real ffmpeg when its own shim could not be resolved.
 */
export async function resolveShims(tools: LocatedTools, options: ShimOptions = {}): Promise<LocatedTools> {
  if ((options.platform ?? process.platform) !== 'win32') return tools
  const resolved = {
    env: options.env ?? process.env,
    isFile: options.isFile ?? defaultIsFile,
    shimgenHelp: options.shimgenHelp ?? defaultShimgenHelp
  }
  const warnings = [...tools.warnings]
  const ffmpeg = tools.ffmpeg === null ? null : await resolveShim(tools.ffmpeg, resolved, warnings)
  let ffprobe = tools.ffprobe === null ? null : await resolveShim(tools.ffprobe, resolved, warnings)
  const ffmpegChanged = ffmpeg !== null && ffmpeg !== tools.ffmpeg
  const shimDir = tools.ffmpeg === null ? '' : path.win32.dirname(tools.ffmpeg)
  if (ffmpegChanged && (ffprobe === null || sameDir(path.win32.dirname(ffprobe), shimDir))) {
    const sibling = toolInDir('ffprobe', path.win32.dirname(ffmpeg), { platform: 'win32', ...resolved, isDir: defaultIsDir })
    ffprobe = sibling ?? ffprobe
  }
  return { ffmpeg, ffprobe, warnings }
}
