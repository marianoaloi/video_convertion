import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { findOnPath } from '../../src/ffmpeg/locate.js'
import { startRun } from '../../src/jobs/run.js'
import type { RunEvent } from '../../src/types.js'
import { jobJson, makeConfig, makeTmp, write } from './kit.js'

const run = promisify(execFile)
const ffmpeg = findOnPath('ffmpeg')
const ffprobe = findOnPath('ffprobe')
const available = ffmpeg !== null && ffprobe !== null

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)

async function clip(file: string, seconds = 3): Promise<string> {
  await write(file, '')
  const args = [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file
  ]
  await run(ffmpeg as string, args)
  return file
}

describe('startRun end to end (real ffmpeg)', { skip: !available }, () => {
  it('converts a folder recursively, cuts two ranges from a JSON job, and resumes from the state file', async () => {
    const a = await clip(path.join(tmp.dir, 'a.mp4'))
    const b = await clip(path.join(tmp.dir, 'b.mp4'))
    const c = await clip(path.join(tmp.dir, 'c.mp4'), 4)
    const sub = await clip(path.join(tmp.dir, 'sub', 'd.mp4'))
    await write(`${c}.json`, jobJson(c, [[0, 1000], [2000, 3500]], 1))
    const stateFile = path.join(tmp.dir, 'state', 'run.jsonl')
    const logFile = path.join(tmp.dir, 'logs', 'run.log')
    const config = makeConfig({
      inputs: [tmp.dir],
      recursive: true,
      parallel: 2,
      encoders: ['libx264'],
      hwaccel: 'none',
      stateFile,
      logFile,
      failureLog: true
    })
    const tools = { ffmpeg: ffmpeg as string, ffprobe: ffprobe as string }

    const events: RunEvent[] = []
    const first = await startRun(config, tools, (e) => events.push(e)).done
    assert.deepEqual(first.counters, { total: 4, queued: 0, processing: 0, done: 4, failed: 0, cancelled: 0, skipped: 0 })
    assert.equal(first.failures.length, 0)
    assert.equal(first.outputs.length, 5)
    for (const out of [`${a}.0.mp4`, `${b}.0.mp4`, `${sub}.0.mp4`, `${c}.0.mp4`, `${c}.1.mp4`]) {
      assert.ok(await exists(out), `missing ${out}`)
    }
    assert.ok(events.some((e) => e.type === 'scan-done'))
    assert.ok(events.some((e) => e.type === 'progress'))
    assert.equal(events.at(-1)?.type, 'finished')
    assert.match(await readFile(logFile, 'utf8'), /\[#\d+ a\.mp4\] done:/)
    assert.ok((await readdir(tmp.dir)).every((n) => !n.endsWith('.log')))

    const again: RunEvent[] = []
    const second = await startRun(config, tools, (e) => again.push(e)).done
    assert.equal(second.counters.total, 0)
    assert.equal(second.counters.done, 0)
    assert.equal(second.counters.skipped, 4)
    const scan = again.find((e) => e.type === 'scan-done')
    assert.equal(scan?.type === 'scan-done' && scan.result.counts.alreadyDone, 4)
  })

  it('a corrupt file fails alone and writes <video>.log; listOnly runs nothing', async () => {
    const good = await clip(path.join(tmp.dir, 'good.mp4'), 2)
    const bad = await write(path.join(tmp.dir, 'bad.mp4'), 'this is not a video'.repeat(100))
    const tools = { ffmpeg: ffmpeg as string, ffprobe: ffprobe as string }
    const base = { inputs: [tmp.dir], encoders: ['libx264'], hwaccel: 'none' as const, failureLog: true }

    const listed = await startRun(makeConfig({ ...base, listOnly: true }), tools, () => undefined).done
    assert.equal(listed.counters.total, 2)
    assert.equal(listed.counters.done, 0)
    assert.ok(!(await exists(`${good}.0.mp4`)))

    const summary = await startRun(makeConfig(base), tools, () => undefined).done
    assert.equal(summary.counters.done, 1)
    assert.equal(summary.counters.failed, 1)
    assert.equal(summary.failures[0]?.videoPath, bad)
    assert.ok(await exists(`${good}.0.mp4`))
  })

  it('deleteOriginal removes the source after verification and the output takes its name', async () => {
    const v = await clip(path.join(tmp.dir, 'v.mp4'), 2)
    const tools = { ffmpeg: ffmpeg as string, ffprobe: ffprobe as string }
    const stateFile = path.join(tmp.dir, 'state.jsonl')
    const config = makeConfig({
      inputs: [tmp.dir],
      encoders: ['libx264'],
      hwaccel: 'none',
      deleteOriginal: true,
      deleteMode: 'permanent',
      stateFile
    })
    const summary = await startRun(config, tools, () => undefined).done
    assert.equal(summary.counters.done, 1)
    assert.deepEqual(summary.outputs, [v])
    assert.ok(!(await exists(`${v}.0.mp4`)))
    const again = await startRun(config, tools, () => undefined).done
    assert.equal(again.counters.total, 0, 'the converted file at the source path must be recognised as done')
  })
})
