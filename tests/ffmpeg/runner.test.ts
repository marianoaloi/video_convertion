/** The attempt ladder, success rule, part files, cancel and dry run with a fake ffmpeg. */
import assert from 'node:assert/strict'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { buildLadder } from '../../src/core/ladder.js'
import { runFfmpegJob } from '../../src/ffmpeg/runner.js'
import { fileSize } from '../../src/ffmpeg/steps.js'
import type { FfmpegJobRequest, RunnerProgress, StepExecutor, StepRequest } from '../../src/types.js'
import { makeJob as job, makeTempDir } from './fixtures.js'

let dir = ''
beforeEach(async () => {
  dir = await makeTempDir('runner')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const MEDIA = { durationMs: 10_000, width: 320, height: 240, bitrateKbps: 400, rotation: 0, hasAudio: true }
const TWO_RANGES = job({ posExecution: 2, times: [[0, 1000], [2000, 3000]] })

function request(over: Partial<FfmpegJobRequest> = {}): FfmpegJobRequest {
  return {
    ffmpegPath: 'ffmpeg',
    job: job(),
    media: MEDIA,
    inputPath: path.join(dir, 'v.mp4'),
    encoders: ['h264_nvenc', 'libx264'],
    gpu: true,
    sameSize: false,
    maxRateKbps: 500,
    maxSide: 640,
    minOutputBytes: 1000,
    ...over
  }
}

interface FakeResult {
  exit?: number
  bytes?: number
  status?: 'exited' | 'cancelled' | 'spawn-error'
}
type Script = (call: number, argv: readonly string[], req: StepRequest) => Promise<FakeResult> | FakeResult

/** A fake ffmpeg: records every argv, writes `bytes` to the output (`argv[length-2]`, `-y` is last). */
function fake(script: Script): { executor: StepExecutor; calls: string[][] } {
  const calls: string[][] = []
  const executor: StepExecutor = async (req) => {
    calls.push([...req.argv])
    const result = await script(calls.length - 1, req.argv, req)
    const output = req.argv[req.argv.length - 2] ?? ''
    if ((result.bytes ?? 5000) > 0 && result.status === undefined) {
      await writeFile(output, Buffer.alloc(result.bytes ?? 5000, 1))
    }
    return {
      status: result.status ?? 'exited',
      exitCode: result.status === undefined || result.status === 'exited' ? (result.exit ?? 0) : null,
      ...(result.status === 'spawn-error' ? { spawnError: 'ENOENT' } : {})
    }
  }
  return { executor, calls }
}

async function files(): Promise<string[]> {
  return (await readdir(dir)).sort()
}

describe('attempt ladder', () => {
  it('has the documented shape', () => {
    const ladder = buildLadder(['h264_nvenc', 'libx264'], true)
    assert.equal(ladder.length, 8)
    assert.deepEqual(ladder.slice(0, 4), [
      { encoder: 'h264_nvenc', hwaccel: true, strategy: 'direct' },
      { encoder: 'h264_nvenc', hwaccel: true, strategy: 'copyThenCut' },
      { encoder: 'libx264', hwaccel: true, strategy: 'direct' },
      { encoder: 'libx264', hwaccel: true, strategy: 'copyThenCut' }
    ])
    assert.deepEqual(ladder[6], { encoder: 'libx264', hwaccel: false, strategy: 'direct' })
    assert.equal(buildLadder(['h264_nvenc', 'libx264'], false).length, 4)
    assert.equal(buildLadder(['libx264'], true).length, 4)
    assert.equal(buildLadder(['libx264', 'libx264'], false).length, 2)
  })

  it('gives every attempt the right encoder, hwaccel and strategy; stops at the first success', async () => {
    const { executor, calls } = fake((call) => ({ exit: call < 6 ? 1 : 0 }))
    const result = await runFfmpegJob(request({ executor }))
    assert.equal(result.ok, true)
    const encoders = calls.map((argv) => argv[argv.indexOf('-c:v') + 1])
    const hw = calls.map((argv) => argv.includes('-hwaccel'))
    const copies = calls.filter((argv) => argv.includes('-c') && argv[argv.indexOf('-c') + 1] === 'copy')
    assert.equal(calls.length, 7)
    assert.equal(encoders.filter((e) => e === 'h264_nvenc').length, 2)
    assert.equal(copies.length, 3)
    // the stream-copy steps never carry hwaccel flags
    assert.deepEqual(hw, [true, false, true, false, false, false, false])
    if (result.ok) assert.deepEqual(result.attempt, { encoder: 'libx264', hwaccel: false, strategy: 'direct' })
  })

  it('a failed attempt leaves no outputs and the next starts clean', async () => {
    const { executor } = fake((call) => ({ exit: call === 0 ? 1 : 0 }))
    const input = path.join(dir, 'v.mp4')
    const result = await runFfmpegJob(request({ executor, job: TWO_RANGES, keepParts: true }))
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.outputs, [`${input}.mp4`])
    assert.deepEqual(await files(), ['v.mp4.0.mp4', 'v.mp4.1.mp4', 'v.mp4.mp4'])
  })
})

describe('success rule', () => {
  it('999 bytes with exit 0 fails and the file is deleted; 1000 bytes succeeds', async () => {
    const small = fake(() => ({ bytes: 999 }))
    const bad = await runFfmpegJob(request({ executor: small.executor, encoders: ['libx264'], gpu: false }))
    assert.equal(bad.ok, false)
    assert.deepEqual(await files(), [])
    const edge = fake(() => ({ bytes: 1000 }))
    const good = await runFfmpegJob(request({ executor: edge.executor, encoders: ['libx264'], gpu: false }))
    assert.equal(good.ok, true)
  })

  it('exit 1 with a 5 MB file fails and the file is deleted', async () => {
    const { executor } = fake(() => ({ exit: 1, bytes: 5_000_000 }))
    const result = await runFfmpegJob(request({ executor, encoders: ['libx264'], gpu: false }))
    assert.equal(result.ok, false)
    assert.deepEqual(await files(), [])
  })

  it('exit 0 with decoder-init warnings on stderr is a success', async () => {
    const { executor } = fake((_call, _argv, req) => {
      req.onStderrLine('[h264 @ 000] cuvidCreateDecoder failed: CUDA_ERROR_INVALID_VALUE')
      req.onStderrLine('Failed setup for format cuda: hwaccel initialisation returned error')
      return { exit: 0 }
    })
    const result = await runFfmpegJob(request({ executor }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.attempt.encoder, 'h264_nvenc')
  })

  it('reports the last ffmpeg lines when every attempt fails', async () => {
    const { executor, calls } = fake((_c, _a, req) => {
      req.onStderrLine('boom')
      return { exit: 1 }
    })
    const result = await runFfmpegJob(request({ executor }))
    assert.ok(calls.length >= 8)
    assert.equal(result.ok, false)
    if (!result.ok) assert.deepEqual([result.cancelled, result.lastLines], [false, ['boom']])
    assert.deepEqual(await files(), [])
  })

  it('a missing ffmpeg binary stops the ladder at once', async () => {
    const { executor, calls } = fake(() => ({ status: 'spawn-error' }))
    const result = await runFfmpegJob(request({ executor }))
    assert.equal(calls.length, 1)
    assert.equal(result.ok, false)
  })
})

describe('temp copy and parts', () => {
  it('deletes a stale copy part before the copy step and the copy after the re-encode', async () => {
    const stale = path.join(dir, 'v.mp4.copy.part.mp4')
    await writeFile(stale, 'stale')
    const seen: (number | null)[] = []
    const { executor } = fake(async (call, argv) => {
      if (argv.includes('copy')) seen.push(await fileSize(stale))
      return { exit: call === 0 ? 1 : 0 }
    })
    const result = await runFfmpegJob(request({ executor, encoders: ['libx264'], gpu: false }))
    assert.equal(result.ok, true)
    assert.deepEqual(seen, [null])
    assert.deepEqual(await files(), ['v.mp4.0.mp4'])
  })

  it('trashes concat parts only after the concat succeeded', async () => {
    const trashed: string[] = []
    const concatSeen: string[][] = []
    const { executor } = fake((_c, argv) => {
      if (argv.includes('-filter_complex')) concatSeen.push([...trashed])
      return { exit: 0 }
    })
    const input = path.join(dir, 'v.mp4')
    const result = await runFfmpegJob(
      request({
        executor,
        job: TWO_RANGES,
        trashPart: async (p) => {
          trashed.push(p)
        }
      })
    )
    assert.deepEqual(concatSeen, [[]])
    assert.deepEqual(trashed, [`${input}.0.part.mp4`, `${input}.1.part.mp4`])
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.outputs, [`${input}.mp4`])
  })

  it('keepParts keeps them and a failing concat trashes nothing', async () => {
    const trashed: string[] = []
    const trashPart = async (p: string): Promise<void> => {
      trashed.push(p)
    }
    const keep = fake(() => ({ exit: 0 }))
    await runFfmpegJob(request({ executor: keep.executor, keepParts: true, job: TWO_RANGES, trashPart }))
    assert.deepEqual(trashed, [])
    const failing = fake((_c, argv) => ({ exit: argv.includes('-filter_complex') ? 1 : 0 }))
    const result = await runFfmpegJob(
      request({ executor: failing.executor, encoders: ['libx264'], gpu: false, job: TWO_RANGES, trashPart })
    )
    assert.equal(result.ok, false)
    assert.deepEqual(trashed, [])
  })
})

describe('outputs are never overwritten', () => {
  const input = (): string => path.join(dir, 'v.mp4')

  it('ffmpeg writes *.part.mp4 and the final name appears only after success', async () => {
    const written: string[] = []
    const { executor } = fake(async (_c, argv) => {
      written.push(path.basename(argv[argv.length - 2] ?? ''))
      assert.ok(!(await files()).includes('v.mp4.0.mp4'))
      return { exit: 0 }
    })
    const result = await runFfmpegJob(request({ executor }))
    assert.deepEqual(written, ['v.mp4.0.part.mp4'])
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.outputs, [`${input()}.0.mp4`])
    assert.deepEqual(await files(), ['v.mp4.0.mp4'])
  })

  it('an existing output goes through trashExisting before the new file takes its name', async () => {
    await writeFile(`${input()}.0.mp4`, 'OLD')
    const trashed: string[] = []
    const { executor } = fake(() => ({ exit: 0 }))
    const result = await runFfmpegJob(
      request({
        executor,
        trashExisting: async (p) => {
          trashed.push(p)
          await rm(p)
        }
      })
    )
    assert.deepEqual(trashed, [`${input()}.0.mp4`])
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.outputs, [`${input()}.0.mp4`])
    assert.equal(await fileSize(`${input()}.0.mp4`), 5000)
  })

  it('without trashExisting the existing output stays and the new one gets a collision name', async () => {
    await writeFile(`${input()}.0.mp4`, 'OLD')
    const { executor } = fake(() => ({ exit: 0 }))
    const result = await runFfmpegJob(request({ executor }))
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.outputs, [path.join(dir, 'v.mp4.0 (1).mp4')])
    assert.equal(await readFile(`${input()}.0.mp4`, 'utf8'), 'OLD')
  })

  it('a failed run removes only its own part files, never an earlier output', async () => {
    await writeFile(`${input()}.0.mp4`, 'OLD')
    const { executor } = fake(() => ({ exit: 1, bytes: 5000 }))
    const result = await runFfmpegJob(request({ executor, encoders: ['libx264'], gpu: false }))
    assert.equal(result.ok, false)
    assert.deepEqual(await files(), ['v.mp4.0.mp4'])
    assert.equal(await readFile(`${input()}.0.mp4`, 'utf8'), 'OLD')
  })

  it('keepParts promotes the cut parts to their final names after the concat', async () => {
    const { executor } = fake(() => ({ exit: 0 }))
    const result = await runFfmpegJob(request({ executor, keepParts: true, job: TWO_RANGES }))
    assert.equal(result.ok, true)
    if (result.ok) assert.deepEqual(result.outputs, [`${input()}.mp4`])
    assert.deepEqual(await files(), ['v.mp4.0.mp4', 'v.mp4.1.mp4', 'v.mp4.mp4'])
  })
})

