/** Scenarios 8 (ffmpeg paths, VCONV_FFMPEG, --tools) and 9 (--json, --plain, --dry-run, defaults). */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile, rm, rmdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { after, afterEach, before, beforeEach, describe, it } from 'node:test'
import {
  CPU,
  IS_WIN,
  TOOLS,
  assertCountersConsistent,
  clip,
  exists,
  makeTmp,
  noAnsi,
  ofType,
  parseEvents,
  put,
  runCli,
  runJson,
  SKIP,
  summaryOf,
  tree,
  type Tmp
} from './helpers.js'

let tmp: Tmp
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const realFfmpeg = TOOLS.ffmpeg ?? ''
const realBin = path.dirname(realFfmpeg)

/** PATH without any folder that holds ffmpeg, so only --ffmpeg / VCONV_FFMPEG can find it. */
function envWithoutFfmpeg(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const exe = IS_WIN ? 'ffmpeg.exe' : 'ffmpeg'
  const kept = (process.env[key] ?? '')
    .split(path.delimiter)
    .filter((d) => d.trim() !== '' && !existsSync(path.join(d.replace(/^"(.*)"$/, '$1'), exe)))
  const env: NodeJS.ProcessEnv = { ...process.env, [key]: kept.join(path.delimiter) }
  delete env['VCONV_FFMPEG']
  delete env['VCONV_FFPROBE']
  return { ...env, ...extra }
}

