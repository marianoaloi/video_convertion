import { parseArgs } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { DEFAULTS } from '../types.js'
import type {
  CommandTemplate,
  DeleteMode,
  HookContext,
  ExistingPolicy,
  Hwaccel,
  JobDefaults,
  Rect,
  RunConfig,
  SourceMode,
  ToolsConfig
} from '../types.js'
import { DEFAULT_VIDEO_EXTENSIONS, parseExtensionList } from '../core/videoFiles.js'
import { expandTemplate, parseCommandTemplate } from '../core/template.js'

export { usage } from './usage.js'

export type ParsedCli =
  /** `config.output` is the REQUESTED mode: 'json', 'plain', or 'tty' = "live panel if stdout is a terminal". */
  | { kind: 'run'; config: RunConfig; verbose: boolean }
  | { kind: 'tools'; tools: ToolsConfig; json: boolean }
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'error'; message: string }

const OPTIONS = {
  recursive: { type: 'boolean', short: 'r' },
  source: { type: 'string' },
  force: { type: 'boolean' },
  ext: { type: 'string' },
  parallel: { type: 'string', short: 'j' },
  ffmpeg: { type: 'string' },
  ffprobe: { type: 'string' },
  encoders: { type: 'string' },
  hwaccel: { type: 'string' },
  cpu: { type: 'boolean' },
  'same-size': { type: 'boolean' },
  'max-side': { type: 'string' },
  'max-rate': { type: 'string' },
  'min-output-bytes': { type: 'string' },
  'keep-parts': { type: 'boolean' },
  'ignore-errors': { type: 'boolean' },
  'verbose-ffmpeg': { type: 'boolean' },
  'stall-timeout': { type: 'string' },
  'hook-timeout': { type: 'string' },
  size: { type: 'string' },
  rate: { type: 'string' },
  crop: { type: 'string' },
  bright: { type: 'string' },
  contrast: { type: 'string' },
  transpose: { type: 'string' },
  'convert-first': { type: 'boolean' },
  existing: { type: 'string' },
  'delete-original': { type: 'boolean' },
  'delete-mode': { type: 'string' },
  upload: { type: 'string' },
  'upload-all': { type: 'string' },
  'move-orphans': { type: 'boolean' },
  state: { type: 'string' },
  'no-state': { type: 'boolean' },
  'log-file': { type: 'string' },
  'no-failure-log': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  list: { type: 'boolean' },
  json: { type: 'boolean' },
  plain: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  verbose: { type: 'boolean' },
  tools: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
} as const

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values']

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message)
}

function oneOf<T extends string>(flag: string, text: string, allowed: readonly T[]): T {
  const found = allowed.find((a) => a === text)
  return found ?? fail(`${flag}: "${text}" is not valid; use ${allowed.join(', ')}`)
}

function intIn(flag: string, text: string, min: number, max: number): number {
  const ok = /^\d+$/.test(text.trim())
  const n = ok ? Number(text.trim()) : NaN
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fail(`${flag}: "${text}" must be a whole number from ${min} to ${max}`)
  }
  return n
}

function numIn(flag: string, text: string, min: number, max: number): number {
  const n = text.trim() === '' ? NaN : Number(text)
  if (!Number.isFinite(n) || n < min || n > max) fail(`${flag}: "${text}" must be a number from ${min} to ${max}`)
  return n
}

function parseSize(text: string): string {
  const t = text.trim()
  if (t === '-1') return '-1'
  const m = /^(\d+)[xX:](\d+)$/.exec(t)
  const w = Number(m?.[1])
  const h = Number(m?.[2])
  if (!m || w < 1 || h < 1) fail(`--size: "${text}" must look like 640x360, 640:360 or -1`)
  return `${w}x${h}`
}

