/**
 * Tools status: where ffmpeg/ffprobe are, their versions, the H.264 encoders and the hwaccels
 * `ffmpeg` reports.
 */
import type { ToolsConfig, ToolsStatus } from '../types.js'
import { locateTools, resolveShims } from './locate.js'
import { runProcess } from './process.js'

const QUERY_TIMEOUT_MS = 15_000

async function toolText(command: string, args: string[]): Promise<string> {
  const result = await runProcess({ command, args, timeoutMs: QUERY_TIMEOUT_MS })
  if (result.status !== 'exited' || result.exitCode !== 0) return ''
  return `${result.stdout}\n${result.stderr}`
}

export function parseVersion(text: string): string | null {
  const match = /^(?:ff(?:mpeg|probe)) version (\S+)/im.exec(text)
  return match?.[1] ?? null
}

/** Lines of `ffmpeg -encoders`: ` V....D libx264  ...`; keeps the H.264 video encoders. */
export function parseH264Encoders(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*V\S{5}\s+(\S+)/.exec(line)
    const name = match?.[1]
    if (name !== undefined && /264/.test(name) && !names.includes(name)) names.push(name)
  }
  return names
}

export function parseHwaccels(text: string): string[] {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => /^hardware acceleration methods:/i.test(line.trim()))
  if (start < 0) return []
  return lines
    .slice(start + 1)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9_]+$/i.test(line))
}

async function queryTools(ffmpegPath: string, ffprobePath: string | null): Promise<ToolsStatus> {
  const [version, encoders, hwaccels, probeVersion] = await Promise.all([
    toolText(ffmpegPath, ['-version']),
    toolText(ffmpegPath, ['-hide_banner', '-encoders']),
    toolText(ffmpegPath, ['-hide_banner', '-hwaccels']),
    ffprobePath === null ? Promise.resolve('') : toolText(ffprobePath, ['-version'])
  ])
  return {
    ffmpeg: { path: ffmpegPath, version: parseVersion(version) },
    ffprobe: ffprobePath === null ? null : { path: ffprobePath, version: parseVersion(probeVersion) },
    h264Encoders: parseH264Encoders(encoders),
    hwaccels: parseHwaccels(hwaccels),
    error: null
  }
}

/** Locates and queries both tools. `error` is a message string (null when ffmpeg was found). */
export async function readToolsStatus(config: ToolsConfig): Promise<ToolsStatus> {
  const tools = await resolveShims(locateTools(config, { noCache: true }))
  if (tools.ffmpeg === null) {
    const detail = tools.warnings.length > 0 ? ` ${tools.warnings.join(' ')}` : ''
    return {
      ffmpeg: null,
      ffprobe: null,
      h264Encoders: [],
      hwaccels: [],
      error: `ffmpeg was not found. Pass --ffmpeg <file|folder>, set VCONV_FFMPEG, or add it to PATH.${detail}`
    }
  }
  try {
    return await queryTools(tools.ffmpeg, tools.ffprobe)
  } catch (error) {
    return {
      ffmpeg: { path: tools.ffmpeg, version: null },
      ffprobe: tools.ffprobe === null ? null : { path: tools.ffprobe, version: null },
      h264Encoders: [],
      hwaccels: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
