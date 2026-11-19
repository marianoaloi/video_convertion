/** Scenario 1 (counting, recursion, ignored names) and 11 (scale: 20,000 files). */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { CPU, base, makeTmp, put, runCli, runJson, scanOf, summaryOf, SKIP, type Tmp, HERE } from './helpers.js'

/**
 * root/
 *   a.mp4  b.mkv  "ação 1.mp4"  "with space.mp4"  old.mp4  UPPER.MP4      <- 6 sources
 *   old.mp4.0.mp4  old.mp4.mp4  old.mp4.0.part.mp4  old.mp4.part.mp4  old.mp4.copy.mp4 <- earlier outputs
 *   package.json  notes.txt  cover.jpg  readme.md                          <- not videos
 *   sub/c.mp4  sub/deeper/d.webm                                           <- 2 more with -r
 *   .hidden/e.mp4  ruimFolder/f.mp4  sub/ruimFolder/g.mp4  sub/.cache/h.mp4 <- never
 */
async function countingTree(root: string): Promise<void> {
  for (const n of ['a.mp4', 'b.mkv', 'ação 1.mp4', 'with space.mp4', 'old.mp4', 'UPPER.MP4']) await put(path.join(root, n))
  for (const n of ['old.mp4.0.mp4', 'old.mp4.mp4', 'old.mp4.0.part.mp4', 'old.mp4.part.mp4', 'old.mp4.copy.mp4']) await put(path.join(root, n))
  await put(path.join(root, 'package.json'), '{"name":"not-a-job"}')
  for (const n of ['notes.txt', 'cover.jpg', 'readme.md']) await put(path.join(root, n), 'x')
  await put(path.join(root, 'sub', 'c.mp4'))
  await put(path.join(root, 'sub', 'deeper', 'd.webm'))
  for (const n of ['.hidden/e.mp4', 'ruimFolder/f.mp4', 'sub/ruimFolder/g.mp4', 'sub/.cache/h.mp4']) await put(path.join(root, n))
}

const TOP = ['UPPER.MP4', 'a.mp4', 'ação 1.mp4', 'b.mkv', 'old.mp4', 'with space.mp4']
const DEEP = [...TOP, 'c.mp4', 'd.webm'].sort()

