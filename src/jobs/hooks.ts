/** Runs an upload hook command (`shell: false`, argv only) and hashes files for `{md5}`. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { expandTemplate } from '../core/template.js'
import { runProcess } from '../ffmpeg/process.js'
import type { CommandTemplate, HookContext, HookOutcome, LogLevel } from '../types.js'
import { messageOf } from './paths.js'

export interface HookOptions {
  signal?: AbortSignal
  /** Kill the hook after this long; counts as `failed`. 0 or undefined = no limit. */
  timeoutMs?: number
}

export type HookLog = (line: string, level?: LogLevel) => void

export type HookRunner = (
  template: CommandTemplate,
  context: HookContext,
  log: HookLog,
  options?: HookOptions
) => Promise<HookOutcome>

/** Expands the template and runs it. Never throws: any problem is `failed` plus a log line. */
export const runHook: HookRunner = async (template, context, log, options = {}) => {
  let command: string
  let args: string[]
  try {
    ;({ command, args } = expandTemplate(template, context))
  } catch (error) {
    log(`Hook could not be prepared: ${messageOf(error)}`, 'warn')
    return 'failed'
  }
  // Arguments may carry secrets (tokens, passwords): the full argv stays at the verbose level.
  log(`Running upload hook: ${path.basename(command)} (${args.length} arguments)`)
  log(`$ ${[command, ...args].map(quoteForLog).join(' ')}`, 'stderr')
  const timeoutMs = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : undefined
  const result = await runProcess({
    command,
    args,
    captureStdout: false,
    captureStderr: false,
    onStdoutLine: (line) => {
      log(line)
    },
    onStderrLine: (line) => {
      log(line)
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  })
  if (result.status === 'exited' && result.exitCode === 0) {
    log('Hook finished')
    return 'ok'
  }
  log(`Hook failed: ${failureReason(result, timeoutMs)}`, 'warn')
  return 'failed'
}

function failureReason(result: Awaited<ReturnType<typeof runProcess>>, timeoutMs: number | undefined): string {
  if (result.status === 'exited') return `exit code ${result.exitCode ?? 'none'}`
  if (result.status === 'timeout') return `timed out after ${Math.round((timeoutMs ?? 0) / 1000)} s`
  return result.error?.message ?? result.status
}

function quoteForLog(arg: string): string {
  return /[\s"]/.test(arg) ? JSON.stringify(arg) : arg
}

/** Streaming MD5 of a file (hex). */
export function md5OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('md5')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
