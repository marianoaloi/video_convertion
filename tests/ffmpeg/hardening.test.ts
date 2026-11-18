/** Review fixes: stall watchdog, ladder memory, kill-all registry, removeQuietly, PATH exec bit, big capture. */
import assert from 'node:assert/strict'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createLadderMemory } from '../../src/ffmpeg/ladderMemory.js'
import { findOnPath } from '../../src/ffmpeg/locate.js'
import { killAllChildrenSync, runProcess } from '../../src/ffmpeg/process.js'
import { runFfmpegJob } from '../../src/ffmpeg/runner.js'
import { removeQuietly, runStepProcess } from '../../src/ffmpeg/steps.js'
import type { FfmpegJobRequest, ProgressSample, StepExecutor } from '../../src/types.js'
import { makeJob, makeTempDir } from './fixtures.js'

let dir = ''
beforeEach(async () => {
  dir = await makeTempDir('hard')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('stall watchdog', () => {
  const HANG =
    'process.stdout.write("out_time_us=1000000\\nspeed=1x\\nprogress=continue\\n");setInterval(()=>{},1000)'

  it('kills a step that prints one progress block and then hangs, with status timeout', async () => {
    const lines: string[] = []
    const samples: ProgressSample[] = []
    const started = Date.now()
    const exit = await runStepProcess(process.execPath, ['-e', HANG], {
      argv: [],
      stallTimeoutMs: 600,
      onProgress: (s) => samples.push(s),
      onStderrLine: (l) => lines.push(l)
    })
    assert.equal(exit.status, 'timeout')
    assert.equal(samples.length, 1)
    assert.ok(lines.some((l) => l.startsWith('vconv: no progress for')))
    assert.ok(Date.now() - started < 10_000)
  })

  it('a step that keeps advancing is not killed, and a user abort stays cancelled', async () => {
    const ticking =
      'let t=0;const i=setInterval(()=>{t+=1000000;process.stdout.write("out_time_us="+t+"\\nprogress=continue\\n");if(t>=5000000){clearInterval(i)}},150)'
    const ok = await runStepProcess(process.execPath, ['-e', ticking], {
      argv: [],
      stallTimeoutMs: 700,
      onProgress: () => undefined,
      onStderrLine: () => undefined
    })
    assert.deepEqual([ok.status, ok.exitCode], ['exited', 0])
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 200)
    const cancelled = await runStepProcess(process.execPath, ['-e', HANG], {
      argv: [],
      signal: ac.signal,
      stallTimeoutMs: 60_000,
      onProgress: () => undefined,
      onStderrLine: () => undefined
    })
    assert.equal(cancelled.status, 'cancelled')
  })

  it('counts the first sample from spawn: a step that never prints progress is killed', async () => {
    const exit = await runStepProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      argv: [],
      stallTimeoutMs: 400,
      onProgress: () => undefined,
      onStderrLine: () => undefined
    })
    assert.equal(exit.status, 'timeout')
  })
})

