import assert from 'node:assert/strict'
import { access, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { scanInputs } from '../../src/jobs/scan.js'
import type { StateLedger } from '../../src/jobs/state.js'
import { jobJson, makeConfig, makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const p = (...parts: string[]): string => path.join(tmp.dir, ...parts)
const names = (jobs: { videoPath: string }[]): string[] => jobs.map((j) => path.relative(tmp.dir, j.videoPath))
const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)

describe('scanInputs: folders', () => {
  it('auto: JSON job + whole-video job, derived outputs excluded, sorted with ids 1..N', async () => {
    const b = await write(p('b.mp4'))
    await write(p('a.mp4'))
    await write(p('a.mp4.0.mp4'))
    await write(p('b.mp4.mp4'))
    await write(p('b.mp4.copy.mp4'))
    await write(p('notes.txt'))
    await write(`${b}.json`, jobJson(b, [[0, 1000]]))
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], existing: 'rename' }))
    assert.deepEqual(names(r.jobs), ['a.mp4', 'b.mp4'])
    assert.deepEqual(r.jobs.map((j) => j.id), [1, 2])
    assert.equal(r.jobs[0]?.jsonPath, null)
    assert.equal(r.jobs[1]?.jsonPath, `${b}.json`)
    assert.deepEqual(r.jobs[0]?.expectedOutputs, [`${p('a.mp4')}.0.mp4`])
    assert.deepEqual(r.counts, { videos: 2, withJson: 1, wholeVideo: 1, alreadyDone: 0, invalid: 0 })
    assert.equal(r.skipped.length, 0)
  })

  it('is not recursive unless asked, and skips dot folders and ruimFolder', async () => {
    await write(p('top.mp4'))
    await write(p('sub', 'deep.mp4'))
    await write(p('.hidden', 'x.mp4'))
    await write(p('ruimFolder', 'y.mp4'))
    const flat = await scanInputs(makeConfig({ inputs: [tmp.dir] }))
    assert.deepEqual(names(flat.jobs), ['top.mp4'])
    const deep = await scanInputs(makeConfig({ inputs: [tmp.dir], recursive: true }))
    assert.deepEqual(names(deep.jobs), ['sub' + path.sep + 'deep.mp4', 'top.mp4'])
  })

  it('json mode: only job files; videos without JSON are not jobs; non-job .json ignored', async () => {
    const a = await write(p('a.mp4'))
    await write(p('free.mp4'))
    await write(`${a}.json`, jobJson(a, [[0, 1000]]))
    await write(p('package.json'), '{}')
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], source: 'json' }))
    assert.deepEqual(names(r.jobs), ['a.mp4'])
    assert.equal(r.skipped.length, 0)
  })

  it('force mode ignores JSON and applies job defaults', async () => {
    const a = await write(p('a.mp4'))
    await write(`${a}.json`, jobJson(a, [[0, 1000]]))
    const r = await scanInputs(
      makeConfig({
        inputs: [tmp.dir],
        source: 'force',
        jobDefaults: { size: '320x240', rate: 300, crop: null, bright: null, contrast: null, transpose: null, convert: false }
      })
    )
    assert.equal(r.jobs.length, 1)
    assert.equal(r.jobs[0]?.jsonPath, null)
    assert.equal(r.jobs[0]?.job.size, '320x240')
    assert.equal(r.jobs[0]?.job.rate, 300)
    assert.deepEqual(r.jobs[0]?.job.times, [])
  })

  it('custom extensions decide what a video is', async () => {
    await write(p('a.mp4'))
    await write(p('b.xyz'))
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], extensions: ['.xyz'] }))
    assert.deepEqual(names(r.jobs), ['b.xyz'])
  })
})

