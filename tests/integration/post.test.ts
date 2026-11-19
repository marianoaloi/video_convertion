/** Scenarios 4 (--delete-original, trash, --state resume) and 7 (--upload / --upload-all hooks). */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  CPU,
  IS_WIN,
  assertCountersConsistent,
  base,
  clip,
  commandLine,
  exists,
  hookCalls,
  hookScript,
  makeTmp,
  md5,
  names,
  near,
  ofType,
  probe,
  put,
  runCli,
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

const logsOf = (events: Parameters<typeof ofType>[0]): string[] => ofType(events, 'log').map((e) => e.line)

describe('--delete-original', { skip: SKIP }, () => {
  it('permanent: sources and job files go, a single output takes the original name, --state prevents a redo', async () => {
    const p = await clip(path.join(tmp.dir, 'p.mp4'), { w: 1280, h: 720 })
    const q = await clip(path.join(tmp.dir, 'q.mp4'))
    await put(`${q}.json`, JSON.stringify({ times: [[0, 1500]], posExecution: 1 }))
    const r = await clip(path.join(tmp.dir, 'r.mp4'))
    await put(`${r}.json`, JSON.stringify({ times: [[0, 800], [1000, 1800]], posExecution: 1 }))
    const state = path.join(tmp.dir, 'state', 'vconv.state')
    const args = ['--delete-original', '--delete-mode', 'permanent', '--state', state, ...CPU, tmp.dir]

    const first = await runJson(args)
    assert.equal(first.code, 0, first.stderr)
    assert.equal(assertCountersConsistent(first.events).done, 3)
    assert.deepEqual(await names(tmp.dir), ['p.mp4', 'q.mp4', 'r.mp4.0.mp4', 'r.mp4.1.mp4', 'state'])
    // p.mp4 is now the converted file (1280x720 source capped to 640x360)
    const pNow = await probe(p)
    assert.deepEqual([pNow.width, pNow.height], [640, 360])
    assert.ok(near((await probe(q)).durationMs, 1500))
    const done = ofType(first.events, 'done').flatMap((e) => e.outputs)
    assert.deepEqual(base(done), ['p.mp4', 'q.mp4', 'r.mp4.0.mp4', 'r.mp4.1.mp4'])
    assert.ok(logsOf(first.events).some((l) => l.startsWith('Deleted: ')))
    const pStat = await stat(p)

    const second = await runJson(args)
    assert.equal(second.code, 0, second.stderr)
    const scan = scanOf(second.events)
    assert.equal(scan.jobs.length, 0, `re-run planned ${scan.jobs.map((j) => j.videoPath).join(', ')}`)
    assert.equal(scan.counts.alreadyDone, 2)
    assert.ok(scan.skipped.every((s) => /state file/.test(s.reason)))
    assert.equal((await stat(p)).mtimeMs, pStat.mtimeMs, 'p.mp4 must not be converted again')
  })

  it('keeps the original when the converted duration does not match the job (range beyond the end)', async () => {
    const v = await clip(path.join(tmp.dir, 'v.mp4'))
    await put(`${v}.json`, JSON.stringify({ times: [[1000, 99000]], posExecution: 1 }))
    const r = await runJson(['--delete-original', '--delete-mode', 'permanent', ...CPU, v])
    assert.equal(r.code, 0, r.stderr)
    assert.deepEqual(await names(tmp.dir), ['v.mp4', 'v.mp4.0.mp4', 'v.mp4.json'])
    assert.ok(ofType(r.events, 'log').some((e) => e.level === 'warn' && /original was kept/.test(e.line)))
  })

  it('keeps the original when the --upload hook fails', async () => {
    const v = await clip(path.join(tmp.dir, 'v.mp4'))
    const before = await md5(v)
    const calls = path.join(tmp.dir, 'calls.ndjson')
    const failing = await hookScript(tmp.dir, calls, 3)
    const r = await runJson(['--delete-original', '--delete-mode', 'permanent', '--upload', commandLine(process.execPath, failing, '{outputs}'), ...CPU, v])
    assert.equal((await hookCalls(calls)).length, 1)
    assert.equal(await md5(v), before, 'the source must be untouched')
    assert.ok(await exists(`${v}.0.mp4`))
    assert.ok(ofType(r.events, 'log').some((e) => /kept because the upload hook failed/.test(e.line)))
    assert.equal(summaryOf(r.events).counters.done, 1)
    assert.equal(r.code, 0, 'a failed upload does not fail the job (exit code stays 0)')
  })

  it('without --delete-original nothing is removed', async () => {
    const v = await clip(path.join(tmp.dir, 'v.mp4'))
    await runJson([...CPU, v])
    assert.deepEqual(await names(tmp.dir), ['v.mp4', 'v.mp4.0.mp4'])
  })

  it('trash (default mode, Windows): the source goes to the Recycle Bin and the output takes its name', { skip: !IS_WIN ? 'Windows only' : process.env['CI'] !== undefined ? 'CI runners have no usable Recycle Bin' : false }, async () => {
    const unique = `vconv-it-trash-${randomBytes(4).toString('hex')}.mp4`
    const v = await clip(path.join(tmp.dir, unique), { w: 1280, h: 720 })
    await put(`${v}.json`, JSON.stringify({ times: [], posExecution: 1 }))
    const r = await runJson(['--delete-original', ...CPU, v])
    try {
      assert.equal(r.code, 0, r.stderr)
      assert.deepEqual(await names(tmp.dir), [unique], 'source + json gone, output renamed to the source name')
      const now = await probe(v)
      assert.deepEqual([now.width, now.height], [640, 360])
      assert.ok(logsOf(r.events).some((l) => l.startsWith('Sent to the trash: ')), logsOf(r.events).join('\n'))
      const binned = await recycleBinEntries(unique)
      assert.equal(binned.length, 2, `expected the video and its .json in the Recycle Bin, found ${binned.length}`)
    } finally {
      await purgeFromRecycleBin(unique)
    }
  })
})

