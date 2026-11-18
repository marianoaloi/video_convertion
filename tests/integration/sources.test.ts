/** Scenario 2: --source auto|json|force, legacy job formats, orphans, concat with/without --keep-parts. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CPU,
  base,
  clip,
  exists,
  makeTmp,
  near,
  ofType,
  probe,
  put,
  runJson,
  scanOf,
  SKIP,
  summaryOf,
  tree,
  assertCountersConsistent,
  type Tmp
} from './helpers.js'

/** The app's real legacy sample (current format, no version), with times that fit a 2 s clip. */
function legacyJob(times: [number, number][]): string {
  return JSON.stringify({
    filename: 'CUSTOM/20250124_211732.mp4',
    originalPath: '/home/maloi/Videos/img/20250124_211732.mp4',
    crop: null,
    bright: null,
    contrast: null,
    transpose: null,
    mediaPath: null,
    convert: false,
    size: null,
    rate: null,
    avgrate: null,
    times,
    posExecution: 1
  })
}

/** The app's old format: `{st, du}` pairs (sorted into [min, max]) and `posExecution: 'f'` = concat. */
const OLD_FORMAT = JSON.stringify({
  definedSize: '320x180',
  definedRate: '300',
  times: [
    { st: 0, du: 1000 },
    { st: 1500, du: 500 }
  ],
  posExecution: 'f'
})

function v2Concat(file: string): string {
  return JSON.stringify({
    filename: file,
    originalPath: file,
    crop: null,
    bright: null,
    contrast: null,
    transpose: null,
    mediaPath: null,
    convert: false,
    size: null,
    rate: null,
    avgrate: null,
    times: [
      [0, 800],
      [1000, 1800]
    ],
    posExecution: 2,
    version: 2
  })
}

async function sourcesTree(root: string): Promise<void> {
  for (const n of ['legacy.mp4', 'old.mp4', 'v2cat.mp4', 'whole.mp4', 'empty.mp4', 'inv.mp4']) await clip(path.join(root, n))
  await put(path.join(root, 'legacy.mp4.json'), legacyJob([[0, 1000], [500, 1500]]))
  await put(path.join(root, 'old.mp4.json'), OLD_FORMAT)
  await put(path.join(root, 'v2cat.mp4.json'), v2Concat(path.join(root, 'v2cat.mp4')))
  await put(path.join(root, 'orphan.mp4.json'), legacyJob([[0, 1000]]))
  await put(path.join(root, 'empty.mp4.json'), '')
  await put(path.join(root, 'inv.mp4.json'), '{not json')
  // A file already sitting in ruimFolder must never be replaced by a moved job file.
  await put(path.join(root, 'ruimFolder', 'orphan.mp4.json'), 'keep me')
}

const reasonOf = (scan: ReturnType<typeof scanOf>, name: string): string =>
  scan.skipped.find((s) => path.basename(s.path) === name)?.reason ?? '(not skipped)'