describe('scanInputs: job file problems', () => {
  it('reports orphan, empty and invalid JSON without moving them by default', async () => {
    await write(p('gone.mp4.json'), jobJson(p('gone.mp4'), [[0, 1000]]))
    const e = await write(p('e.mp4'))
    await write(`${e}.json`, '')
    const bad = await write(p('bad.mp4'))
    await write(`${bad}.json`, '{ nope')
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir] }))
    assert.equal(r.jobs.length, 0)
    assert.equal(r.skipped.length, 3)
    assert.ok(r.skipped.every((s) => s.movedTo === null))
    assert.equal(r.counts.invalid, 3)
    assert.ok(r.skipped.some((s) => /missing/i.test(s.reason)))
    assert.ok(r.skipped.some((s) => /empty/i.test(s.reason)))
    assert.ok(r.skipped.some((s) => /invalid/i.test(s.reason)))
    assert.ok(await exists(p('gone.mp4.json')))
  })

  it('moveOrphans moves orphan/empty JSON to ruimFolder, never invalid ones, never in dry-run/list-only', async () => {
    await write(p('gone.mp4.json'), jobJson(p('gone.mp4'), [[0, 1000]]))
    const e = await write(p('e.mp4'))
    await write(`${e}.json`, '')
    const bad = await write(p('bad.mp4'))
    await write(`${bad}.json`, '{ nope')
    const dry = await scanInputs(makeConfig({ inputs: [tmp.dir], moveOrphans: true, dryRun: true }))
    assert.ok(dry.skipped.every((s) => s.movedTo === null))
    const listed = await scanInputs(makeConfig({ inputs: [tmp.dir], moveOrphans: true, listOnly: true }))
    assert.ok(listed.skipped.every((s) => s.movedTo === null))
    assert.ok(await exists(p('gone.mp4.json')))

    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], moveOrphans: true }))
    const moved = r.skipped.filter((s) => s.movedTo !== null)
    assert.equal(moved.length, 2)
    assert.ok(!(await exists(p('gone.mp4.json'))))
    assert.ok(await exists(`${bad}.json`))
    assert.deepEqual((await readdir(p('ruimFolder'))).sort(), ['e.mp4.json', 'gone.mp4.json'])
  })

  it('never replaces a file already in ruimFolder', async () => {
    await write(p('ruimFolder', 'gone.mp4.json'), 'old')
    await write(p('gone.mp4.json'), jobJson(p('gone.mp4'), [[0, 1000]]))
    await scanInputs(makeConfig({ inputs: [tmp.dir], moveOrphans: true }))
    const files = (await readdir(p('ruimFolder'))).sort()
    assert.equal(files.length, 2)
    assert.ok(files.includes('gone.mp4.json'))
  })
})

describe('scanInputs: explicit inputs', () => {
  it('missing input is skipped, never thrown; non-video is skipped', async () => {
    const txt = await write(p('a.txt'))
    const r = await scanInputs(makeConfig({ inputs: [p('nope'), txt] }))
    assert.equal(r.jobs.length, 0)
    assert.ok(r.skipped.some((s) => s.reason.startsWith('Not found')))
    assert.ok(r.skipped.some((s) => s.reason === 'Not a video file'))
    assert.equal(r.counts.invalid, 1)
  })

  it('auto: sidecar if present, whole otherwise; json mode requires the sidecar', async () => {
    const a = await write(p('a.mp4'))
    const b = await write(p('b.mp4'))
    await write(`${a}.json`, jobJson(a, [[0, 1000]]))
    const auto = await scanInputs(makeConfig({ inputs: [b, a] }))
    assert.deepEqual(names(auto.jobs), ['a.mp4', 'b.mp4'])
    assert.notEqual(auto.jobs[0]?.jsonPath, null)
    assert.equal(auto.jobs[1]?.jsonPath, null)
    const json = await scanInputs(makeConfig({ inputs: [a, b], source: 'json' }))
    assert.deepEqual(names(json.jobs), ['a.mp4'])
    assert.equal(json.skipped[0]?.reason, 'No job file for this video (cut it first or process it whole)')
  })

  it('an explicit .json input is classified; a video and its json are one job', async () => {
    const a = await write(p('a.mp4'))
    const j = await write(`${a}.json`, jobJson(a, [[0, 1000], [2000, 3000]], 2))
    const r = await scanInputs(makeConfig({ inputs: [j, a, a] }))
    assert.equal(r.jobs.length, 1)
    assert.equal(r.jobs[0]?.job.times.length, 2)
    assert.deepEqual(r.jobs[0]?.expectedOutputs, [`${a}.mp4`])
  })

  it('de-duplicates folder + file inputs and keeps order sorted', async () => {
    const z = await write(p('z.mp4'))
    await write(p('m.mp4'))
    const r = await scanInputs(makeConfig({ inputs: [z, tmp.dir, tmp.dir] }))
    assert.deepEqual(names(r.jobs), ['m.mp4', 'z.mp4'])
    assert.deepEqual(r.jobs.map((j) => j.id), [1, 2])
  })

  it('root of a CUSTOM subfolder video is its parent', async () => {
    const v = await write(p('session', 'CUSTOM', 'v.mp4'))
    const r = await scanInputs(makeConfig({ inputs: [v] }))
    assert.equal(r.jobs[0]?.root, p('session'))
  })
})

