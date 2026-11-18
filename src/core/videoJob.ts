/**
 * Reads every job-JSON format (v2 and both legacy ones) and writes v2 (SPEC §4, acceptance 1).
 * Pure: the caller does the I/O. Validation is hand-written (the app used zod) but accepts and
 * rejects the same values.
 *
 * Legacy behaviour kept on purpose (mediamaloipackage/UtilFileTimes.py, FFMPEGVideoDTO.py):
 * - old format: `definedSize` → size, `definedRate` → rate (the legacy reader crashed on this,
 *   LEG §9), `times: [{st, du}]` → `[st, du]` where `du` is the END, `posExecution "f"` → concat;
 * - ranges are `[min, max]` (TimeDTO) except `[-1, durationMs]` = the whole video;
 * - the job's `filename` is the video's real location (openTimes does the same).
 * Not kept: `originalPath` is preserved instead of being reset (undo now uses the journal).
 */
import { ProcessingMode, WHOLE_VIDEO_START_MS } from '../types.js'
import type { ParseVideoJobResult, Range, Rect, VideoJob, VideoJobDraft, VideoJobFormat } from '../types.js'

export type { ParseVideoJobResult } from '../types.js'

export interface VideoJobContext {
  /** Absolute path of the video the JSON belongs to (`<video>.json` minus `.json`). */
  readonly videoPath: string
}

export type ValidateResult =
  | { readonly ok: true; readonly job: VideoJob }
  | { readonly ok: false; readonly errors: string[] }

type Loose = Record<string, unknown>

