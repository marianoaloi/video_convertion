import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseCommandTemplate } from '../../src/core/template.js'
import { createVideoJob } from '../../src/core/videoJob.js'
import { postJob, runUploadAll, type PostDeps } from '../../src/jobs/post.js'
import type { HookContext, HookOutcome, PlannedJob } from '../../src/types.js'
import { fakeHandle, makeConfig, makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)

async function setup(times: [number, number][] = []): Promise<{ job: PlannedJob; video: string; json: string }> {
  const video = await write(path.join(tmp.dir, 'v.mp4'))
  const json = await write(`${video}.json`, '{}')
  const job: PlannedJob = {
    id: 1,
    videoPath: video,
    jsonPath: json,
    job: createVideoJob(video, { times }),
    warnings: [],
    root: tmp.dir,
    expectedOutputs: []
  }
  return { job, video, json }
}

interface Calls {
  removed: string[]
  hooks: { context: HookContext }[]
}

function fakeDeps(durations: Record<string, number | null>, calls: Calls, over: Partial<PostDeps> = {}): PostDeps {
  return {
    probeDurationMs: async (file) => durations[path.basename(file)] ?? null,
    remove: async (file) => {
      calls.removed.push(file)
    },
    runHook: async (_template, context): Promise<HookOutcome> => {
      calls.hooks.push({ context })
      return 'ok'
    },
    md5: async () => 'abc123',
    ...over
  }
}

const newCalls = (): Calls => ({ removed: [], hooks: [] })

