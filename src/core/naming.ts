/**
 * Output/collision naming (from the app's `shared/core/naming.ts`, only what the CLI needs).
 */

/**
 * Splits a file name at its LAST dot. A leading dot is not an extension separator:
 * `.bashrc` has no extension, `a.tar.gz` gives `a.tar` + `.gz`, `noext` gives `noext` + ``.
 */
export function splitExt(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

/** `clip.mp4` + 2 gives `clip (2).mp4`; `n = 0` returns the name unchanged. */
export function collisionName(name: string, n: number): string {
  if (n <= 0) return name
  const { stem, ext } = splitExt(name)
  return `${stem} (${n})${ext}`
}
