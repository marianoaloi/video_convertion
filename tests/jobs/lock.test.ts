import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { acquireLock, lockPathFor, releaseAllLocksSync } from '../../src/jobs/lock.js'
import { makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)

describe('per-video lock', () => {
  it('is exclusive, holds pid/host/startedAt, and is released', async () => {
    const video = await write(path.join(tmp.dir, 'a.mp4'))
    const first = await acquireLock(video)
    assert.ok(first.ok)
    const info = JSON.parse(await readFile(lockPathFor(video), 'utf8')) as Record<string, unknown>
    assert.equal(info['pid'], process.pid)
    assert.equal(info['host'], os.hostname())
    const second = await acquireLock(video)
    assert.equal(second.ok, false)
    assert.match(second.ok ? '' : second.reason, /being converted by another vconv \(pid \d+ on /)
    if (first.ok) await first.release()
    assert.ok(!(await exists(lockPathFor(video))))
    const third = await acquireLock(video)
    assert.ok(third.ok)
    if (third.ok) await third.release()
  })

  it('takes over a stale lock (dead pid here, old lock from another host)', async () => {
    const video = await write(path.join(tmp.dir, 'a.mp4'))
    await writeFile(lockPathFor(video), JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: Date.now() }))
    const taken = await acquireLock(video)
    assert.ok(taken.ok)
    if (taken.ok) await taken.release()
    await writeFile(lockPathFor(video), JSON.stringify({ pid: 1, host: 'elsewhere', startedAt: Date.now() - 25 * 3600_000 }))
    const old = await acquireLock(video)
    assert.ok(old.ok)
    if (old.ok) await old.release()
  })

  it('respects a young lock from another host', async () => {
    const video = await write(path.join(tmp.dir, 'a.mp4'))
    await writeFile(lockPathFor(video), JSON.stringify({ pid: 99, host: 'other-box', startedAt: Date.now() - 3600_000 }))
    const result = await acquireLock(video)
    assert.equal(result.ok, false)
    assert.match(result.ok ? '' : result.reason, /pid 99 on other-box/)
  })

  it('releaseAllLocksSync removes what this process holds', async () => {
    const video = await write(path.join(tmp.dir, 'a.mp4'))
    await acquireLock(video)
    releaseAllLocksSync()
    assert.ok(!(await exists(lockPathFor(video))))
  })
})
