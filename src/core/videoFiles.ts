/**
 * Which file names count as videos (video-triage.md §1.3). Case-insensitive; the `.3gp` family
 * is matched by extension only (never by a substring of the whole path).
 */

export const DEFAULT_VIDEO_EXTENSIONS: readonly string[] = [
  '.mp4', '.m4v', '.mov', '.qt', '.avi', '.mkv', '.webm', '.mpg', '.mpeg', '.mpe', '.mpa',
  '.m1v', '.m2v', '.mpv', '.wmv', '.asf', '.flv', '.f4v', '.ogv', '.3gp', '.3gpp', '.3g2',
  '.ts', '.mts', '.m2ts', '.vob', '.divx', '.movie'
]

const DEFAULT_SET: ReadonlySet<string> = new Set(DEFAULT_VIDEO_EXTENSIONS)

/** Last path segment, either separator. */
function baseName(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1)
}

/** Extension with its dot, original case: `a.MP4` gives `.MP4`; `a` and `.bashrc` give `''`. */
function extOf(p: string): string {
  const name = baseName(p)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

/** Normalises `mp4`, `.MP4` to `.mp4`; `''` stays `''`. */
export function normaliseExtension(extension: string): string {
  const trimmed = extension.trim().toLowerCase()
  if (trimmed === '') return ''
  return trimmed.startsWith('.') ? trimmed : `.${trimmed}`
}

/** True when `fileName` (or a full path) has a video extension from `extensions`. */
export function isVideoFileName(
  fileName: string,
  extensions: readonly string[] = DEFAULT_VIDEO_EXTENSIONS
): boolean {
  const ext = extOf(fileName).toLowerCase()
  if (ext === '') return false
  if (extensions === DEFAULT_VIDEO_EXTENSIONS) return DEFAULT_SET.has(ext)
  return extensions.some((candidate) => normaliseExtension(candidate) === ext)
}

const DERIVED = /\.(copy|converted|part)\.mp4$/i
const NUMBERED_PART = /^(.+\.[A-Za-z0-9]+)\.\d+\.mp4$/
/** One ` (n)` collision suffix just before the final `.mp4` (see `collisionName`). */
const COLLISION_SUFFIX = /^(.+) \(\d+\)\.mp4$/i

/**
 * True when `stem` (a name minus `.copy|.converted|.part.mp4`) is a video name, a numbered part
 * of one (`v.mp4.0`), or itself such a derived name (`v.mp4.copy` of `v.mp4.copy.part.mp4`).
 * So `holiday.copy.mp4` (stem `holiday`) is a user's video, while `v.mp4.copy.mp4` is ours.
 */
function derivesFromSource(stem: string, extensions: readonly string[]): boolean {
  if (isVideoFileName(stem, extensions)) return true
  const numbered = /^(.+\.[A-Za-z0-9]+)\.\d+$/.exec(stem)
  if (numbered?.[1] !== undefined && isVideoFileName(numbered[1], extensions)) return true
  const inner = /^(.+)\.(copy|converted)$/i.exec(stem)
  return inner?.[1] !== undefined && derivesFromSource(inner[1], extensions)
}

/**
 * Output files of earlier runs (`v.mp4.0.mp4`, `v.mp4.mp4`, `v.mp4.copy.mp4`, `*.part.mp4`)
 * are not sources. `siblings` holds the other names of the same folder.
 */
export function isDerivedOutput(
  rawName: string,
  siblings: ReadonlySet<string>,
  extensions: readonly string[] = DEFAULT_VIDEO_EXTENSIONS
): boolean {
  // An output that got a collision name (`v.mp4.0 (1).mp4`) is judged as the name it was derived from.
  const name = rawName.replace(COLLISION_SUFFIX, '$1.mp4')
  if (DERIVED.test(name) && derivesFromSource(name.replace(DERIVED, ''), extensions)) return true
  const part = NUMBERED_PART.exec(name)
  if (part?.[1] !== undefined && isVideoFileName(part[1], extensions)) return true
  if (/\.mp4$/i.test(name)) {
    const stem = name.slice(0, -'.mp4'.length)
    return isVideoFileName(stem, extensions) && siblings.has(stem)
  }
  return false
}

/**
 * Parses a user list such as `mp4, .MKV,webm` (comma separated) into dotted lowercase
 * extensions without duplicates. Throws on an empty list or on entries with path separators.
 */
export function parseExtensionList(text: string): string[] {
  const entries = text.split(',').map((e) => e.trim()).filter((e) => e !== '')
  const result: string[] = []
  for (const entry of entries) {
    if (/[\\/\s\0]/.test(entry)) throw new Error(`Invalid extension "${entry}"`)
    const ext = normaliseExtension(entry)
    if (ext === '.') throw new Error(`Invalid extension "${entry}"`)
    if (!result.includes(ext)) result.push(ext)
  }
  if (result.length === 0) throw new Error('The extension list is empty')
  return result
}