describe('ladder memory', () => {
  const nvenc = { encoder: 'h264_nvenc', hwaccel: true, strategy: 'direct' } as const

  it('skips a rung after the threshold of failures without a success, ignoring the strategy', () => {
    const m = createLadderMemory(3)
    m.record(nvenc, false)
    m.record({ ...nvenc, strategy: 'copyThenCut' }, false)
    assert.equal(m.shouldSkip(nvenc), false)
    m.record(nvenc, false)
    assert.equal(m.shouldSkip(nvenc), true)
    assert.equal(m.shouldSkip({ ...nvenc, hwaccel: false }), false)
    m.record(nvenc, true)
    assert.equal(m.shouldSkip(nvenc), false)
  })

  /** nvenc steps (and nothing else) fail. */
  function failingNvenc(calls: string[][]): StepExecutor {
    return async (req) => {
      calls.push([...req.argv])
      const bad = req.argv.includes('h264_nvenc')
      if (!bad) await writeFile(req.argv[req.argv.length - 2] ?? '', Buffer.alloc(5000, 1))
      return { status: 'exited', exitCode: bad ? 1 : 0 }
    }
  }
  const base = (over: Partial<FfmpegJobRequest>): FfmpegJobRequest => ({
    ffmpegPath: 'ffmpeg',
    job: makeJob(),
    media: { durationMs: 10_000, width: 320, height: 240, bitrateKbps: 400, rotation: 0, hasAudio: true },
    inputPath: path.join(dir, 'v.mp4'),
    encoders: ['h264_nvenc', 'libx264'],
    gpu: false,
    sameSize: false,
    maxRateKbps: 500,
    maxSide: 640,
    minOutputBytes: 1000,
    ...over
  })

  it('stops trying the failing encoder in later jobs and logs it once per job', async () => {
    const memory = createLadderMemory(3)
    const perJob: number[] = []
    const logs: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const calls: string[][] = []
      const result = await runFfmpegJob(
        base({ ladderMemory: memory, executor: failingNvenc(calls), onLog: (l) => logs.push(l) })
      )
      assert.equal(result.ok, true)
      await rm(path.join(dir, 'v.mp4.0.mp4'), { force: true })
      perJob.push(calls.length)
    }
    assert.ok((perJob[0] ?? 0) > 1)
    assert.equal(perJob[3], 1)
    assert.equal(logs.filter((l) => l.startsWith('Skipping h264_nvenc')).length, 2) // once per skipping job (3 and 4)
  })

  it('never filters the ladder to empty', async () => {
    const memory = createLadderMemory(1)
    memory.record({ encoder: 'libx264', hwaccel: false, strategy: 'direct' }, false)
    const calls: string[][] = []
    const result = await runFfmpegJob(
      base({ ladderMemory: memory, encoders: ['libx264'], executor: failingNvenc(calls) })
    )
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)
  })
})

describe('killAllChildrenSync', () => {
  it('kills live children and their trees', async () => {
    let pid = 0
    await runProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("PID:"+process.pid+"\\n");setInterval(()=>{},1000)'],
      onStdoutLine: (l) => {
        const m = /^PID:(\d+)$/.exec(l)
        if (m?.[1] !== undefined) {
          pid = Number(m[1])
          killAllChildrenSync()
        }
      }
    })
    assert.ok(pid > 0)
    assert.throws(() => process.kill(pid, 0))
  })

  it('is a no-op without children', () => {
    killAllChildrenSync()
  })
})

describe('removeQuietly', () => {
  it('true for a file and a missing file; false (not a throw) when it cannot be removed', async () => {
    const file = path.join(dir, 'a.part.mp4')
    await writeFile(file, 'x')
    assert.equal(await removeQuietly(file), true)
    assert.equal(await removeQuietly(file), true)
    const folder = path.join(dir, 'full')
    await mkdir(folder)
    await writeFile(path.join(folder, 'f'), 'x')
    assert.equal(await removeQuietly(folder), false)
  })
})

describe('PATH lookup executable bit', { skip: process.platform === 'win32' }, () => {
  it('skips a non-executable ffmpeg earlier in PATH', async () => {
    const a = path.join(dir, 'a')
    const b = path.join(dir, 'b')
    await mkdir(a)
    await mkdir(b)
    await writeFile(path.join(a, 'ffmpeg'), 'x')
    await chmod(path.join(a, 'ffmpeg'), 0o644)
    await writeFile(path.join(b, 'ffmpeg'), 'x')
    await chmod(path.join(b, 'ffmpeg'), 0o755)
    assert.equal(findOnPath('ffmpeg', { env: { PATH: `${a}:${b}` }, platform: 'linux' }), path.join(b, 'ffmpeg'))
  })
})

describe('maxCaptureBytes', () => {
  it('honours a bigger cap than the default', async () => {
    const total = 3 * 1024 * 1024
    const r = await runProcess({
      command: process.execPath,
      args: ['-e', `process.stdout.write("x".repeat(${total}))`],
      maxCaptureBytes: 8 * 1024 * 1024
    })
    assert.equal(r.stdout.length, total)
  })
})