describe('scanInputs: already done', () => {
  it('existing=skip skips jobs whose outputs exist and are big enough', async () => {
    await write(p('a.mp4'))
    await write(p('a.mp4.0.mp4'), 'x'.repeat(5000))
    await write(p('b.mp4'))
    await write(p('b.mp4.0.mp4'), 'tiny')
    const skip = await scanInputs(makeConfig({ inputs: [tmp.dir], existing: 'skip' }))
    assert.deepEqual(names(skip.jobs), ['b.mp4'])
    assert.equal(skip.counts.alreadyDone, 1)
    assert.equal(skip.skipped[0]?.reason, 'outputs already exist')
    const rename = await scanInputs(makeConfig({ inputs: [tmp.dir], existing: 'rename' }))
    assert.equal(rename.jobs.length, 2)
  })

  it('the state ledger skips recorded videos', async () => {
    const a = await write(p('a.mp4'))
    await write(p('b.mp4'))
    const ledger: StateLedger = {
      size: 1,
      isDone: (target) => target === a,
      recordDone: async () => undefined,
      recordFailed: async () => undefined,
      close: async () => undefined
    }
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], existing: 'rename' }), { ledger })
    assert.deepEqual(names(r.jobs), ['b.mp4'])
    assert.equal(r.skipped[0]?.reason, 'already converted (state file; use --no-state to convert it again)')
    assert.equal(r.counts.alreadyDone, 1)
  })

  it('invalid JSON does not block the other videos', async () => {
    const a = await write(p('a.mp4'))
    await writeFile(`${a}.json`, '[1,2,3]')
    await write(p('b.mp4'))
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir] }))
    assert.deepEqual(names(r.jobs), ['b.mp4'])
    assert.equal(r.counts.invalid, 1)
  })
})

describe('scanInputs: safety', () => {
  it('never recurses into system folders (trashed originals must not be converted again)', async () => {
    await write(p('keep', 'a.mp4'))
    const system = process.platform === 'win32' ? ['$RECYCLE.BIN', 'System Volume Information'] : ['lost+found']
    for (const dir of system) await write(p(dir, 'S-1-5', 'trashed.mp4'))
    if (process.platform === 'win32') await write(p('$recycle.bin2', 'x.mp4'))
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], recursive: true }))
    const found = names(r.jobs)
    assert.ok(found.includes(path.join('keep', 'a.mp4')))
    assert.ok(found.every((n) => !/trashed/.test(n)), found.join(', '))
  })

  it('an explicit .json that is not a <video>.json job file is skipped and never moved', async () => {
    const pkg = await write(p('package.json'), '{}')
    const empty = await write(p('settings.json'), '')
    const derived = await write(p('a.mp4.0.mp4.json'), '')
    const r = await scanInputs(makeConfig({ inputs: [pkg, empty, derived], moveOrphans: true }))
    assert.equal(r.jobs.length, 0)
    assert.equal(r.skipped.length, 3)
    assert.ok(r.skipped.every((s) => s.reason === 'Not a job file' && s.movedTo === null))
    assert.ok(await exists(pkg))
    assert.ok(await exists(empty))
    assert.ok(await exists(derived))
    assert.equal(r.counts.invalid, 0)
  })

  it('an explicit orphan <video>.json is still reported and moved with moveOrphans', async () => {
    const orphan = await write(p('gone.mp4.json'), jobJson(p('gone.mp4'), [[0, 1000]]))
    const r = await scanInputs(makeConfig({ inputs: [orphan], moveOrphans: true }))
    assert.equal(r.skipped[0]?.reason, 'The video of this job file is missing')
    assert.notEqual(r.skipped[0]?.movedTo, null)
    assert.ok(!(await exists(orphan)))
  })

  it('an aborted scan returns no jobs and moves nothing', async () => {
    await write(p('gone.mp4.json'), jobJson(p('gone.mp4'), [[0, 1000]]))
    for (let i = 0; i < 20; i += 1) await write(p(`d${i}`, 'v.mp4'))
    const controller = new AbortController()
    controller.abort()
    const r = await scanInputs(makeConfig({ inputs: [tmp.dir], recursive: true, moveOrphans: true }), {
      signal: controller.signal
    })
    assert.equal(r.jobs.length, 0)
    assert.ok(r.skipped.every((s) => s.movedTo === null))
    assert.ok(await exists(p('gone.mp4.json')))
  })

  it('aborting in the middle stops walking and yields no jobs', async () => {
    for (let i = 0; i < 40; i += 1) await write(p(`d${i}`, 'v.mp4'))
    const controller = new AbortController()
    const scanning = scanInputs(makeConfig({ inputs: [tmp.dir], recursive: true }), { signal: controller.signal })
    controller.abort()
    const r = await scanning
    assert.equal(r.jobs.length, 0)
  })
})
