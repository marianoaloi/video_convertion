/**
 * ffprobe -> `MediaInfo`. `probeMedia` runs ffprobe through `runProcess()` (argv only);
 * `toMediaInfo` is the pure part.
 *
 * Parity notes: the video stream is the first non-cover-art video stream; `bitrateKbps` =
 * trunc(format.bit_rate / 1000), else the video stream's; `fps` = avg_frame_rate; `rotation` =
 * display-matrix rotation (degrees, counter-clockwise), else the old `tags.rotate` (clockwise)
 * negated, normalised to (-180, 180]. The JSON shape is checked by hand (no schema library).
 */
import type { MediaInfo } from '../types.js'
import { runProcess } from './process.js'

type Json = Record<string, unknown>
type NumberLike = string | number | undefined

export interface ProbeOptions {
  /** Absolute path of ffprobe (from `locate.ts`). */
  readonly ffprobePath: string
  readonly signal?: AbortSignal
  /** Default 30 s. */
  readonly timeoutMs?: number
  /** Spawn policy (see `detectConsoleIsolation`); default per platform. */
  readonly detached?: boolean
}

/** A huge ffprobe JSON must not be truncated. */
const MAX_PROBE_BYTES = 64 * 1024 * 1024

export const FFPROBE_ARGS = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams']

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberLike(value: unknown): NumberLike {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function num(value: NumberLike): number | null {
  if (value === undefined || value === '' || value === 'N/A') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** Degrees counter-clockwise in (-180, 180]. */
export function normaliseRotation(degrees: number): number {
  const mod = ((degrees % 360) + 360) % 360
  const r = mod > 180 ? mod - 360 : mod
  return r === 0 ? 0 : r
}

/** "30000/1001" -> 29.97; "0/0" and malformed values -> null. */
export function parseFrameRate(value: string | undefined): number | null {
  if (value === undefined) return null
  const m = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(value.trim())
  if (m === null) {
    const plain = num(value)
    return plain !== null && plain > 0 ? plain : null
  }
  const numerator = Number(m[1])
  const denominator = Number(m[2])
  if (denominator === 0 || numerator === 0) return null
  return numerator / denominator
}

interface Stream {
  readonly codecType?: string
  readonly codecName?: string
  readonly width?: number
  readonly height?: number
  readonly pixFmt?: string
  readonly channels?: number
  readonly avgFrameRate?: string
  readonly bitRate: NumberLike
  readonly duration: NumberLike
  readonly attachedPic: boolean
  readonly rotateTag: NumberLike
  readonly sideRotation?: number
}

function sideRotation(raw: unknown): number | undefined {
  if (!Array.isArray(raw)) return undefined
  for (const side of raw) {
    const rotation = isObject(side) ? numeric(side['rotation']) : undefined
    if (rotation !== undefined) return rotation
  }
  return undefined
}

function toStream(raw: unknown): Stream {
  const s = isObject(raw) ? raw : {}
  const disposition = isObject(s['disposition']) ? s['disposition'] : {}
  const tags = isObject(s['tags']) ? s['tags'] : {}
  const rotation = sideRotation(s['side_data_list'])
  return {
    ...optional('codecType', str(s['codec_type'])),
    ...optional('codecName', str(s['codec_name'])),
    ...optional('width', numeric(s['width'])),
    ...optional('height', numeric(s['height'])),
    ...optional('pixFmt', str(s['pix_fmt'])),
    ...optional('channels', numeric(s['channels'])),
    ...optional('avgFrameRate', str(s['avg_frame_rate'])),
    ...optional('sideRotation', rotation),
    bitRate: numberLike(s['bit_rate']),
    duration: numberLike(s['duration']),
    attachedPic: disposition['attached_pic'] === 1,
    rotateTag: numberLike(tags['rotate'])
  }
}

/** `{ key: value }` or `{}` (keeps `exactOptionalPropertyTypes`-style objects clean). */
function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V })
}

function streamRotation(stream: Stream): number {
  if (stream.sideRotation !== undefined) return normaliseRotation(stream.sideRotation)
  const tag = num(stream.rotateTag)
  return tag === null ? 0 : normaliseRotation(-tag)
}