describe('postJob', () => {
  it('does nothing without deleteOriginal and returns the outputs untouched', async () => {
    const { job, video } = await setup()
    const calls = newCalls()
    const out = `${video}.0.mp4`
    const result = await postJob(fakeDeps({}, calls), job, [out], makeConfig(), fakeHandle())
    assert.deepEqual(result, [out])
    assert.deepEqual(calls.removed, [])
  })

  it('deletes video + json after verified durations, then renames the single output to the source name', async () => {
    const { job, video, json } = await setup()
    const out = await write(`${video}.0.mp4`)
    const calls = newCalls()
    // the file is "removed" by really deleting it so the rename can take its name
    const deps = fakeDeps({ 'v.mp4': 10_000, 'v.mp4.0.mp4': 10_100 }, calls, {
      remove: async (file) => {
        calls.removed.push(file)
        const { rm } = await import('node:fs/promises')
        await rm(file)
      }
    })
    const handle = fakeHandle()
    const result = await postJob(deps, job, [out], makeConfig({ deleteOriginal: true }), handle)
    assert.deepEqual(calls.removed, [video, json])
    assert.deepEqual(result, [video])
    assert.ok(await exists(video))
    assert.ok(!(await exists(out)))
  })

  it('keeps the original when an output duration does not match', async () => {
    const { job, video } = await setup([[0, 5000]])
    const out = await write(`${video}.0.mp4`)
    const calls = newCalls()
    const handle = fakeHandle()
    const result = await postJob(
      fakeDeps({ 'v.mp4': 20_000, 'v.mp4.0.mp4': 500 }, calls),
      job,
      [out],
      makeConfig({ deleteOriginal: true }),
      handle
    )
    assert.deepEqual(calls.removed, [])
    assert.deepEqual(result, [out])
    assert.ok(handle.logs.some((l) => l.level === 'warn' && /original was kept/.test(l.line)))
  })

  it('keeps the original when the output count differs or an output cannot be probed', async () => {
    const { job, video } = await setup([[0, 1000], [2000, 3000]])
    const a = await write(`${video}.0.mp4`)
    const calls = newCalls()
    await postJob(fakeDeps({ 'v.mp4': 10_000 }, calls), job, [a], makeConfig({ deleteOriginal: true }), fakeHandle())
    assert.deepEqual(calls.removed, [])
    const b = await write(`${video}.1.mp4`)
    await postJob(fakeDeps({ 'v.mp4': 10_000, 'v.mp4.0.mp4': 1000 }, calls), job, [a, b], makeConfig({ deleteOriginal: true }), fakeHandle())
    assert.deepEqual(calls.removed, [])
  })

  it('keeps the original when the upload hook fails, and passes the md5 only when referenced', async () => {
    const { job, video } = await setup()
    const out = await write(`${video}.0.mp4`)
    const calls = newCalls()
    const failing = fakeDeps({ 'v.mp4': 1000, 'v.mp4.0.mp4': 1000 }, calls, {
      runHook: async (_t, context) => {
        calls.hooks.push({ context })
        return 'failed'
      }
    })
    const upload = parseCommandTemplate('uploader --md5 {md5} {outputs}')
    const result = await postJob(failing, job, [out], makeConfig({ deleteOriginal: true, upload }), fakeHandle())
    assert.deepEqual(calls.removed, [])
    assert.deepEqual(result, [out])
    assert.equal(calls.hooks[0]?.context.md5, 'abc123')
    assert.equal(calls.hooks[0]?.context.file, video)
    assert.deepEqual(calls.hooks[0]?.context.outputs, [out])

    const calls2 = newCalls()
    await postJob(fakeDeps({}, calls2), job, [out], makeConfig({ upload: parseCommandTemplate('uploader {file}') }), fakeHandle())
    assert.equal(calls2.hooks[0]?.context.md5, undefined)
  })

  it('a trash failure keeps the original, warns, and does not rename', async () => {
    const { job, video } = await setup()
    const out = await write(`${video}.0.mp4`)
    const calls = newCalls()
    const deps = fakeDeps({ 'v.mp4': 1000, 'v.mp4.0.mp4': 1000 }, calls, {
      remove: async (file, mode) => {
        calls.removed.push(`${mode}:${path.basename(file)}`)
        throw new Error('trash unavailable')
      }
    })
    const handle = fakeHandle()
    const result = await postJob(deps, job, [out], makeConfig({ deleteOriginal: true, deleteMode: 'trash' }), handle)
    assert.deepEqual(calls.removed, ['trash:v.mp4'])
    assert.deepEqual(result, [out])
    assert.ok(await exists(video))
    assert.ok(handle.logs.some((l) => l.level === 'warn' && /trash unavailable/.test(l.line)))
  })

  it('never does anything in a dry run', async () => {
    const { job, video } = await setup()
    const calls = newCalls()
    const out = `${video}.0.mp4`
    const result = await postJob(
      fakeDeps({}, calls),
      job,
      [out],
      makeConfig({ dryRun: true, deleteOriginal: true, upload: parseCommandTemplate('u {file}') }),
      fakeHandle()
    )
    assert.deepEqual(result, [out])
    assert.deepEqual(calls.removed, [])
    assert.deepEqual(calls.hooks, [])
  })

  it('does not rename when several outputs exist', async () => {
    const { job, video } = await setup([[0, 1000], [2000, 3000]])
    const a = await write(`${video}.0.mp4`)
    const b = await write(`${video}.1.mp4`)
    const calls = newCalls()
    const result = await postJob(
      fakeDeps({ 'v.mp4': 10_000, 'v.mp4.0.mp4': 1000, 'v.mp4.1.mp4': 1000 }, calls),
      job,
      [a, b],
      makeConfig({ deleteOriginal: true }),
      fakeHandle()
    )
    assert.deepEqual(result, [a, b])
    assert.equal(calls.removed.length, 2)
  })
})

describe('runUploadAll', () => {
  it('runs the hook once with every output; empty list is skipped', async () => {
    const calls = newCalls()
    const template = parseCommandTemplate('sync {outputs}')
    const outcome = await runUploadAll(fakeDeps({}, calls), template, ['/a/x.mp4', '/a/y.mp4'], () => undefined)
    assert.equal(outcome, 'ok')
    assert.deepEqual(calls.hooks[0]?.context.outputs, ['/a/x.mp4', '/a/y.mp4'])
    assert.equal(calls.hooks[0]?.context.dir, path.dirname('/a/x.mp4'))
    assert.equal(await runUploadAll(fakeDeps({}, calls), template, [], () => undefined), 'skipped')
  })
})
