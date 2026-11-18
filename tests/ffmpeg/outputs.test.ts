/** Moves never replace an existing destination; part names and promotion. */
import assert from 'node:assert/strict'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { isAlreadyExists, moveExclusive, partPath, promotePart, toPartSteps } from '../../src/ffmpeg/outputs.js'
import type { FfmpegStep } from '../../src/types.js'
import { makeTempDir } from './fixtures.js'

let dir = ''
beforeEach(async () => {
  dir = await makeTempDir('outputs')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('moveExclusive', () => {
  it('moves a file and removes the source', async () => {
    await writeFile(path.join(dir, 'a'), 'A')
    await moveExclusive(path.join(dir, 'a'), path.join(dir, 'b'))
    assert.deepEqual(await readdir(dir), ['b'])
    assert.equal(await readFile(path.join(dir, 'b'), 'utf8'), 'A')
  })

  it('fails with EEXIST and leaves both files untouched when the destination exists', async () => {
    await writeFile(path.join(dir, 'a'), 'A')
    await writeFile(path.join(dir, 'b'), 'B')
    const error = await moveExclusive(path.join(dir, 'a'), path.join(dir, 'b')).catch((e: unknown) => e)
    assert.equal(isAlreadyExists(error), true)
    assert.equal(await readFile(path.join(dir, 'b'), 'utf8'), 'B')
    assert.equal(await readFile(path.join(dir, 'a'), 'utf8'), 'A')
  })
})

describe('part names', () => {
  it('maps .mp4 to .part.mp4 and rewrites exactly the step output tokens', () => {
    assert.equal(partPath('/x/v.mp4.0.mp4'), '/x/v.mp4.0.part.mp4')
    assert.equal(partPath('/x/v.MP4'), '/x/v.part.mp4')
    assert.equal(partPath('/x/v.bin'), '/x/v.bin.part')
    const steps: FfmpegStep[] = [
      { kind: 'cut', argv: ['-i', '/x/v.mp4', '/x/v.mp4.0.mp4', '-y'], output: '/x/v.mp4.0.mp4', expectedMs: 1 },
      { kind: 'concat', argv: ['-i', '/x/v.mp4.0.mp4', '/x/v.mp4.mp4', '-y'], output: '/x/v.mp4.mp4', expectedMs: 1 }
    ]
    const parts = toPartSteps(steps)
    assert.deepEqual(parts[0]?.argv, ['-i', '/x/v.mp4', '/x/v.mp4.0.part.mp4', '-y'])
    assert.deepEqual(parts[1]?.argv, ['-i', '/x/v.mp4.0.part.mp4', '/x/v.mp4.part.mp4', '-y'])
    assert.equal(parts[1]?.output, '/x/v.mp4.part.mp4')
  })
})

describe('promotePart', () => {
  it('takes a collision name when the final exists and no trash callback is given', async () => {
    const final = path.join(dir, 'v.mp4.0.mp4')
    await writeFile(final, 'OLD')
    await writeFile(partPath(final), 'NEW')
    const used = await promotePart(partPath(final), final, { log: () => undefined })
    assert.equal(used, path.join(dir, 'v.mp4.0 (1).mp4'))
    assert.equal(await readFile(final, 'utf8'), 'OLD')
    assert.equal(await readFile(used, 'utf8'), 'NEW')
  })

  it('trashes the existing file first when asked', async () => {
    const final = path.join(dir, 'v.mp4.0.mp4')
    await writeFile(final, 'OLD')
    await writeFile(partPath(final), 'NEW')
    const trashed: string[] = []
    const used = await promotePart(partPath(final), final, {
      log: () => undefined,
      trashExisting: async (p) => {
        trashed.push(p)
        await rm(p)
      }
    })
    assert.deepEqual(trashed, [final])
    assert.equal(used, final)
    assert.equal(await readFile(final, 'utf8'), 'NEW')
  })
})