describe('finding ffmpeg', { skip: SKIP }, () => {
  let video: string
  beforeEach(async () => {
    video = await clip(path.join(tmp.dir, 'v.mp4'))
  })

  it('--ffmpeg <the real exe> (ffprobe found next to it), with PATH not holding ffmpeg', async () => {
    const r = await runJson(['--ffmpeg', realFfmpeg, ...CPU, video], { env: envWithoutFfmpeg() })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(await exists(`${video}.0.mp4`))
  })

  it('--ffmpeg <its folder>, and the folder above a bin/ folder', async () => {
    const r = await runJson(['--ffmpeg', realBin, ...CPU, video], { env: envWithoutFfmpeg() })
    assert.equal(r.code, 0, r.stderr)
    // The folder above `bin/` only works when ffmpeg really lives in a `bin` folder (not in every install layout).
    if (path.basename(realBin).toLowerCase() !== 'bin') return
    const above = await runJson(['--list', '--ffmpeg', path.dirname(realBin), video], { env: envWithoutFfmpeg() })
    assert.equal(above.code, 0, above.stderr)
  })

  it('--ffmpeg <missing> exits 2 and names --ffmpeg; PATH is not a silent fallback', async () => {
    const missing = path.join(tmp.dir, 'no', 'ffmpeg.exe')
    const r = await runCli(['--ffmpeg', missing, ...CPU, video])
    assert.equal(r.code, 2)
    assert.match(r.stderr, /--ffmpeg/)
    assert.ok(r.stderr.includes(missing), r.stderr)
    assert.ok(!(await exists(`${video}.0.mp4`)))
  })

  it('no ffmpeg anywhere exits 2 with a hint', async () => {
    const r = await runCli([...CPU, video], { env: envWithoutFfmpeg() })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /ffmpeg not found.*--ffmpeg.*VCONV_FFMPEG/s)
  })

  it('VCONV_FFMPEG=<exe> is used when PATH has no ffmpeg; --ffmpeg wins over it', async () => {
    const env = envWithoutFfmpeg({ VCONV_FFMPEG: realFfmpeg })
    const r = await runJson([...CPU, video], { env })
    assert.equal(r.code, 0, r.stderr)
    const wins = await runCli(['--ffmpeg', path.join(tmp.dir, 'nope'), ...CPU, video], { env })
    assert.equal(wins.code, 2)
    const folder = await runJson(['--list', video], { env: envWithoutFfmpeg({ VCONV_FFMPEG: realBin }) })
    assert.equal(folder.code, 0, folder.stderr)
  })

  it('--ffmpeg <a folder whose name has spaces and non-ASCII characters>', { skip: IS_WIN ? false : 'uses a junction' }, async () => {
    const link = path.join(tmp.dir, 'my ffmpeg ção')
    await symlink(realBin, link, 'junction')
    try {
      const r = await runJson(['--ffmpeg', link, ...CPU, video], { env: envWithoutFfmpeg() })
      assert.equal(r.code, 0, r.stderr)
      assert.ok(await exists(`${video}.0.mp4`))
      const tools = await runCli(['--tools', '--json', '--ffmpeg', link])
      assert.equal((JSON.parse(tools.stdout) as { ffmpeg: { path: string } }).ffmpeg.path, path.join(link, 'ffmpeg.exe'))
    } finally {
      await rmdir(link) // removes the junction only, never the real ffmpeg folder
    }
  })

  it('a relative input path is resolved against the working directory', async () => {
    const r = await runJson([...CPU, '.'], { cwd: tmp.dir })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(await exists(`${video}.0.mp4`))
  })

  it('--tools and --tools --json show the real binaries behind a console shim', async () => {
    const text = await runCli(['--tools'])
    assert.equal(text.code, 0, text.stderr)
    assert.match(text.stdout, /^ffmpeg\s+\S.*version/m)
    assert.match(text.stdout, /H\.264 encoders: .*libx264/)
    const json = await runCli(['--tools', '--json'])
    assert.equal(json.code, 0)
    const status = JSON.parse(json.stdout) as { ffmpeg: { path: string; version: string } | null; ffprobe: { path: string } | null; h264Encoders: string[]; error: string | null }
    assert.equal(status.ffmpeg?.path.toLowerCase(), realFfmpeg.toLowerCase())
    assert.ok(status.ffprobe?.path)
    assert.ok(status.h264Encoders.includes('libx264'))
    assert.equal(status.error, null)
  })

  it('--tools --ffmpeg <missing> exits 2', async () => {
    const r = await runCli(['--tools', '--json', '--ffmpeg', path.join(tmp.dir, 'nope')])
    assert.equal(r.code, 2)
    const status = JSON.parse(r.stdout) as { ffmpeg: unknown; error: string }
    assert.equal(status.ffmpeg, null)
  })

  it(
    '--tools names the real flag in its error',
    { todo: 'BUG: --tools error says "Pass --ffmpeg-path"; the flag is --ffmpeg (src/ffmpeg/tools.ts readToolsStatus)' },
    async () => {
      const r = await runCli(['--tools', '--json', '--ffmpeg', path.join(tmp.dir, 'nope')])
      const status = JSON.parse(r.stdout) as { error: string }
      assert.ok(!status.error.includes('--ffmpeg-path'), status.error)
    }
  )
})

