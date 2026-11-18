import assert from 'node:assert/strict'
import { access, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { createVideoJob } from '../../src/core/videoJob.js'
import { executeJob, type ExecutorDeps } from '../../src/jobs/executor.js'
import type { PlannedJob } from '../../src/types.js'
import { fakeHandle, fakeMedia, makeConfig, makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)

async function planned(): Promise<PlannedJob> {
  const video = await write(path.join(tmp.dir, 'bad.mp4'))
  return {
    id: 1,
    videoPath: video,
    jsonPath: null,
    job: createVideoJob(video, { times: [] }),
    warnings: [],
    root: tmp.dir,
    expectedOutputs: [`${video}.0.mp4`]
  }
}

function deps(probe: ExecutorDeps['probe']): ExecutorDeps {
  return { tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, probe, remove: async () => undefined }
}

describe('executeJob: probe failures', () => {
  it('writes <video>.log and sets the log path when ffprobe cannot read the file', async () => {
    const job = await planned()
    const handle = fakeHandle()
    handle.log('earlier line')
    const outcome = await executeJob(
      deps(async () => Promise.reject(new Error('Invalid data found when processing input'))),
      job,
      makeConfig({ failureLog: true }),
      handle
    )
    assert.deepEqual(outcome, { kind: 'error', message: 'Invalid data found when processing input' })
    assert.equal(handle.logPath, `${job.videoPath}.log`)
    const text = await readFile(`${job.videoPath}.log`, 'utf8')
    assert.match(text, /earlier line/)
    assert.match(text, /Invalid data found/)
  })

  it('does the same for a file without a video stream', async () => {
    const job = await planned()
    const handle = fakeHandle()
    const outcome = await executeJob(
      deps(async () => fakeMedia(1000, { hasVideo: false })),
      job,
      makeConfig({ failureLog: true }),
      handle
    )
    assert.equal(outcome.kind, 'error')
    assert.equal(handle.logPath, `${job.videoPath}.log`)
    assert.match(await readFile(`${job.videoPath}.log`, 'utf8'), /no video stream/)
  })

  it('writes nothing without failureLog or in a dry run', async () => {
    const job = await planned()
    for (const config of [makeConfig({ failureLog: false }), makeConfig({ failureLog: true, dryRun: true })]) {
      const handle = fakeHandle()
      const outcome = await executeJob(deps(async () => Promise.reject(new Error('bad'))), job, config, handle)
      assert.equal(outcome.kind, 'error')
      assert.equal(handle.logPath, null)
      assert.ok(!(await exists(`${job.videoPath}.log`)))
    }
  })

  it('an aborted probe is cancelled, with no log', async () => {
    const job = await planned()
    const handle = fakeHandle()
    handle.abort()
    const outcome = await executeJob(
      deps(async () => Promise.reject(new Error('aborted'))),
      job,
      makeConfig({ failureLog: true }),
      handle
    )
    assert.deepEqual(outcome, { kind: 'cancelled' })
    assert.ok(!(await exists(`${job.videoPath}.log`)))
  })
})

describe('executeJob: existing outputs and stderr', () => {
  it('--existing replace only ever TRASHES the old output, whatever --delete-mode says', async () => {
    const job = await planned()
    const final = job.expectedOutputs[0] as string
    await write(final, 'old'.repeat(1000))
    const removed: string[] = []
    const handle = fakeHandle()
    const outcome = await executeJob(
      {
        tools: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
        probe: async () => fakeMedia(5000),
        remove: async (target, mode) => {
          removed.push(`${mode}:${path.basename(target)}`)
          await rm(target, { force: true })
        },
        stepExecutor: () => async (request) => {
          for (let i = 0; i < 500; i += 1) request.onStderrLine('same noise')
          for (let i = 0; i < 300; i += 1) request.onStderrLine(`distinct ${i}`)
          await write(request.argv[request.argv.length - 2] as string, 'n'.repeat(5000))
          return { status: 'exited', exitCode: 0 }
        }
      },
      job,
      makeConfig({ existing: 'replace', deleteMode: 'permanent' }),
      handle
    )
    assert.equal(outcome.kind, 'done')
    assert.deepEqual(removed, ['trash:bad.mp4.0.mp4'])
    const stderr = handle.logs.filter((l) => l.level === 'stderr').map((l) => l.line)
    assert.ok(stderr.length <= 204, `forwarded ${stderr.length} stderr lines`)
    assert.ok(stderr.includes('(last line repeated 499 times)'))
    assert.ok(stderr.some((l) => /more ffmpeg lines suppressed/.test(l)))
  })
})