function parseCrop(text: string): Rect {
  const m = /^(\d+):(\d+):(\d+):(\d+)$/.exec(text.trim())
  if (!m) fail(`--crop: "${text}" must look like x:y:w:h (pixels, e.g. 0:0:1280:720)`)
  const [x, y, w, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (w < 1 || h < 1) fail(`--crop: width and height must be at least 1 (got ${w}x${h})`)
  return { x, y, w, h }
}

function parseTranspose(text: string): number {
  const n = numIn('--transpose', text, -3600, 3600)
  if (!Number.isInteger(n) || n % 90 !== 0) fail(`--transpose: "${text}" must be a multiple of 90 degrees`)
  return n
}

function parseEncoders(text: string): string[] {
  const list = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (list.length === 0) fail('--encoders: give at least one encoder, e.g. h264_nvenc,libx264')
  for (const e of list) if (!/^[A-Za-z0-9_]+$/.test(e)) fail(`--encoders: "${e}" is not a valid encoder name`)
  return list
}

/** Placeholders each hook receives; a template using any other one is rejected at parse time. */
const HOOK_CONTEXTS: Record<string, HookContext> = {
  '--upload': { file: 'f', outputs: ['o'], dir: 'd', root: 'r', md5: 'm' },
  '--upload-all': { outputs: ['o'], files: ['f'], dir: 'd' }
}

function template(flag: string, text: string): CommandTemplate {
  try {
    const parsed = parseCommandTemplate(text)
    if (/[.](bat|cmd)$/i.test(parsed.command)) {
      fail(
        `${flag}: batch files (.bat/.cmd) cannot receive file names safely; use an .exe or ` +
          `"powershell -NoProfile -File script.ps1 {outputs}"`
      )
    }
    expandTemplate(parsed, HOOK_CONTEXTS[flag] ?? {})
    return parsed
  } catch (err) {
    return fail(`${flag}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function extensions(text: string | undefined): string[] {
  if (text === undefined) return [...DEFAULT_VIDEO_EXTENSIONS]
  try {
    return parseExtensionList(text)
  } catch (err) {
    return fail(`--ext: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function resolveSource(v: Values): SourceMode {
  const source = v.source === undefined ? undefined : oneOf('--source', v.source, ['auto', 'json', 'force'])
  if (v.force && source !== undefined && source !== 'force') fail(`--force conflicts with --source ${source}`)
  return v.force ? 'force' : (source ?? DEFAULTS.source)
}

function resolveHwaccel(v: Values): Hwaccel {
  const hw = v.hwaccel === undefined ? undefined : oneOf('--hwaccel', v.hwaccel, ['none', 'auto', 'cuda'])
  if (v.cpu && hw !== undefined && hw !== 'none') fail(`--cpu conflicts with --hwaccel ${hw}`)
  return v.cpu ? 'none' : (hw ?? DEFAULTS.hwaccel)
}

function jobDefaults(v: Values): JobDefaults {
  return {
    size: v.size === undefined ? null : parseSize(v.size),
    rate: v.rate === undefined ? null : intIn('--rate', v.rate, 1, 1_000_000),
    crop: v.crop === undefined ? null : parseCrop(v.crop),
    bright: v.bright === undefined ? null : numIn('--bright', v.bright, -1, 1),
    contrast: v.contrast === undefined ? null : numIn('--contrast', v.contrast, -4, 4),
    transpose: v.transpose === undefined ? null : parseTranspose(v.transpose),
    convert: v['convert-first'] === true
  }
}

function toolPath(flag: string, value: string | undefined, envValue: string | undefined, cwd: string): string | null {
  const text = value ?? (envValue && envValue.trim() !== '' ? envValue : undefined)
  if (text === undefined) return null
  if (text.trim() === '') fail(`${flag}: the path is empty`)
  return path.resolve(cwd, text)
}

/** Where vconv remembers converted videos when --state is not given. */
export function defaultStatePath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string): string {
  const home = env['HOME'] || homedir
  if (platform === 'win32') {
    const base = env['LOCALAPPDATA'] || path.win32.join(env['USERPROFILE'] || homedir, 'AppData', 'Local')
    return path.win32.join(base, 'vconv', 'state.jsonl')
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Application Support', 'vconv', 'state.jsonl')
  const base = env['XDG_STATE_HOME'] || path.posix.join(home, '.local', 'state')
  return path.posix.join(base, 'vconv', 'state.jsonl')
}

function resolveState(v: Values, env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform): string | null {
  if (v['no-state'] && v.state !== undefined) fail('--state and --no-state cannot be used together')
  if (v['no-state']) return null
  if (v.state !== undefined) return optionalPath(v.state, cwd)
  return defaultStatePath(env, platform, os.homedir())
}

function optionalPath(value: string | undefined, cwd: string): string | null {
  return value === undefined || value === '' ? null : path.resolve(cwd, value)
}

function buildRun(v: Values, positionals: string[], env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform): ParsedCli {
  if (positionals.length === 0) fail('no input given: pass a folder, a video file or a .json job file')
  const config: RunConfig = {
    inputs: positionals.map((p) => path.resolve(cwd, p)),
    recursive: v.recursive === true,
    source: resolveSource(v),
    extensions: extensions(v.ext),
    parallel: v.parallel === undefined ? DEFAULTS.parallel : intIn('--parallel', v.parallel, 1, DEFAULTS.maxParallel),
    ffmpegPath: toolPath('--ffmpeg', v.ffmpeg, env['VCONV_FFMPEG'], cwd),
    ffprobePath: toolPath('--ffprobe', v.ffprobe, env['VCONV_FFPROBE'], cwd),
    encoders: v.encoders === undefined ? [...DEFAULTS.encoders] : parseEncoders(v.encoders),
    hwaccel: resolveHwaccel(v),
    sameSize: v['same-size'] === true,
    maxSide: v['max-side'] === undefined ? DEFAULTS.maxSide : intIn('--max-side', v['max-side'], 2, 16384),
    maxRateKbps: v['max-rate'] === undefined ? DEFAULTS.maxRateKbps : intIn('--max-rate', v['max-rate'], 1, 1_000_000),
    minOutputBytes:
      v['min-output-bytes'] === undefined
        ? DEFAULTS.minOutputBytes
        : intIn('--min-output-bytes', v['min-output-bytes'], 0, Number.MAX_SAFE_INTEGER),
    verboseFfmpeg: v['verbose-ffmpeg'] === true,
    ignoreErrors: v['ignore-errors'] === true,
    keepParts: v['keep-parts'] === true,
    existing: (v.existing === undefined ? DEFAULTS.existing : oneOf('--existing', v.existing, ['skip', 'rename', 'replace'])) as ExistingPolicy,
    deleteOriginal: v['delete-original'] === true,
    deleteMode: (v['delete-mode'] === undefined ? DEFAULTS.deleteMode : oneOf('--delete-mode', v['delete-mode'], ['trash', 'permanent'])) as DeleteMode,
    moveOrphans: v['move-orphans'] === true,
    upload: v.upload === undefined ? null : template('--upload', v.upload),
    uploadAll: v['upload-all'] === undefined ? null : template('--upload-all', v['upload-all']),
    stallTimeoutMs:
      v['stall-timeout'] === undefined ? DEFAULTS.stallTimeoutMs : intIn('--stall-timeout', v['stall-timeout'], 0, 10_080) * 60_000,
    hookTimeoutMs:
      v['hook-timeout'] === undefined ? DEFAULTS.hookTimeoutMs : intIn('--hook-timeout', v['hook-timeout'], 0, 604_800) * 1000,
    failureLog: v['no-failure-log'] !== true,
    logFile: optionalPath(v['log-file'], cwd),
    stateFile: resolveState(v, env, cwd, platform),
    dryRun: v['dry-run'] === true,
    listOnly: v.list === true,
    jobDefaults: jobDefaults(v),
    output: v.json ? 'json' : v.plain ? 'plain' : 'tty',
    quiet: v.quiet === true
  }
  return { kind: 'run', config, verbose: v.verbose === true }
}

function dispatch(v: Values, positionals: string[], env: NodeJS.ProcessEnv, cwd: string, platform: NodeJS.Platform): ParsedCli {
  if (v.help) return { kind: 'help' }
  if (v.version) return { kind: 'version' }
  if (v.tools) {
    const tools = {
      ffmpegPath: toolPath('--ffmpeg', v.ffmpeg, env['VCONV_FFMPEG'], cwd),
      ffprobePath: toolPath('--ffprobe', v.ffprobe, env['VCONV_FFPROBE'], cwd)
    }
    return { kind: 'tools', tools, json: v.json === true }
  }
  return buildRun(v, positionals, env, cwd, platform)
}

/** `--bright -0.5` / `--size -1`: node's parser takes the negative number for a flag, so glue it as `--flag=-0.5`. */
function glueNegativeNumbers(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const next = argv[i + 1]
    const name = arg.startsWith('--') ? arg.slice(2) : ''
    const isString = Object.hasOwn(OPTIONS, name) && OPTIONS[name as keyof typeof OPTIONS].type === 'string'
    if (arg === '--') {
      out.push(...argv.slice(i))
      break
    }
    if (isString && next !== undefined && /^-\d/.test(next)) {
      out.push(`${arg}=${next}`)
      i++
    } else out.push(arg)
  }
  return out
}

/** Parses the command line. Never throws: problems come back as `{ kind: 'error' }`. */
export function parseCliArgs(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform = process.platform
): ParsedCli {
  try {
    const args = glueNegativeNumbers(argv)
    const { values, positionals } = parseArgs({ args, options: OPTIONS, allowPositionals: true, strict: true })
    return dispatch(values, positionals, env, cwd, platform)
  } catch (err) {
    if (err instanceof UsageError) return { kind: 'error', message: err.message }
    const message = err instanceof Error ? err.message : String(err)
    return { kind: 'error', message: message.replace(/\s*To specify a option argument starting with.*$/s, '') }
  }
}
