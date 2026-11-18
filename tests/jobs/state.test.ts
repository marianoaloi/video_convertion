import assert from 'node:assert/strict'
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { openStateLedger } from '../../src/jobs/state.js'
import { makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

describe('state ledger', () => {
  it('resumes after a restart: a recorded video is done, a changed one is not', async () => {
    const file = path.join(tmp.dir, 'state', 'run.jsonl')
    const video = await write(path.join(tmp.dir, 'a.mp4'), 'x'.repeat(100))
    const out = await write(`${video}.0.mp4`, 'y'.repeat(50))
    const info = await stat(video)
    const first = await openStateLedger(file)
    assert.equal(first.isDone(video, info.size, info.mtimeMs), false)
    await first.recordDone(video, { size: info.size, mtimeMs: info.mtimeMs }, [out])
    await first.recordFailed(path.join(tmp.dir, 'b.mp4'), 'boom')
    await first.close()

    const second = await openStateLedger(file)
    assert.equal(second.isDone(video, info.size, info.mtimeMs), true)
    assert.equal(second.isDone(video, info.size + 1, info.mtimeMs), false)
    assert.equal(second.isDone(video, info.size, info.mtimeMs + 5000), false)
    assert.equal(second.isDone(path.join(tmp.dir, 'b.mp4'), 1, 1), false)
  })

  it('tolerates corrupt and partial lines', async () => {
    const file = path.join(tmp.dir, 'run.jsonl')
    const video = path.join(tmp.dir, 'a.mp4')
    const good = JSON.stringify({ t: 'done', path: video, size: 10, mtimeMs: 123, outputs: [] })
    await writeFile(file, `garbage\n${good}\n{"t":"done","path":"x"\n[1,2]\n\n{"t":"done"`)
    const ledger = await openStateLedger(file)
    assert.equal(ledger.isDone(video, 10, 123), true)
    assert.equal(ledger.size, 1)
    await ledger.recordFailed(video, 'later failure')
    await ledger.close()
    assert.match(await readFile(file, 'utf8'), /later failure/)
  })

  it('recognises the renamed output now sitting at the source path', async () => {
    const file = path.join(tmp.dir, 'run.jsonl')
    const video = path.join(tmp.dir, 'a.mp4')
    const source = { size: 1000, mtimeMs: 1_700_000_000_000 }
    await write(video, 'converted-small') // the output after delete-original + rename
    const converted = await stat(video)
    const ledger = await openStateLedger(file)
    await ledger.recordDone(video, source, [video])
    await ledger.close()
    const again = await openStateLedger(file)
    assert.equal(again.isDone(video, converted.size, converted.mtimeMs), true)
    assert.equal(again.isDone(video, source.size, source.mtimeMs), true)
  })

  it('appends one line per record', async () => {
    const file = path.join(tmp.dir, 'run.jsonl')
    const ledger = await openStateLedger(file)
    await Promise.all([1, 2, 3].map((n) => ledger.recordFailed(`/v/${n}.mp4`, 'x')))
    await ledger.close()
    await appendFile(file, '')
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3)
  })

  it('creates missing parent folders; a missing file is an empty ledger', async () => {
    const file = path.join(tmp.dir, 'no', 'such', 'dir', 'state.jsonl')
    const ledger = await openStateLedger(file)
    assert.equal(ledger.size, 0)
    assert.equal(ledger.isDone('/v/a.mp4', 1, 1), false)
    await ledger.recordFailed('/v/a.mp4', 'x')
    await ledger.close()
    assert.match(await readFile(file, 'utf8'), /"failed"/)
  })

  it('loads 100k lines well under a second', async () => {
    const file = path.join(tmp.dir, 'big.jsonl')
    const lines: string[] = []
    for (let i = 0; i < 100_000; i += 1) {
      const p = `/videos/folder${i % 50}/video${i}.mp4`
      lines.push(JSON.stringify({ t: 'done', path: p, size: i, mtimeMs: 1000 + i, outputs: [{ path: `${p}.0.mp4`, size: 5, mtimeMs: 1 }], at: 'x' }))
    }
    await writeFile(file, `${lines.join('\n')}\n`)
    const started = performance.now()
    const ledger = await openStateLedger(file)
    const elapsed = performance.now() - started
    assert.equal(ledger.isDone('/videos/folder7/video99957.mp4', 99957, 100957), true)
    assert.ok(elapsed < 1000, `loading took ${Math.round(elapsed)} ms`)
  })
})
