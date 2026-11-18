/** One real-ffmpeg smoke test: probe a generated clip, then run a cut job and a concat job. */
import assert from 'node:assert/strict'
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { probeMedia } from '../../src/ffmpeg/probe.js'
import { runFfmpegJob } from '../../src/ffmpeg/runner.js'
import { fileSize } from '../../src/ffmpeg/steps.js'
import type { FfmpegJobRequest, MediaInfo } from '../../src/types.js'
import { findTestTools, generateVideo, makeJob, makeTempDir } from './fixtures.js'

const tools = findTestTools()

describe('real ffmpeg', { skip: tools === null }, () => {
  let dir = ''
  let input = ''
  let media: MediaInfo
  before(async () => {
    if (tools === null) return
    dir = await makeTempDir('real')
    input = await generateVideo(tools, dir, 'clip.mp4', { seconds: 3 })
    media = await probeMedia(input, { ffprobePath: tools.ffprobe })
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  function real(over: Partial<FfmpegJobRequest>): FfmpegJobRequest {
    return {
      ffmpegPath: tools?.ffmpeg ?? '',
      job: makeJob(),
      media,
      inputPath: input,
      encoders: ['libx264'],
      gpu: false,
      sameSize: false,
      maxRateKbps: 500,
      maxSide: 640,
      minOutputBytes: 1000,
      ...over
    }
  }

  it('converts the whole video to clip.mp4.0.mp4 and leaves no part file', async () => {
    const progress: number[] = []
    const result = await runFfmpegJob(
      real({ job: makeJob({ times: [] }), onProgress: (p) => progress.push(p.progress) })
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.outputs, [`${input}.0.mp4`])
    assert.ok(((await fileSize(`${input}.0.mp4`)) ?? 0) > 1000)
    assert.ok(!(await readdir(dir)).some((f) => f.includes('.part')))
    assert.equal(progress.at(-1), 1)
  })

  it('concatenates two ranges into clip.mp4.mp4 and hands the parts to trashPart', async () => {
    const trashed: string[] = []
    const result = await runFfmpegJob(
      real({
        job: makeJob({ posExecution: 2, times: [[0, 1000], [2000, 3000]] }),
        trashPart: async (p) => {
          trashed.push(p)
          await rm(p)
        }
      })
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.outputs, [`${input}.mp4`])
    assert.equal(trashed.length, 2)
    assert.ok(trashed.every((p) => path.dirname(p) === dir))
    assert.ok(((await fileSize(`${input}.mp4`)) ?? 0) > 1000)
    assert.ok(!(await readdir(dir)).some((f) => f.includes('.part')))
  })
})
