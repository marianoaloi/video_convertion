import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { detectConsoleIsolation } from '../../src/ffmpeg/isolation.js'
import { locateTools, parseScoopShim, parseShimgenHelp, resolveShims } from '../../src/ffmpeg/locate.js'
import { createProcessExecutor } from '../../src/ffmpeg/steps.js'
import type { ProgressSample } from '../../src/types.js'
import { findTestTools, makeTempDir } from './fixtures.js'

const win = process.platform === 'win32'

describe('shim parsers (pure)', () => {
  it('reads the Scoop .shim path with or without quotes', () => {
    assert.equal(parseScoopShim('path = "C:\\s\\apps\\ffmpeg.exe"\nargs = -x'), 'C:\\s\\apps\\ffmpeg.exe')
    assert.equal(parseScoopShim('path = C:\\a b\\ffmpeg.exe\r\n'), 'C:\\a b\\ffmpeg.exe')
    assert.equal(parseScoopShim('nothing'), null)
  })

  it('reads the chocolatey shimgen help (new and old wording)', () => {
    const help = "This is a shim.\n Target: 'C:\\choco\\lib\\x\\ffmpeg.exe'\n Target exists: 'True'\n"
    assert.equal(parseShimgenHelp(help), 'C:\\choco\\lib\\x\\ffmpeg.exe')
    assert.equal(parseShimgenHelp('path to executable: C:\\old\\ffmpeg.exe\n'), 'C:\\old\\ffmpeg.exe')
    assert.equal(parseShimgenHelp('ffmpeg version 6'), null)
  })
})

describe('resolveShims', { skip: !win }, () => {
  let dir = ''
  before(async () => {
    dir = await makeTempDir('shims')
    await mkdir(path.join(dir, 'shims'))
    await mkdir(path.join(dir, 'apps'))
    await writeFile(path.join(dir, 'apps', 'ffmpeg.exe'), 'x')
    await writeFile(path.join(dir, 'apps', 'ffprobe.exe'), 'x')
    await writeFile(path.join(dir, 'shims', 'ffmpeg.exe'), 'x')
    await writeFile(path.join(dir, 'shims', 'ffmpeg.shim'), `path = "${path.join(dir, 'apps', 'ffmpeg.exe')}"\n`)
    await writeFile(path.join(dir, 'shims', 'ffprobe.exe'), 'x')
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('replaces a Scoop shim and finds ffprobe next to the real ffmpeg', async () => {
    const tools = { ffmpeg: path.join(dir, 'shims', 'ffmpeg.exe'), ffprobe: path.join(dir, 'shims', 'ffprobe.exe'), warnings: [] }
    const r = await resolveShims(tools)
    assert.equal(r.ffmpeg, path.join(dir, 'apps', 'ffmpeg.exe'))
    assert.equal(r.ffprobe, path.join(dir, 'apps', 'ffprobe.exe'))
  })

  it('keeps the shim and warns when the target is missing; leaves real binaries alone', async () => {
    await writeFile(path.join(dir, 'shims', 'bad.exe'), 'x')
    await writeFile(path.join(dir, 'shims', 'bad.shim'), 'path = "C:\\nope\\x.exe"')
    const bad = await resolveShims({ ffmpeg: path.join(dir, 'shims', 'bad.exe'), ffprobe: null, warnings: [] })
    assert.equal(bad.ffmpeg, path.join(dir, 'shims', 'bad.exe'))
    assert.equal(bad.warnings.length, 1)
    const plain = { ffmpeg: path.join(dir, 'apps', 'ffmpeg.exe'), ffprobe: null, warnings: [] }
    assert.deepEqual(await resolveShims(plain), plain)
  })

  it('uses the shimgen help for exes in the chocolatey bin folder (injected)', async () => {
    const exe = path.join(dir, 'shims', 'ffmpeg2.exe')
    await writeFile(exe, 'x')
    const real = path.join(dir, 'apps', 'ffmpeg.exe')
    const r = await resolveShims(
      { ffmpeg: exe, ffprobe: null, warnings: [] },
      { env: { ChocolateyInstall: dir }, isFile: (p) => p === real || p === exe || p.endsWith('ffprobe.exe') && false, shimgenHelp: async () => ` Target: '${real}'` }
    )
    // `shims` is not `<root>\bin`, so the shim is not asked
    assert.equal(r.ffmpeg, exe)
    await mkdir(path.join(dir, 'bin'), { recursive: true })
    const shim = path.join(dir, 'bin', 'ffmpeg.exe')
    const r2 = await resolveShims(
      { ffmpeg: shim, ffprobe: null, warnings: [] },
      { env: { ChocolateyInstall: dir }, isFile: (p) => p === real, shimgenHelp: async () => ` Target: '${real}'` }
    )
    assert.equal(r2.ffmpeg, real)
  })
})

const tools = findTestTools()
const located = locateTools({ ffmpegPath: null, ffprobePath: null }, { noCache: true })
const isChocoShim = win && located.ffmpeg !== null && /chocolatey[\\/]bin/i.test(located.ffmpeg)

describe('chocolatey shim on this machine', { skip: !isChocoShim }, () => {
  it('resolves to the real binary, which runs detached; the shim does not', async () => {
    const shim = located.ffmpeg ?? ''
    const r = await resolveShims(located)
    assert.notEqual(r.ffmpeg, shim)
    assert.match(r.ffmpeg ?? '', /tools[\\/]ffmpeg[\\/]bin[\\/]ffmpeg\.exe$/i)
    assert.deepEqual(await detectConsoleIsolation(r.ffmpeg ?? ''), { detached: true })
    assert.deepEqual(await detectConsoleIsolation(shim), { detached: false })
  })

  it('a detached step on the resolved binary still reports progress', async () => {
    const r = await resolveShims(located)
    const exec = createProcessExecutor(r.ffmpeg ?? '', { detached: true })
    const samples: ProgressSample[] = []
    const exit = await exec({
      argv: ['-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25', '-t', '1', '-f', 'null', '-', '-y'],
      onProgress: (s) => samples.push(s),
      onStderrLine: () => undefined
    })
    assert.equal(exit.exitCode, 0)
    assert.ok(samples.length > 0 && samples.at(-1)?.end === true)
  })
})

describe('detectConsoleIsolation', { skip: win || tools === null }, () => {
  it('is detached on POSIX', async () => {
    assert.deepEqual(await detectConsoleIsolation(tools?.ffmpeg ?? ''), { detached: true })
  })
})
