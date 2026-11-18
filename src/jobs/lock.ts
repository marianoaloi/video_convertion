/**
 * Per-video lock (`<video>.vconv.lock`, created exclusively) so two vconv instances never convert
 * the same video. A lock is live when it belongs to a running process on this host, or to another
 * host and is younger than 24 h; anything else is stale and is taken over.
 */
import { open, readFile, rm, stat } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import os from 'node:os'
import { errorCodeOf } from './paths.js'

export const LOCK_SUFFIX = '.vconv.lock'
const FOREIGN_HOST_TTL_MS = 24 * 60 * 60 * 1000
/** An unreadable lock file this young may still be being written by its owner. */
const UNREADABLE_GRACE_MS = 60_000

interface LockInfo {
  pid: number
  host: string
  startedAt: number
}

export type LockResult =
  | { readonly ok: true; release(): Promise<void> }
  | { readonly ok: false; readonly reason: string }

const held = new Set<string>()

export function lockPathFor(videoPath: string): string {
  return `${videoPath}${LOCK_SUFFIX}`
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCodeOf(error) === 'EPERM'
  }
}

function parseLock(text: string): LockInfo | null {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return null
    const { pid, host, startedAt } = raw as Record<string, unknown>
    if (typeof pid !== 'number' || typeof host !== 'string' || typeof startedAt !== 'number') return null
    return { pid, host, startedAt }
  } catch {
    return null
  }
}

/** Returns why the lock is live, or null when it can be taken over. */
async function liveReason(file: string, now: number): Promise<string | null> {
  let info: LockInfo | null
  try {
    info = parseLock(await readFile(file, 'utf8'))
  } catch (error) {
    return errorCodeOf(error) === 'ENOENT' ? null : 'its lock file cannot be read'
  }
  if (info === null) {
    const age = now - (await stat(file).then((s) => s.mtimeMs, () => 0))
    return age < UNREADABLE_GRACE_MS ? 'its lock file is being written' : null
  }
  const mine = info.host === os.hostname()
  if (mine && (info.pid === process.pid || pidAlive(info.pid))) return `pid ${info.pid} on ${info.host}`
  if (!mine && now - info.startedAt < FOREIGN_HOST_TTL_MS) return `pid ${info.pid} on ${info.host}`
  return null
}

async function createExclusive(file: string, now: number): Promise<boolean> {
  const handle = await open(file, 'wx').catch((error: unknown) => {
    if (errorCodeOf(error) === 'EEXIST') return null
    throw error
  })
  if (handle === null) return false
  try {
    const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: now }
    await handle.writeFile(JSON.stringify(info))
  } finally {
    await handle.close()
  }
  return true
}

/**
 * Takes the lock of a video. A folder where the lock file cannot be created (read-only, ...)
 * yields a no-op lock: the conversion would fail on its own outputs anyway.
 */
export async function acquireLock(videoPath: string, now = Date.now()): Promise<LockResult> {
  const file = lockPathFor(videoPath)
  const release = async (): Promise<void> => {
    held.delete(file)
    await rm(file, { force: true }).catch(() => undefined)
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await createExclusive(file, now)) {
        held.add(file)
        return { ok: true, release }
      }
      const why = await liveReason(file, now)
      if (why !== null) return { ok: false, reason: `being converted by another vconv (${why})` }
      await rm(file, { force: true })
    }
    return { ok: false, reason: 'being converted by another vconv (lock contention)' }
  } catch {
    return { ok: true, release: async () => undefined }
  }
}

/** For the exit handler: removes every lock this process still holds. */
export function releaseAllLocksSync(): void {
  for (const file of held) {
    try {
      unlinkSync(file)
    } catch {
      // already gone
    }
  }
  held.clear()
}