function isRecord(value: unknown): value is Loose {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

// ---- validators (the app's zod schemas) -------------------------------------------------------

/** True for `C:\x`, `C:/x`, UNC `\\server\share\x` (also `\\?\C:\x`) and POSIX `/x`, on any platform. */
export function isAbsolutePathLike(p: string): boolean {
  if (p.length === 0 || p.includes('\0')) return false
  if (/^[A-Za-z]:[\\/]/.test(p)) return true
  if (/^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(p)) return true
  return p.startsWith('/')
}

const SIZE_PATTERN = /^(-1|-?\d+[x:]-?\d+)$/

/** `"WxH"`, `"W:H"` (ffmpeg scale, -1/-2 allowed) or `"-1"` (keep the source size). */
export function isValidVideoSize(value: unknown): value is string {
  return typeof value === 'string' && SIZE_PATTERN.test(value)
}

/** `[startMs, endMs]`: integers, start >= -1, end >= 0, and start < end unless start is -1. */
export function isValidRange(value: unknown): value is Range {
  if (!Array.isArray(value) || value.length !== 2) return false
  const [start, end] = value as unknown[]
  if (!Number.isInteger(start) || !Number.isInteger(end)) return false
  const [a, b] = [start as number, end as number]
  return a >= WHOLE_VIDEO_START_MS && b >= 0 && (a === WHOLE_VIDEO_START_MS || a < b)
}

function isValidRect(value: unknown): value is Rect {
  if (!isRecord(value)) return false
  const { x, y, w, h } = value
  return (
    Number.isInteger(x) && (x as number) >= 0 &&
    Number.isInteger(y) && (y as number) >= 0 &&
    Number.isInteger(w) && (w as number) > 0 &&
    Number.isInteger(h) && (h as number) > 0
  )
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNullOr = (check: (v: unknown) => boolean) => (v: unknown) => v === null || check(v)

interface FieldRule {
  readonly key: keyof VideoJob
  readonly check: (v: unknown) => boolean
  readonly message: string
}

const FIELD_RULES: readonly FieldRule[] = [
  { key: 'filename', check: (v) => typeof v === 'string' && v.length <= 32767 && isAbsolutePathLike(v), message: 'Expected an absolute path' },
  { key: 'originalPath', check: (v) => typeof v === 'string' && v.length > 0, message: 'Expected a non-empty string' },
  { key: 'crop', check: isNullOr(isValidRect), message: 'Expected null or {x, y >= 0, w, h > 0} integers' },
  { key: 'bright', check: isNullOr(isFiniteNumber), message: 'Expected a number or null' },
  { key: 'contrast', check: isNullOr(isFiniteNumber), message: 'Expected a number or null' },
  { key: 'transpose', check: isNullOr(Number.isInteger), message: 'Expected an integer or null' },
  { key: 'mediaPath', check: isNullOr((v) => typeof v === 'string'), message: 'Expected a string or null' },
  { key: 'convert', check: (v) => typeof v === 'boolean', message: 'Expected a boolean' },
  { key: 'size', check: isNullOr(isValidVideoSize), message: 'Expected "WxH", "W:H" or "-1"' },
  { key: 'rate', check: isNullOr((v) => Number.isInteger(v) && (v as number) > 0), message: 'Expected a positive integer or null' },
  { key: 'avgrate', check: isNullOr((v) => isFiniteNumber(v) && v > 0), message: 'Expected a positive number or null' },
  { key: 'times', check: (v) => Array.isArray(v) && v.every(isValidRange), message: 'Expected a list of ranges [start, end] with start < end (or start = -1)' },
  { key: 'posExecution', check: (v) => v === 1 || v === 2, message: 'Expected 1 (cut) or 2 (concat)' },
  { key: 'version', check: (v) => v === 2, message: 'Expected version 2' }
]

/** Strict v2 validation. Returns a fresh job object with exactly the known keys. */
export function validateVideoJob(value: unknown): ValidateResult {
  if (!isRecord(value)) return { ok: false, errors: ['Expected an object'] }
  const errors = FIELD_RULES.filter((rule) => !rule.check(value[rule.key])).map(
    (rule) => `${rule.key}: ${rule.message}`
  )
  if (errors.length > 0) return { ok: false, errors }
  const times = (value['times'] as Range[]).map(([a, b]): Range => [a, b])
  const crop = value['crop'] as Rect | null
  const job = {
    ...(value as unknown as VideoJob),
    crop: crop === null ? null : { x: crop.x, y: crop.y, w: crop.w, h: crop.h },
    times
  }
  return { ok: true, job: pickKnown(job) }
}

function pickKnown(job: VideoJob): VideoJob {
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) ordered[key] = job[key]
  return ordered as unknown as VideoJob
}

// ---- legacy normaliser ------------------------------------------------------------------------

class Normaliser {
  readonly warnings: string[] = []

  warn(message: string): void {
    this.warnings.push(message)
  }

  number(field: string, value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const n = toNumber(value)
    if (n === null) this.warn(`${field}: "${String(value)}" is not a number; ignored`)
    return n
  }

  positive(field: string, value: unknown, integer: boolean): number | null {
    const n = this.number(field, value)
    if (n === null) return null
    const v = integer ? Math.trunc(n) : n
    if (v > 0) return v
    this.warn(`${field}: ${n} is not positive; ignored`)
    return null
  }

  size(field: string, value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null
    const text = typeof value === 'number' ? String(Math.trunc(value)) : value
    // The legacy UI also wrote "640X360" (adaptSize.py); the validator only knows the lowercase form.
    const trimmed = typeof text === 'string' ? text.trim().replace(/^(-?\d+)X(-?\d+)$/, '$1x$2') : ''
    if (isValidVideoSize(trimmed)) return trimmed
    this.warn(`${field}: "${String(value)}" is not "WxH", "W:H" or "-1"; ignored`)
    return null
  }

  crop(value: unknown): Rect | null {
    if (value === null || value === undefined) return null
    if (!isRecord(value)) {
      this.warn('crop: not an object; ignored')
      return null
    }
    const x = toNumber(value['x'])
    const y = toNumber(value['y'])
    const w = toNumber(value['w'])
    const h = toNumber(value['h'])
    if (x === null || y === null || w === null || h === null || x < 0 || y < 0 || w < 1 || h < 1) {
      this.warn('crop: needs numeric x, y ≥ 0 and w, h ≥ 1; ignored')
      return null
    }
    return { x: Math.trunc(x), y: Math.trunc(y), w: Math.trunc(w), h: Math.trunc(h) }
  }

  convert(value: unknown): boolean {
    if (value === null || value === undefined) return false
    if (typeof value === 'boolean') return value
    if (typeof value === 'number') return value !== 0
    if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase())
    this.warn('convert: not a boolean; using false')
    return false
  }

  range(start: unknown, end: unknown, index: number): Range | null {
    const a = toNumber(start)
    const b = toNumber(end)
    if (a === null || b === null) {
      this.warn(`times[${index}]: not two numbers; dropped`)
      return null
    }
    const candidate: Range =
      Math.trunc(a) === WHOLE_VIDEO_START_MS
        ? [WHOLE_VIDEO_START_MS, Math.trunc(b)]
        : [Math.trunc(Math.min(a, b)), Math.trunc(Math.max(a, b))]
    if (!isValidRange(candidate)) {
      this.warn(`times[${index}]: [${a}, ${b}] is empty or negative; dropped`)
      return null
    }
    return candidate
  }

  times(value: unknown, oldFormat: boolean): Range[] {
    if (value === null || value === undefined) return []
    if (!Array.isArray(value)) {
      this.warn('times: not a list; ignored')
      return []
    }
    const ranges: Range[] = []
    value.forEach((item: unknown, index) => {
      let range: Range | null = null
      if (oldFormat && isRecord(item)) range = this.range(item['st'], item['du'], index)
      else if (Array.isArray(item) && item.length >= 2) range = this.range(item[0], item[1], index)
      else this.warn(`times[${index}]: unexpected shape; dropped`)
      if (range) ranges.push(range)
    })
    return ranges
  }

  /** Legacy: `"f"` = concat, `"d"`/`"e"` = cut (DialogResume), ints 1/2 in the current format. */
  mode(value: unknown): 1 | 2 {
    if (value === null || value === undefined) return ProcessingMode.cut
    const text = typeof value === 'string' ? value.trim().toLowerCase() : value
    if (text === 'f' || text === '2' || text === 2) return ProcessingMode.concat
    if (text === 'd' || text === 'e' || text === '1' || text === 1 || text === '') return ProcessingMode.cut
    this.warn(`posExecution: "${String(value)}" is unknown; using cut`)
    return ProcessingMode.cut
  }
}