describe('progress, cancel, dry run', () => {
  it('maps out_time to overall progress over the steps', async () => {
    const seen: RunnerProgress[] = []
    const { executor } = fake((_c, _a, req) => {
      req.onProgress({ outTimeMs: 1000, speed: 2, end: false })
      return { exit: 0 }
    })
    await runFfmpegJob(
      request({ executor, job: job({ times: [[0, 2000], [4000, 6000]] }), onProgress: (p) => seen.push(p) })
    )
    assert.deepEqual(seen.map((p) => p.progress), [0.25, 0.5, 0.75, 1])
    assert.deepEqual(
      { ...seen[0] },
      { progress: 0.25, stepIndex: 0, stepCount: 2, outTimeMs: 1000, speed: 2 }
    )
  })

  it('cancelling through the AbortSignal removes the outputs and reports cancelled', async () => {
    const controller = new AbortController()
    const { executor } = fake(async (_c, _a, req) => {
      controller.abort()
      await new Promise((r) => setTimeout(r, 10))
      assert.equal(req.signal?.aborted, true)
      return { status: 'cancelled', bytes: 4000 }
    })
    const result = await runFfmpegJob(request({ executor, signal: controller.signal }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.cancelled, true)
    assert.deepEqual(await files(), [])
  })

  it('an already aborted signal does not start anything', async () => {
    const controller = new AbortController()
    controller.abort()
    const { executor, calls } = fake(() => ({}))
    const result = await runFfmpegJob(request({ executor, signal: controller.signal }))
    assert.equal(calls.length, 0)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.cancelled, true)
  })

  it('dryRun logs the first attempt argv and touches no file', async () => {
    const { executor, calls } = fake(() => ({}))
    const lines: string[] = []
    const result = await runFfmpegJob(
      request({
        executor,
        dryRun: true,
        onLog: (l) => lines.push(l),
        trashPart: () => Promise.reject(new Error('no'))
      })
    )
    assert.equal(calls.length, 0)
    assert.equal(result.ok, true)
    assert.ok(lines.some((l) => l.startsWith('$ ffmpeg ')))
    assert.equal(lines.filter((l) => l.startsWith('$ ffmpeg ')).length, 1)
    assert.deepEqual(await files(), [])
  })

  it('a whole-video job with an unknown duration fails without running ffmpeg', async () => {
    const { executor, calls } = fake(() => ({}))
    const result = await runFfmpegJob(
      request({ executor, job: job({ times: [] }), media: { ...MEDIA, durationMs: 0 } })
    )
    assert.equal(calls.length, 0)
    assert.equal(result.ok, false)
  })
})
