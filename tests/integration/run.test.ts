/** Scenarios 3 (parallelism), 5 (--existing on a second run) and 6 (failures). */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CPU,
  DEFAULT_LEDGER,
  assertCountersConsistent,
  base,
  clip,
  exists,
  makeTmp,
  maxProcessing,
  names,
  near,
  ofType,
  probe,
  put,
  runJson,
  scanOf,
  SKIP,
  summaryOf,
  type Tmp
} from './helpers.js'

let tmp: Tmp
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

/** 10 clips: several sizes, a video-only one, an .mkv, names with spaces and non-ASCII. */
async function tenClips(dir: string): Promise<string[]> {
  const specs: [string, Parameters<typeof clip>[1]][] = [
    ['a.mp4', { w: 640, h: 360 }],
    ['b.mp4', { w: 320, h: 240 }],
    ['c.mp4', { w: 480, h: 270 }],
    ['ação 1.mp4', { w: 320, h: 240 }],
    ['with space.mp4', { w: 640, h: 360 }],
    ['video only.mp4', { w: 320, h: 240, audio: false }],
    ['m.mkv', { w: 480, h: 270, container: 'mkv' }],
    ['big.mp4', { w: 1280, h: 720 }],
    ['日本.mp4', { w: 320, h: 240 }],
    ['z.mp4', { w: 320, h: 240, seconds: 3 }]
  ]
  return Promise.all(specs.map(([n, s]) => clip(path.join(dir, n), s)))
}