describe('--delete-original on a path longer than MAX_PATH (Windows)', { skip: !IS_WIN ? 'Windows only' : SKIP }, () => {
  it(
    'trash mode either refuses (original kept) or really recycles a >260-char path',
    { todo: 'BUG (data loss): SendToRecycleBin silently deletes paths >= MAX_PATH for good; trash.ts/trashPolicy.ts must refuse them' },
    async () => {
      const unique = `vconv-it-long-${randomBytes(4).toString('hex')}`
      let dir = path.join(tmp.dir, unique)
      for (let i = 0; dir.length < 270; i++) dir = path.join(dir, `a rather long folder name ${i}`)
      const v = await clip(path.join(dir, 'clip.mp4'))
      assert.ok(v.length > 260, `path is ${v.length} chars`)
      const before = await md5(v)
      try {
        const r = await runJson(['--delete-original', ...CPU, v])
        assert.equal(r.code, 0, r.stderr)
        const kept = (await exists(v)) && (await md5(v)) === before
        const binned = (await recycleBinEntries(unique)).length > 0
        assert.ok(kept || binned, 'the original is neither kept nor in the Recycle Bin: it was deleted for good')
      } finally {
        await purgeFromRecycleBin(unique)
      }
    }
  )
})

/** `$I...` files of the current user's Recycle Bin whose original path contains `needle`. */
async function recycleBinEntries(needle: string): Promise<string[]> {
  const root = `${process.env['SystemDrive'] ?? 'C:'}\\$Recycle.Bin`
  const found: string[] = []
  for (const sid of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, sid)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      continue
    }
    for (const name of entries.filter((n) => n.startsWith('$I'))) {
      const info = await readFile(path.join(dir, name)).catch(() => Buffer.alloc(0))
      // $I v2: 8 version + 8 size + 8 time + 4 length, then the UTF-16 path.
      if (info.length > 28 && info.subarray(28).toString('utf16le').includes(needle)) found.push(path.join(dir, name))
    }
  }
  return found
}