describe('source modes', { skip: SKIP }, () => {
  let tmp: Tmp
  beforeEach(async () => {
    tmp = await makeTmp()
    await sourcesTree(tmp.dir)
  })
  afterEach(() => tmp.cleanup())

  it('--source auto (default) uses job files when present, else converts whole; bad job files are reported', async () => {
    const r = await runJson(['--list', tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    const scan = scanOf(r.events)
    assert.deepEqual(base(scan.jobs.map((j) => j.videoPath)), ['legacy.mp4', 'old.mp4', 'v2cat.mp4', 'whole.mp4'])
    assert.equal(scan.counts.withJson, 3)
    assert.equal(scan.counts.wholeVideo, 1)
    assert.equal(scan.counts.invalid, 3)
    assert.deepEqual(base(scan.skipped.map((s) => s.path)), ['empty.mp4.json', 'inv.mp4.json', 'orphan.mp4.json'])
    assert.match(reasonOf(scan, 'orphan.mp4.json'), /video of this job file is missing/)
    assert.match(reasonOf(scan, 'empty.mp4.json'), /empty/)
    assert.match(reasonOf(scan, 'inv.mp4.json'), /Invalid job file/)
    const legacy = scan.jobs.find((j) => j.videoPath.endsWith('legacy.mp4'))
    assert.deepEqual(legacy?.job.times, [[0, 1000], [500, 1500]])
    assert.equal(legacy?.job.filename, path.join(tmp.dir, 'legacy.mp4'), 'the legacy relative filename is replaced by the real path')
    const old = scan.jobs.find((j) => j.videoPath.endsWith('old.mp4'))
    assert.equal(old?.job.posExecution, 2)
    assert.deepEqual(old?.job.times, [[0, 1000], [500, 1500]])
    assert.equal(old?.job.size, '320x180')
    assert.equal(old?.job.rate, 300)
  })

  it('--source json lists only videos with job files; a folder video without one is silently left out', async () => {
    const r = await runJson(['--list', '--source', 'json', tmp.dir])
    const scan = scanOf(r.events)
    assert.deepEqual(base(scan.jobs.map((j) => j.videoPath)), ['legacy.mp4', 'old.mp4', 'v2cat.mp4'])
    assert.equal(reasonOf(scan, 'whole.mp4'), '(not skipped)')
    assert.equal(scan.counts.invalid, 3)
    // Given explicitly, the same video is reported.
    const explicit = await runJson(['--list', '--source', 'json', path.join(tmp.dir, 'whole.mp4')])
    assert.match(reasonOf(scanOf(explicit.events), 'whole.mp4'), /No job file/)
  })

  it('--force (= --source force) converts every video whole and ignores job files', async () => {
    for (const flags of [['--force'], ['--source', 'force']]) {
      const r = await runJson(['--list', ...flags, tmp.dir])
      const scan = scanOf(r.events)
      assert.deepEqual(base(scan.jobs.map((j) => j.videoPath)), ['empty.mp4', 'inv.mp4', 'legacy.mp4', 'old.mp4', 'v2cat.mp4', 'whole.mp4'])
      assert.ok(scan.jobs.every((j) => j.jsonPath === null && j.job.times.length === 0))
      assert.deepEqual(scan.skipped, [])
    }
    const clash = await runJson(['--list', '--force', '--source', 'json', tmp.dir])
    assert.equal(clash.code, 2)
  })

  it('--source json --move-orphans converts legacy/old/v2 jobs and moves orphan+empty job files aside', async () => {
    const r = await runJson(['--source', 'json', '--move-orphans', ...CPU, tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    const final = assertCountersConsistent(r.events)
    assert.deepEqual(final, { total: 3, queued: 0, processing: 0, done: 3, failed: 0, cancelled: 0, skipped: 3 })

    // legacy (cut, two ranges): one output per range
    assert.ok(near((await probe(path.join(tmp.dir, 'legacy.mp4.0.mp4'))).durationMs, 1000))
    assert.ok(near((await probe(path.join(tmp.dir, 'legacy.mp4.1.mp4'))).durationMs, 1000))
    // old format (concat): one joined output at the old definedSize; parts removed
    const old = await probe(path.join(tmp.dir, 'old.mp4.mp4'))
    assert.ok(near(old.durationMs, 2000), `old.mp4.mp4 lasts ${old.durationMs}`)
    assert.deepEqual([old.width, old.height], [320, 180])
    // v2 concat: 800 + 800 ms
    assert.ok(near((await probe(path.join(tmp.dir, 'v2cat.mp4.mp4'))).durationMs, 1600))

    const files = await tree(tmp.dir)
    for (const part of ['old.mp4.0.mp4', 'old.mp4.1.mp4', 'v2cat.mp4.0.mp4', 'v2cat.mp4.1.mp4']) {
      assert.ok(!files.includes(part), `concat part ${part} should be gone`)
    }
    assert.ok(!files.some((f) => f.includes('.part.')), `no .part file: ${files.join(', ')}`)
    assert.ok(!files.includes('whole.mp4.0.mp4'), 'json mode must not convert a video without a job file')

    // orphan + empty moved aside without replacing; invalid stays put
    assert.ok(!files.includes('orphan.mp4.json'))
    assert.ok(!files.includes('empty.mp4.json'))
    assert.ok(files.includes('inv.mp4.json'))
    assert.equal(await readFile(path.join(tmp.dir, 'ruimFolder', 'orphan.mp4.json'), 'utf8'), 'keep me')
    assert.ok(files.includes('ruimFolder/orphan.mp4 (1).json'), files.join(', '))
    assert.ok(files.includes('ruimFolder/empty.mp4.json'), files.join(', '))
    const moved = scanOf(r.events).skipped.filter((s) => s.movedTo !== null)
    assert.deepEqual(base(moved.map((s) => s.movedTo as string)), ['empty.mp4.json', 'orphan.mp4 (1).json'])
    // the job files of converted videos are left alone (no --delete-original)
    for (const n of ['legacy.mp4.json', 'old.mp4.json', 'v2cat.mp4.json']) assert.ok(files.includes(n))
  })

  it('--list and --dry-run never move orphans, even with --move-orphans', async () => {
    await runJson(['--list', '--move-orphans', tmp.dir])
    await runJson(['--dry-run', '--move-orphans', ...CPU, tmp.dir])
    assert.ok(await exists(path.join(tmp.dir, 'orphan.mp4.json')))
    assert.ok(await exists(path.join(tmp.dir, 'empty.mp4.json')))
  })

  it('a concat job with --keep-parts keeps the cut parts next to the joined output', async () => {
    const r = await runJson(['--keep-parts', ...CPU, path.join(tmp.dir, 'v2cat.mp4.json')])
    assert.equal(r.code, 0, r.stderr)
    const done = ofType(r.events, 'done')
    assert.deepEqual(base(done[0]?.outputs ?? []), ['v2cat.mp4.mp4'])
    for (const n of ['v2cat.mp4.mp4', 'v2cat.mp4.0.mp4', 'v2cat.mp4.1.mp4']) {
      assert.ok(await exists(path.join(tmp.dir, n)), `missing ${n}`)
    }
    assert.ok(near((await probe(path.join(tmp.dir, 'v2cat.mp4.0.mp4'))).durationMs, 800))
  })

  it('--force really converts the whole video and leaves its job file alone', async () => {
    const r = await runJson(['--force', ...CPU, path.join(tmp.dir, 'legacy.mp4')])
    assert.equal(r.code, 0, r.stderr)
    assert.ok(near((await probe(path.join(tmp.dir, 'legacy.mp4.0.mp4'))).durationMs, 2000))
    assert.ok(!(await exists(path.join(tmp.dir, 'legacy.mp4.1.mp4'))))
    assert.ok(await exists(path.join(tmp.dir, 'legacy.mp4.json')))
    assert.equal(summaryOf(r.events).counters.done, 1)
  })
})