describe('counting the videos to process', () => {
  let tmp: Tmp
  before(async () => {
    tmp = await makeTmp()
    await countingTree(tmp.dir)
  })
  after(() => tmp.cleanup())

  it('--list --json without -r counts only the top folder and ignores earlier outputs and non-videos', async () => {
    const r = await runJson(['--list', tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    const scan = scanOf(r.events)
    assert.deepEqual(base(scan.jobs.map((j) => j.videoPath)), TOP)
    assert.equal(scan.counts.videos, 6)
    assert.equal(scan.counts.wholeVideo, 6)
    assert.equal(scan.counts.withJson, 0)
    assert.equal(scan.counts.invalid, 0)
    assert.deepEqual(scan.skipped, [], 'package.json, txt, jpg and earlier outputs are not even reported')
    const s = summaryOf(r.events)
    assert.equal(s.counters.total, 6)
    assert.equal(s.counters.done, 0)
  })

  it('--list --json -r descends, but skips dot-folders and every ruimFolder', async () => {
    const r = await runJson(['--list', '-r', tmp.dir])
    assert.equal(r.code, 0, r.stderr)
    const scan = scanOf(r.events)
    assert.deepEqual(base(scan.jobs.map((j) => j.videoPath)), DEEP)
    assert.equal(scan.counts.videos, 8)
    assert.equal(summaryOf(r.events).counters.total, 8)
    assert.ok(scan.jobs.every((j) => !/[\\/](\.hidden|ruimFolder|\.cache)[\\/]/.test(j.videoPath)))
  })

  it('--list (text) prints the headline with the same counts and writes nothing', async () => {
    const flat = await runCli(['--list', tmp.dir])
    assert.equal(flat.code, 0, flat.stderr)
    assert.match(flat.stdout, /Found 6 videos: 6 to process \(0 with job file, 6 whole video\), 0 skipped/)
    const deep = await runCli(['--list', '-r', tmp.dir])
    assert.match(deep.stdout, /Found 8 videos: 8 to process/)
    const verbose = await runCli(['--list', '-r', '--verbose', tmp.dir])
    for (const n of DEEP) assert.ok(verbose.stdout.includes(n), `--list --verbose should name ${n}`)
  })

  it('--ext narrows the extensions', async () => {
    const r = await runJson(['--list', '-r', '--ext', 'mkv,webm', tmp.dir])
    assert.deepEqual(base(scanOf(r.events).jobs.map((j) => j.videoPath)), ['b.mkv', 'd.webm'])
  })

  it('an explicit video file is listed; a missing input path is a usage error (exit 2) before any scan', async () => {
    const one = await runJson(['--list', path.join(tmp.dir, 'a.mp4')])
    assert.deepEqual(base(scanOf(one.events).jobs.map((j) => j.videoPath)), ['a.mp4'])
    const missing = path.join(tmp.dir, 'nope', 'gone.mp4')
    const r = await runCli(['--list', '--json', path.join(tmp.dir, 'a.mp4'), missing])
    assert.equal(r.code, 2)
    assert.ok(r.stderr.includes(missing), r.stderr)
    assert.equal(r.stdout, '', '--json prints no events when the inputs are rejected')
  })

  it('a folder given twice (and a file inside it) is one job per video', async () => {
    const r = await runJson(['--list', tmp.dir, tmp.dir, path.join(tmp.dir, 'a.mp4')])
    assert.equal(scanOf(r.events).jobs.length, 6)
  })
})

describe('--list stays fast on 20,000 files', { skip: SKIP }, () => {
  let tmp: Tmp
  const FOLDERS = 100
  const PER_FOLDER = 200
  before(async () => {
    tmp = await makeTmp('vconv-it-scale-')
    // 10 top folders x 10 sub-folders each = 100 nested folders, 200 empty .mp4 files each.
    const files: string[] = []
    for (let i = 0; i < FOLDERS; i++) {
      const dir = path.join(tmp.dir, `top${Math.floor(i / 10)}`, `sub${i % 10}`)
      mkdirSync(dir, { recursive: true })
      for (let k = 0; k < PER_FOLDER; k++) files.push(path.join(dir, `clip ${k}.mp4`))
    }
    let next = 0
    const worker = async (): Promise<void> => {
      for (let i = next++; i < files.length; i = next++) await writeFile(files[i] as string, '')
    }
    await Promise.all(Array.from({ length: 32 }, worker))
  })
  after(() => tmp.cleanup())

  it('counts 20,000 videos with --list -r --json in seconds, without ballooning memory', async () => {
    const rssFile = path.join(tmp.dir, 'rss.json')
    const preload = path.join(HERE, 'fixtures', 'rss-preload.js')
    const r = await runJson(['--list', '-r', ...CPU, tmp.dir], {
      nodeArgs: ['--import', `file:///${preload.replace(/\\/g, '/')}`],
      env: { ...process.env, VCONV_IT_RSS_FILE: rssFile },
      timeoutMs: 120_000
    })
    assert.equal(r.code, 0, r.stderr)
    const scan = scanOf(r.events)
    assert.equal(scan.counts.videos, FOLDERS * PER_FOLDER)
    assert.equal(summaryOf(r.events).counters.total, FOLDERS * PER_FOLDER)
    const usage = JSON.parse(await readFile(rssFile, 'utf8')) as { maxRSS: number; userCPUTime: number }
    const rssMb = usage.maxRSS / 1024
    const scanLineMb = Buffer.byteLength(r.stdout.split('\n')[0] ?? '') / 1024 / 1024
    console.log(
      `# scale: ${FOLDERS * PER_FOLDER} files, wall ${r.wallMs} ms (incl. node start), peak RSS ${rssMb.toFixed(1)} MB, ` +
        `scan-done line ${scanLineMb.toFixed(1)} MB, cpu ${(usage.userCPUTime / 1000).toFixed(0)} ms`
    )
    assert.ok(r.wallMs < 20_000, `--list took ${r.wallMs} ms`)
    assert.ok(rssMb < 400, `peak RSS ${rssMb} MB`)

    const textRss = path.join(tmp.dir, 'rss-text.json')
    const text = await runCli(['--list', '-r', tmp.dir], {
      nodeArgs: ['--import', `file:///${preload.replace(/\\/g, '/')}`],
      env: { ...process.env, VCONV_IT_RSS_FILE: textRss }
    })
    assert.match(text.stdout, /Found 20000 videos: 20000 to process/)
    const textUsage = JSON.parse(await readFile(textRss, 'utf8')) as { maxRSS: number }
    console.log(`# scale: text --list -r wall ${text.wallMs} ms, peak RSS ${(textUsage.maxRSS / 1024).toFixed(1)} MB`)
  })
})