interface Format {
  readonly name?: string
  readonly longName?: string
  readonly duration: NumberLike
  readonly size: NumberLike
  readonly bitRate: NumberLike
}

function toFormat(raw: unknown): Format | undefined {
  if (!isObject(raw)) return undefined
  return {
    ...optional('name', str(raw['format_name'])),
    ...optional('longName', str(raw['format_long_name'])),
    duration: numberLike(raw['duration']),
    size: numberLike(raw['size']),
    bitRate: numberLike(raw['bit_rate'])
  }
}

/** Pure conversion of parsed ffprobe JSON. Throws when there are no streams or the shape is wrong. */
export function toMediaInfo(filePath: string, probe: unknown): MediaInfo {
  if (!isObject(probe)) throw new Error('ffprobe output has an unexpected shape')
  const rawStreams = probe['streams'] ?? []
  if (!Array.isArray(rawStreams)) throw new Error('ffprobe output has an unexpected shape')
  if (rawStreams.length === 0) throw new Error('ffprobe found no streams in this file')
  const streams = rawStreams.map(toStream)
  const format = toFormat(probe['format'])
  const video = streams.find((s) => s.codecType === 'video' && !s.attachedPic)
  const audio = streams.find((s) => s.codecType === 'audio' || s.channels !== undefined)

  const durationSec = num(format?.duration) ?? (video === undefined ? null : num(video.duration))
  const bitRate = num(format?.bitRate) ?? (video === undefined ? null : num(video.bitRate))
  const rotation = video === undefined ? 0 : streamRotation(video)
  const width = video?.width ?? 0
  const height = video?.height ?? 0
  const swapped = Math.round(Math.abs(rotation)) % 180 === 90

  return {
    path: filePath,
    container: format?.name ?? '',
    formatLongName: format?.longName ?? null,
    durationMs: durationSec === null ? 0 : Math.max(0, Math.trunc(durationSec * 1000)),
    sizeBytes: Math.max(0, Math.trunc(num(format?.size) ?? 0)),
    bitrateKbps: bitRate === null ? null : Math.max(0, Math.trunc(bitRate / 1000)),
    hasVideo: video !== undefined,
    width,
    height,
    displayWidth: swapped ? height : width,
    displayHeight: swapped ? width : height,
    rotation,
    fps: video === undefined ? null : parseFrameRate(video.avgFrameRate),
    videoCodec: video?.codecName ?? null,
    pixFmt: video?.pixFmt ?? null,
    hasAudio: audio !== undefined,
    audioCodec: audio?.codecName ?? null,
    audioChannels: audio?.channels ?? null,
    streamCount: streams.length
  }
}

function tail(text: string, max = 600): string {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(trimmed.length - max) : trimmed
}

/** Probes one file. Throws `Error` (cancelled, timeout, cannot start, ffprobe failure, bad JSON). */
export async function probeMedia(filePath: string, options: ProbeOptions): Promise<MediaInfo> {
  const result = await runProcess({
    command: options.ffprobePath,
    args: [...FFPROBE_ARGS, '-i', filePath],
    timeoutMs: options.timeoutMs ?? 30_000,
    maxCaptureBytes: MAX_PROBE_BYTES,
    ...(options.detached === undefined ? {} : { detached: options.detached }),
    ...(options.signal === undefined ? {} : { signal: options.signal })
  })
  switch (result.status) {
    case 'cancelled':
      throw new Error(`Probe cancelled: ${filePath}`)
    case 'timeout':
      throw new Error(`ffprobe timed out: ${filePath}`)
    case 'spawn-error':
      throw new Error(`ffprobe could not be started (${options.ffprobePath}): ${result.error?.message ?? ''}`)
    case 'exited':
      break
  }
  if (result.exitCode !== 0) {
    throw new Error(tail(result.stderr) || `ffprobe exited with code ${result.exitCode ?? 'none'}`)
  }
  let json: unknown
  try {
    json = JSON.parse(result.stdout)
  } catch {
    throw new Error('ffprobe returned invalid JSON')
  }
  return toMediaInfo(filePath, json)
}