export function detectVideoJobFormat(raw: Loose): VideoJobFormat {
  if (raw['version'] !== undefined) return 'v2'
  if ('definedSize' in raw || 'definedRate' in raw) return 'legacy-old'
  const times = raw['times']
  if (Array.isArray(times) && times.some((t: unknown) => isRecord(t) && 'st' in t)) return 'legacy-old'
  return 'legacy'
}

function normalise(raw: Loose, format: VideoJobFormat, ctx: VideoJobContext, n: Normaliser): Loose {
  const old = format === 'legacy-old'
  const original = raw['originalPath']
  const transpose = n.number('transpose', raw['transpose'])
  return {
    filename: ctx.videoPath,
    originalPath: typeof original === 'string' && original.length > 0 ? original : ctx.videoPath,
    crop: n.crop(raw['crop']),
    bright: n.number('bright', raw['bright']),
    contrast: n.number('contrast', raw['contrast']),
    transpose: transpose === null ? null : Math.trunc(transpose),
    mediaPath: typeof raw['mediaPath'] === 'string' ? raw['mediaPath'] : null,
    convert: n.convert(raw['convert']),
    size: n.size('size', old ? (raw['definedSize'] ?? raw['size']) : raw['size']),
    rate: n.positive('rate', old ? (raw['definedRate'] ?? raw['rate']) : raw['rate'], true),
    avgrate: n.positive('avgrate', raw['avgrate'], false),
    times: n.times(raw['times'], old),
    posExecution: n.mode(raw['posExecution']),
    version: 2
  }
}

/** Parses an already-decoded JSON value in any supported format. */
export function parseAnyVideoJob(raw: unknown, ctx: VideoJobContext): ParseVideoJobResult {
  const n = new Normaliser()
  if (!isRecord(raw)) return { ok: false, error: 'The job file is not a JSON object', warnings: [] }
  const format = detectVideoJobFormat(raw)
  if (format === 'v2') {
    const version = raw['version']
    if (version !== 1 && version !== 2) {
      return { ok: false, error: `Unsupported job version ${String(version)}`, warnings: [] }
    }
    const strict = validateVideoJob({ ...raw, filename: ctx.videoPath, version: 2 })
    if (strict.ok) return { ok: true, job: strict.job, format, warnings: [] }
    n.warn(`v2 job failed validation, read leniently: ${strict.errors.join('; ')}`)
  }
  const parsed = validateVideoJob(normalise(raw, format, ctx, n))
  if (!parsed.ok) return { ok: false, error: parsed.errors.join('; '), warnings: n.warnings }
  return { ok: true, job: parsed.job, format, warnings: n.warnings }
}

/** Parses the text of a `<video>.json` file. Empty files are an error (ADR-005: report them). */
export function parseVideoJobText(text: string, ctx: VideoJobContext): ParseVideoJobResult {
  if (text.trim() === '') return { ok: false, error: 'The job file is empty', warnings: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `The job file is not valid JSON: ${reason}`, warnings: [] }
  }
  return parseAnyVideoJob(raw, ctx)
}

/** Builds the job the CLI writes. Throws an Error listing every problem for an invalid draft. */
export function createVideoJob(videoPath: string, draft: VideoJobDraft): VideoJob {
  if (draft.originalPath !== undefined && draft.originalPath.length === 0) {
    throw new Error('originalPath: Expected a non-empty string')
  }
  const result = validateVideoJob({
    filename: videoPath,
    originalPath: draft.originalPath ?? videoPath,
    crop: draft.crop ?? null,
    bright: draft.bright ?? null,
    contrast: draft.contrast ?? null,
    transpose: draft.transpose ?? null,
    mediaPath: draft.mediaPath ?? null,
    convert: draft.convert ?? false,
    size: draft.size ?? null,
    rate: draft.rate ?? null,
    avgrate: draft.avgrate ?? null,
    times: draft.times ?? [],
    posExecution: draft.posExecution ?? ProcessingMode.cut,
    version: 2
  })
  if (!result.ok) throw new Error(result.errors.join('; '))
  return result.job
}

const KEY_ORDER: readonly (keyof VideoJob)[] = [
  'filename',
  'originalPath',
  'crop',
  'bright',
  'contrast',
  'transpose',
  'mediaPath',
  'convert',
  'size',
  'rate',
  'avgrate',
  'times',
  'posExecution',
  'version'
]

/** JSON text in the legacy key order (2-space indent, trailing newline). Throws for an invalid job. */
export function serializeVideoJob(job: VideoJob): string {
  const result = validateVideoJob(job)
  if (!result.ok) throw new Error(result.errors.join('; '))
  return `${JSON.stringify(result.job, null, 2)}\n`
}

/** `<video>.json` (the legacy sidecar name keeps the video extension). */
export function jobJsonPathFor(videoPath: string): string {
  return `${videoPath}.json`
}
