import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { clearToolCache, findOnPath, locateTools } from '../../src/ffmpeg/locate.js'
import { makeTempDir } from './fixtures.js'

const winFiles = new Set([
  'C:\\bin\\ffmpeg.exe',
  'C:\\other\\ffmpeg.cmd',
  'C:\\tools\\ffmpeg.exe',
  'C:\\tools\\ffprobe.exe',
  'C:\\pathbin\\ffprobe.exe',
  'C:\\build\\bin\\ffmpeg.exe'
].map((f) => f.toLowerCase()))
const winDirs = new Set(['c:\\tools', 'c:\\build', 'c:\\build\\bin', 'c:\\empty'])
// Windows file systems are case-insensitive, and PATHEXT is upper case.
const winIsFile = (p: string): boolean => winFiles.has(p.toLowerCase())
const winIsDir = (p: string): boolean => winDirs.has(p.toLowerCase())
const winEnv = { Path: 'C:\\nothing;"C:\\other";C:\\bin;C:\\pathbin', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
const winOpts = { env: winEnv, platform: 'win32' as const, isFile: winIsFile, isDir: winIsDir }

describe('findOnPath', () => {
  it('walks PATH with PATHEXT, case-insensitive env key, skipping .cmd/.bat shims', () => {
    assert.equal(findOnPath('ffmpeg', winOpts), 'C:\\bin\\ffmpeg.exe')
  })
  it('finds POSIX binaries without extensions', () => {
    const r = findOnPath('ffprobe', {
      env: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
      isFile: (p) => p === '/usr/bin/ffprobe'
    })
    assert.equal(r, '/usr/bin/ffprobe')
  })
  it('returns null when absent', () => {
    assert.equal(findOnPath('ffmpeg', { env: { PATH: '/x' }, platform: 'linux', isFile: () => false }), null)
  })
})

describe('locateTools', () => {
  it('uses an explicit ffmpeg file and finds ffprobe next to it first (before PATH)', () => {
    const t = locateTools({ ffmpegPath: 'C:\\tools\\ffmpeg.exe', ffprobePath: null }, winOpts)
    assert.equal(t.ffmpeg, 'C:\\tools\\ffmpeg.exe')
    assert.equal(t.ffprobe, 'C:\\tools\\ffprobe.exe')
    assert.deepEqual(t.warnings, [])
  })

  it('accepts a folder as ffmpegPath, also its bin sub-folder', () => {
    const folder = locateTools({ ffmpegPath: 'C:\\tools', ffprobePath: null }, winOpts)
    assert.equal(folder.ffmpeg, 'C:\\tools\\ffmpeg.exe')
    const build = locateTools({ ffmpegPath: 'C:\\build', ffprobePath: null }, winOpts)
    assert.equal(build.ffmpeg, 'C:\\build\\bin\\ffmpeg.exe')
    // no ffprobe next to the build's ffmpeg: PATH is the last resort
    assert.equal(build.ffprobe, 'C:\\pathbin\\ffprobe.exe')
  })

  it('does not fall back to PATH when an explicit ffmpegPath is wrong: null plus a warning', () => {
    const missing = locateTools({ ffmpegPath: 'C:\\gone\\ffmpeg.exe', ffprobePath: null }, winOpts)
    assert.equal(missing.ffmpeg, null)
    assert.match(missing.warnings.join('\n'), /C:\\gone\\ffmpeg\.exe/)
    const emptyDir = locateTools({ ffmpegPath: 'C:\\empty', ffprobePath: null }, winOpts)
    assert.equal(emptyDir.ffmpeg, null)
    assert.equal(emptyDir.warnings.length, 1)
  })

  it('an explicit ffprobePath wins over the sibling; a wrong one gives null and a warning', () => {
    const t = locateTools({ ffmpegPath: 'C:\\tools\\ffmpeg.exe', ffprobePath: 'C:\\pathbin\\ffprobe.exe' }, winOpts)
    assert.equal(t.ffprobe, 'C:\\pathbin\\ffprobe.exe')
    const bad = locateTools({ ffmpegPath: 'C:\\tools\\ffmpeg.exe', ffprobePath: 'C:\\nope\\ffprobe.exe' }, winOpts)
    assert.equal(bad.ffprobe, null)
    assert.equal(bad.warnings.length, 1)
  })

  it('falls back to PATH for both when nothing is configured', () => {
    const t = locateTools({ ffmpegPath: null, ffprobePath: null }, winOpts)
    assert.equal(t.ffmpeg, 'C:\\bin\\ffmpeg.exe')
    assert.equal(t.ffprobe, 'C:\\pathbin\\ffprobe.exe')
  })

  it('returns nulls when PATH has nothing', () => {
    const t = locateTools(
      { ffmpegPath: null, ffprobePath: null },
      { env: { PATH: '' }, platform: 'linux', isFile: () => false, isDir: () => false }
    )
    assert.deepEqual(t, { ffmpeg: null, ffprobe: null, warnings: [] })
  })
})

describe('locateTools on the real file system', () => {
  let dir = ''
  before(async () => {
    dir = await makeTempDir('locate')
    await mkdir(path.join(dir, 'bin'))
    const name = process.platform === 'win32' ? '.exe' : ''
    await writeFile(path.join(dir, 'bin', `ffmpeg${name}`), 'x')
    await writeFile(path.join(dir, 'bin', `ffprobe${name}`), 'x')
  })
  after(async () => {
    clearToolCache()
    await rm(dir, { recursive: true, force: true })
  })

  it('resolves a downloaded-build folder and the sibling ffprobe', () => {
    const t = locateTools({ ffmpegPath: dir, ffprobePath: null }, { noCache: true })
    assert.equal(path.dirname(t.ffmpeg ?? ''), path.join(dir, 'bin'))
    assert.equal(path.dirname(t.ffprobe ?? ''), path.join(dir, 'bin'))
  })
})