describe('parallel processing', { skip: SKIP }, () => {
  it('-j 3 on 10 clips never runs more than 3 at once and every clip is converted', async () => {
    const sources = await tenClips(tmp.dir)
    const r = await runJson(['-j', '3', ...CPU, tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(maxProcessing(r.events), 3)
    const final = assertCountersConsistent(r.events)
    assert.deepEqual(final, { total: 10, queued: 0, processing: 0, done: 10, failed: 0, cancelled: 0, skipped: 0 })
    // Concurrency from the started/done stream too.
    let running = 0
    let peak = 0
    for (const e of r.events) {
      if (e.type === 'started') peak = Math.max(peak, ++running)
      if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') running--
    }
    assert.equal(peak, 3)
    for (const src of sources) {
      const out = await probe(`${src}.0.mp4`)
      assert.ok(Math.max(out.width, out.height) <= 640, `${path.basename(src)} -> ${out.width}x${out.height}`)
      assert.equal(out.videoCodec, 'h264')
    }
    assert.equal((await probe(path.join(tmp.dir, 'video only.mp4.0.mp4'))).hasAudio, false)
    assert.equal((await probe(path.join(tmp.dir, 'a.mp4.0.mp4'))).hasAudio, true)
    assert.equal(summaryOf(r.events).outputs.length, 10)
  })

  it('-j 1 runs one job at a time', async () => {
    for (const n of ['a.mp4', 'b.mp4', 'c.mp4']) await clip(path.join(tmp.dir, n))
    const r = await runJson(['-j', '1', ...CPU, tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(maxProcessing(r.events), 1)
    assert.equal(assertCountersConsistent(r.events).done, 3)
  })

  it('rejects -j 0 and -j 33 with a usage error', async () => {
    await clip(path.join(tmp.dir, 'a.mp4'))
    for (const j of ['0', '33', 'x']) {
      const r = await runJson(['-j', j, tmp.dir])
      assert.equal(r.code, 2, `-j ${j}`)
      assert.match(r.stderr, /--parallel/)
    }
  })
})

describe('whole-video settings reach ffmpeg', { skip: SKIP }, () => {
  const cases: [string, string[], Parameters<typeof clip>[1], [number, number]][] = [
    ['--size 320x180', ['--size', '320x180'], { w: 640, h: 360 }, [320, 180]],
    ['--crop 0:0:320:240', ['--crop', '0:0:320:240'], { w: 640, h: 360 }, [320, 240]],
    ['--transpose 90', ['--transpose', '90'], { w: 640, h: 360 }, [360, 640]],
    ['--same-size', ['--same-size'], { w: 1280, h: 720 }, [1280, 720]],
    ['--max-side 320', ['--max-side', '320'], { w: 640, h: 360 }, [320, 180]],
    ['--convert-first', ['--convert-first'], { w: 640, h: 360 }, [640, 360]],
    ['--bright -0.5 --contrast 2 (negative number after a flag)', ['--bright', '-0.5', '--contrast', '2'], { w: 320, h: 240 }, [320, 240]]
  ]
  for (const [title, flags, spec, [w, h]] of cases) {
    it(title, async () => {
      const v = await clip(path.join(tmp.dir, 'v.mp4'), spec)
      const r = await runJson([...flags, ...CPU, v])
      assert.equal(r.code, 0, r.stderr)
      const out = await probe(`${v}.0.mp4`)
      assert.deepEqual([out.width, out.height], [w, h])
      assert.deepEqual(await names(tmp.dir), ['v.mp4', 'v.mp4.0.mp4'], 'no temp file (.converted/.part) is left')
    })
  }

  it('--rate, --max-rate, --verbose-ffmpeg, --hwaccel cuda and --encoders show up in the ffmpeg argv (dry run)', async () => {
    const v = await clip(path.join(tmp.dir, 'v.mp4'))
    const r = await runJson(['--dry-run', '--rate', '123', '--verbose-ffmpeg', '--hwaccel', 'cuda', '--encoders', 'libx264', v])
    const cmd = ofType(r.events, 'log').map((e) => e.line).find((l) => l.startsWith('$ ffmpeg ')) ?? ''
    assert.match(cmd, /-b:v 123k/)
    assert.match(cmd, /-hwaccel cuda/)
    assert.match(cmd, /-c:v libx264/)
    assert.doesNotMatch(cmd, /-loglevel error/)
    const capped = await runJson(['--dry-run', '--max-rate', '50', ...CPU, v])
    const cmd2 = ofType(capped.events, 'log').map((e) => e.line).find((l) => l.startsWith('$ ffmpeg ')) ?? ''
    assert.match(cmd2, /-maxrate 50k/)
    assert.doesNotMatch(cmd2, /-hwaccel/)
  })
})

describe('--existing on a second run without a state file (--no-state)', { skip: SKIP }, () => {
  const NO_STATE = ['--no-state', ...CPU]
  let src: string
  beforeEach(async () => {
    src = await clip(path.join(tmp.dir, 'x.mp4'))
    const first = await runJson([...NO_STATE, src])
    assert.equal(first.code, 0, first.stderr)
    assert.ok(await exists(`${src}.0.mp4`))
  })

  it('skip (default): the video is skipped with "outputs already exist"', async () => {
    const r = await runJson([...NO_STATE, tmp.dir])
    assert.equal(r.code, 0)
    const scan = scanOf(r.events)
    assert.equal(scan.jobs.length, 0)
    assert.equal(scan.counts.alreadyDone, 1)
    assert.match(scan.skipped[0]?.reason ?? '', /outputs already exist/)
    assert.deepEqual(await names(tmp.dir), ['x.mp4', 'x.mp4.0.mp4'])
  })

  it('rename: the new output takes "x.mp4.0 (1).mp4"', async () => {
    const r = await runJson(['--existing', 'rename', ...NO_STATE, tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(base(ofType(r.events, 'done')[0]?.outputs ?? []), ['x.mp4.0 (1).mp4'])
    assert.deepEqual(await names(tmp.dir), ['x.mp4', 'x.mp4.0 (1).mp4', 'x.mp4.0.mp4'])
  })

  it('rename: the "x.mp4.0 (1).mp4" output of a rename run is not a source on the next run', async () => {
    await runJson(['--existing', 'rename', ...NO_STATE, tmp.dir])
    const r = await runJson(['--list', '--existing', 'rename', ...NO_STATE, tmp.dir])
    assert.deepEqual(base(scanOf(r.events).jobs.map((j) => j.videoPath)), ['x.mp4'])
  })

  it('replace: the old output is replaced, nothing is duplicated', async () => {
    const out = `${src}.0.mp4`
    const garbage = randomBytes(5000)
    await writeFile(out, garbage)
    const r = await runJson(['--existing', 'replace', '--delete-mode', 'permanent', ...NO_STATE, tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(await names(tmp.dir), ['x.mp4', 'x.mp4.0.mp4'])
    assert.notDeepEqual(await readFile(out), garbage)
    assert.ok(near((await probe(out)).durationMs, 2000))
    assert.deepEqual(base(ofType(r.events, 'done')[0]?.outputs ?? []), ['x.mp4.0.mp4'])
  })

  it('skip treats an output below --min-output-bytes as missing and converts again', async () => {
    await writeFile(`${src}.0.mp4`, 'tiny')
    const r = await runJson([...NO_STATE, tmp.dir])
    assert.equal(scanOf(r.events).jobs.length, 1)
    assert.equal(summaryOf(r.events).counters.done, 1)
  })
})

describe('the default per-user ledger', { skip: SKIP }, () => {
  it('is written to the per-user location and skips done videos even with --existing rename', async () => {
    const v = await clip(path.join(tmp.dir, 'led.mp4'))
    const first = await runJson([...CPU, v])
    assert.equal(first.code, 0, first.stderr)
    assert.match(await readFile(DEFAULT_LEDGER, 'utf8'), /led\.mp4/)
    const again = await runJson(['--existing', 'rename', ...CPU, v])
    const scan = scanOf(again.events)
    assert.equal(scan.jobs.length, 0)
    assert.match(scan.skipped[0]?.reason ?? '', /state file/)
    const forced = await runJson(['--existing', 'rename', '--no-state', ...CPU, v])
    assert.equal(summaryOf(forced.events).counters.done, 1)
    assert.deepEqual(await names(tmp.dir), ['led.mp4', 'led.mp4.0 (1).mp4', 'led.mp4.0.mp4'])
  })
})

describe('failures', { skip: SKIP }, () => {
  async function badAndGood(): Promise<void> {
    await put(path.join(tmp.dir, 'bad.mp4'), randomBytes(50_000))
    await clip(path.join(tmp.dir, 'good1.mp4'))
    await clip(path.join(tmp.dir, 'good2.mp4'), { w: 640, h: 360 })
  }

  it('a corrupt bad.mp4 fails with exit code 1 while the other jobs succeed', async () => {
    await badAndGood()
    const r = await runJson(['-j', '2', ...CPU, tmp.dir])
    assert.equal(r.code, 1)
    const final = assertCountersConsistent(r.events)
    assert.deepEqual([final.done, final.failed], [2, 1])
    const err = ofType(r.events, 'error')
    assert.equal(err.length, 1)
    assert.ok(await exists(path.join(tmp.dir, 'good1.mp4.0.mp4')))
    assert.ok(await exists(path.join(tmp.dir, 'good2.mp4.0.mp4')))
    assert.ok(!(await exists(path.join(tmp.dir, 'bad.mp4.0.mp4'))))
    assert.ok((await names(tmp.dir)).every((n) => !n.includes('.part.')))
    assert.equal(summaryOf(r.events).failures.length, 1)
  })

  it(
    'a corrupt bad.mp4 gets a bad.mp4.log next to it',
    { todo: 'BUG: a video that ffprobe cannot read fails without writing <video>.log (executor.ts probe path)' },
    async () => {
      await badAndGood()
      const r = await runJson([...CPU, tmp.dir])
      assert.equal(r.code, 1)
      assert.ok(await exists(path.join(tmp.dir, 'bad.mp4.log')), 'bad.mp4.log missing')
      assert.equal(ofType(r.events, 'error')[0]?.logPath, path.join(tmp.dir, 'bad.mp4.log'))
    }
  )

  it('an ffmpeg failure writes <video>.log; --no-failure-log does not', async () => {
    // A range that starts after the end of a 2 s clip: ffmpeg writes (almost) nothing.
    const v = await clip(path.join(tmp.dir, 'late.mp4'))
    await put(`${v}.json`, JSON.stringify({ times: [[5000, 8000]], posExecution: 1 }))
    const r = await runJson([...CPU, v])
    assert.equal(r.code, 1)
    const log = `${v}.log`
    assert.ok(await exists(log), 'late.mp4.log missing')
    assert.equal(ofType(r.events, 'error')[0]?.logPath, log)
    assert.match(await readFile(log, 'utf8'), /--- last ffmpeg output ---/)
    assert.ok((await names(tmp.dir)).every((n) => !n.includes('.part.')))

    await writeFile(log, '')
    const again = await runJson(['--no-failure-log', ...CPU, v])
    assert.equal(again.code, 1)
    assert.equal((await stat(log)).size, 0, '--no-failure-log must not (re)write the log')
  })

  it('job ranges beyond the duration (the real legacy sample on a 2 s clip) do not crash the run', async () => {
    const legacy = await clip(path.join(tmp.dir, 'legacy.mp4'))
    await put(
      `${legacy}.json`,
      JSON.stringify({ filename: 'CUSTOM/20250124_211732.mp4', times: [[18054, 46182], [18054, 45735]], posExecution: 1 })
    )
    const partial = await clip(path.join(tmp.dir, 'partial.mp4'))
    await put(`${partial}.json`, JSON.stringify({ times: [[1000, 99000]], posExecution: 1 }))
    await clip(path.join(tmp.dir, 'plain.mp4'))
    const r = await runJson([...CPU, tmp.dir])
    assert.equal(r.code, 1)
    const final = assertCountersConsistent(r.events)
    assert.deepEqual([final.done, final.failed], [2, 1])
    assert.ok(near((await probe(`${partial}.0.mp4`)).durationMs, 1000), 'the part inside the clip is kept')
    assert.ok(await exists(path.join(tmp.dir, 'plain.mp4.0.mp4')))
    assert.match(r.stderr, /^$/, `nothing on stderr in --json mode: ${r.stderr}`)
  })
})