describe('output modes', { skip: SKIP }, () => {
  let dir: Tmp
  before(async () => {
    dir = await makeTmp()
    await clip(path.join(dir.dir, 'a.mp4'))
    await clip(path.join(dir.dir, 'ação 1.mp4'), { audio: false })
    await put(path.join(dir.dir, 'bad.mp4'), 'not a video at all '.repeat(100))
  })
  after(() => dir.cleanup())

  it('--json writes only JSON lines on stdout, ending with finished', async () => {
    const work = await makeTmp()
    try {
      await clip(path.join(work.dir, 'a.mp4'))
      await put(path.join(work.dir, 'bad.mp4'), 'junk'.repeat(500))
      const r = await runCli(['--json', '--verbose', ...CPU, work.dir])
      const events = parseEvents(r.stdout)
      assert.equal(r.code, 1)
      const scanAt = events.findIndex((e) => e.type === 'scan-done')
      const firstStart = events.findIndex((e) => e.type === 'started')
      assert.ok(scanAt >= 0 && scanAt < firstStart, 'scan-done comes before the first started')
      assert.ok(events.slice(0, scanAt).every((e) => e.type === 'log'), 'only batch log lines may precede scan-done')
      assert.equal(summaryOf(events).counters.failed, 1)
      assertCountersConsistent(events)
      noAnsi(r.stdout)
    } finally {
      await work.cleanup()
    }
  })

  it('--plain has no ANSI escapes and ends with the summary', async () => {
    const r = await runCli(['--plain', '--verbose', '--dry-run', ...CPU, dir.dir])
    noAnsi(r.stdout)
    noAnsi(r.stderr)
    assert.match(r.stdout, /Finished in .*: /)
  })

  it('piped stdout without flags falls back to plain (no live panel)', async () => {
    const r = await runCli(['--dry-run', ...CPU, dir.dir], { env: { ...process.env, TERM: 'xterm-256color' } })
    noAnsi(r.stdout)
    noAnsi(r.stderr)
    assert.match(r.stdout, /Found 3 videos/)
  })

  it('--dry-run prints the $ ffmpeg commands and writes no file', async () => {
    const before = await tree(dir.dir)
    const r = await runCli(['--dry-run', '-r', ...CPU, dir.dir])
    assert.equal(r.code, 1, 'bad.mp4 still fails its probe in a dry run')
    const commands = r.stdout.split('\n').filter((l) => /\$ ffmpeg /.test(l))
    assert.ok(commands.length >= 2, r.stdout)
    assert.ok(commands.some((l) => l.includes('ação 1.mp4')), 'non-ASCII names are printed intact')
    assert.deepEqual(await tree(dir.dir), before)
    const json = await runJson(['--dry-run', ...CPU, path.join(dir.dir, 'a.mp4')])
    assert.equal(json.code, 0)
    assert.ok(ofType(json.events, 'log').some((e) => e.line.startsWith('$ ffmpeg ')))
    assert.deepEqual(await tree(dir.dir), before)
  })

  it('--quiet prints only the summary (and errors)', async () => {
    const r = await runCli(['--quiet', '--dry-run', ...CPU, path.join(dir.dir, 'a.mp4')])
    assert.equal(r.code, 0)
    assert.doesNotMatch(r.stdout, /\$ ffmpeg/)
    assert.match(r.stdout, /Finished in/)
  })

  it('usage errors exit 2 and point to --help', async () => {
    for (const args of [[], ['--nope', '.'], ['--existing', 'maybe', '.'], ['--size', '12', '.'], ['--crop', '1:2:3', '.']]) {
      const r = await runCli(args)
      assert.equal(r.code, 2, `vconv ${args.join(' ')}`)
      assert.match(r.stderr, /--help/)
    }
    const help = await runCli(['--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--delete-original/)
  })

  it('--log-file appends every job line', async () => {
    const log = path.join(dir.dir, 'logs', 'run.log')
    const r = await runCli(['--dry-run', '--log-file', log, ...CPU, path.join(dir.dir, 'a.mp4')])
    assert.equal(r.code, 0)
    assert.match(await readFile(log, 'utf8'), /\[#1 a\.mp4\] \$ ffmpeg/)
    await rm(path.dirname(log), { recursive: true, force: true })
  })
})

describe('defaults (GPU ladder first)', { skip: SKIP }, () => {
  it('converts with the default encoders/hwaccel, falling back as needed', async () => {
    const v = await clip(path.join(tmp.dir, 'gpu.mp4'), { w: 640, h: 360 })
    const r = await runJson(['--verbose', v])
    assert.equal(r.code, 0, r.stderr)
    const attempts = ofType(r.events, 'log').filter((e) => /^Attempt \d+\/\d+:/.test(e.line)).map((e) => e.line)
    assert.match(attempts[0] ?? '', /h264_nvenc, GPU decode/)
    console.log(`# defaults: ${attempts.join(' | ')}`)
    assert.ok(await exists(`${v}.0.mp4`))
  })
})