/** Removes only this test's own items from the Recycle Bin. */
async function purgeFromRecycleBin(needle: string): Promise<void> {
  for (const info of await recycleBinEntries(needle)) {
    const data = path.join(path.dirname(info), `$R${path.basename(info).slice(2)}`)
    await rm(data, { force: true }).catch(() => undefined)
    await rm(info, { force: true }).catch(() => undefined)
  }
}

describe('upload hooks', { skip: SKIP }, () => {
  it('--upload gets {file} + one argv entry per output; {md5} is the source md5; --upload-all runs once with every output', async () => {
    const custom = path.join(tmp.dir, 'CUSTOM')
    const two = await clip(path.join(custom, 'ação 1.mp4'))
    await put(`${two}.json`, JSON.stringify({ times: [[0, 800], [1000, 1800]], posExecution: 1 }))
    const one = await clip(path.join(tmp.dir, 'with space.mp4'))
    const sums = new Map([[two, await md5(two)], [one, await md5(one)]])
    const perJob = path.join(tmp.dir, 'per-job.ndjson')
    const batch = path.join(tmp.dir, 'batch.ndjson')
    const script = await hookScript(tmp.dir, perJob)
    const allScript = await hookScript(path.join(tmp.dir, 'all'), batch)
    const r = await runJson([
      '-r',
      '--upload', commandLine(process.execPath, script, '{file}', '{md5}', '{dir}', '{root}', '{outputs}'),
      '--upload-all', commandLine(process.execPath, allScript, 'all', '{outputs}'),
      ...CPU,
      tmp.dir
    ])
    assert.equal(r.code, 0, r.stderr)
    const calls = await hookCalls(perJob)
    assert.equal(calls.length, 2)
    for (const argv of calls) {
      const [file, sum, dir, root, ...outputs] = argv as [string, string, string, string, ...string[]]
      assert.equal(sum, sums.get(file), `{md5} of ${file}`)
      assert.equal(dir, path.dirname(file))
      assert.equal(root, tmp.dir, '{root}: <root>/CUSTOM/x.mp4 belongs to <root>')
      const expected = file === two ? [`${two}.0.mp4`, `${two}.1.mp4`] : [`${one}.0.mp4`]
      assert.deepEqual(outputs, expected)
    }
    const all = await hookCalls(batch)
    assert.equal(all.length, 1, '--upload-all runs once')
    assert.equal(all[0]?.[0], 'all')
    assert.deepEqual([...(all[0]?.slice(1) ?? [])].sort(), [`${one}.0.mp4`, `${two}.0.mp4`, `${two}.1.mp4`].sort())
  })

  it('a hook command that does not exist is a logged failure, not a crash', async () => {
    const v = await clip(path.join(tmp.dir, 'v.mp4'))
    const r = await runJson(['--upload', 'vconv-no-such-uploader {outputs}', ...CPU, v])
    assert.equal(r.code, 0)
    assert.ok(logsOf(r.events).some((l) => /Hook failed/.test(l)), logsOf(r.events).join('\n'))
  })

  it(
    'an unknown placeholder in --upload / --upload-all is a usage error before anything runs',
    { todo: 'BUG: --upload "echo {nope}" is accepted; every job converts, every hook fails, exit 0 (args.ts template())' },
    async () => {
      const v = await clip(path.join(tmp.dir, 'v.mp4'))
      for (const flag of ['--upload', '--upload-all']) {
        const r = await runCli([flag, 'echo {nope} {outputs', ...CPU, v])
        assert.equal(r.code, 2, `${flag}: exit ${r.code}`)
        assert.match(r.stderr, new RegExp(flag))
      }
      assert.ok(!(await exists(`${v}.0.mp4`)), 'nothing may be converted')
    }
  )

  it(
    '--help describes {file} and {md5} as what the hook receives',
    { todo: 'BUG (docs): --help says {file} is "the converted video (first output)" and {md5} the "md5 of the output"; both are the SOURCE video' },
    async () => {
      const help = (await runCli(['--help'])).stdout
      assert.ok(!/\{file\}\s+the converted video/.test(help), '--help: {file} is documented as the converted video')
      assert.ok(!/\{md5\}\s+md5 of the output/.test(help), '--help: {md5} is documented as the md5 of the output')
    }
  )
})
