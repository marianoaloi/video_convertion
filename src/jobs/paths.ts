/** Small path helpers shared by the jobs modules. */
import { stat } from 'node:fs/promises'
import path from 'node:path'

const IS_WIN = process.platform === 'win32'

/** Case-folds on win32 only; paths on linux are case-sensitive. */
export function fold(text: string): string {
  return IS_WIN ? text.toLowerCase() : text
}

/** Comparison key of a path: resolved, and case-insensitive on win32. */
export function pathKey(target: string): string {
  return fold(path.resolve(target))
}

export function errorCodeOf(error: unknown): string | undefined {
  const code: unknown = error instanceof Error ? Reflect.get(error, 'code') : undefined
  return typeof code === 'string' ? code : undefined
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isNotFound(error: unknown): boolean {
  const code = errorCodeOf(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The root for a video: `<root>/CUSTOM/x.mp4` belongs to `<root>`; anything else to its folder. */
export function rootOfVideo(videoPath: string, customName: string): string {
  const dir = path.dirname(videoPath)
  return fold(path.basename(dir)) === fold(customName) ? path.dirname(dir) : dir
}

/** True for a regular file (following symlinks); false when missing. Other errors propagate. */
export async function isFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile()
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

export async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}
