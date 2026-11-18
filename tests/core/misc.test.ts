/** ladder, progress, naming, derived outputs, extension lists, durations. */
import { describe, it } from 'node:test'
import { expect } from './expect.js'
import type { BuilderMedia, BuilderOpts, VideoJob } from '../../src/types.js'
import { buildFfmpegArgs } from '../../src/core/ffmpegArgs.js'
import { buildLadder, describeAttempt } from '../../src/core/ladder.js'
import { ProgressParser, overallProgress, stepFraction } from '../../src/core/progress.js'
import { collisionName, splitExt } from '../../src/core/naming.js'
import { isDerivedOutput, isVideoFileName, parseExtensionList } from '../../src/core/videoFiles.js'
import { expectedDurationsMs, expectedOutputNames, withinTolerance } from '../../src/core/durations.js'

describe('attempt ladder', () => {
  it('has the §7.2 shape', () => {
    const ladder = buildLadder(['h264_nvenc', 'libx264'], true)
    expect(ladder).toHaveLength(8)
    expect(ladder.slice(0, 4)).toEqual([
      { encoder: 'h264_nvenc', hwaccel: true, strategy: 'direct' },
      { encoder: 'h264_nvenc', hwaccel: true, strategy: 'copyThenCut' },
      { encoder: 'libx264', hwaccel: true, strategy: 'direct' },
      { encoder: 'libx264', hwaccel: true, strategy: 'copyThenCut' }
    ])
    expect(ladder[6]).toEqual({ encoder: 'libx264', hwaccel: false, strategy: 'direct' })
    expect(buildLadder(['h264_nvenc', 'libx264'], false)).toHaveLength(4)
    expect(buildLadder(['libx264'], true)).toHaveLength(4)
    expect(buildLadder(['libx264', 'libx264'], false)).toHaveLength(2)
  })

  it('describes an attempt', () => {
    expect(describeAttempt({ encoder: 'libx264', hwaccel: false, strategy: 'copyThenCut' }, 1, 4)).toBe(
      'Attempt 2/4: libx264, CPU decode, copy then cut'
    )
  })
})

describe('ProgressParser', () => {
  it('uses out_time_us and ends a block on progress=', () => {
    const parser = new ProgressParser()
    const lines = ['frame=10', 'out_time_us=1500000', 'out_time_ms=1500000', 'speed=1.5x', 'progress=continue']
    const samples = lines.map((l) => parser.feed(l)).filter((s) => s !== null)
    expect(samples).toEqual([{ outTimeMs: 1500, speed: 1.5, end: false }])
    expect(parser.feed('out_time_us=N/A')).toBeNull()
    expect(parser.feed('speed=N/A')).toBeNull()
    expect(parser.feed('progress=end')).toEqual({ outTimeMs: null, speed: null, end: true })
  })

  it('fractions and overall progress are clamped', () => {
    expect(stepFraction(500, 1000)).toBe(0.5)
    expect(stepFraction(5000, 1000)).toBe(1)
    expect(stepFraction(null, 1000)).toBeNull()
    expect(stepFraction(10, null)).toBeNull()
    expect(stepFraction(10, 0)).toBeNull()
    expect(overallProgress(1, 4, 0.5)).toBe(0.375)
    expect(overallProgress(0, 0, 0.5)).toBe(0)
    expect(overallProgress(3, 4, 5)).toBe(1)
  })
})

describe('naming', () => {
  it('collisionName inserts (n) before the last extension', () => {
    expect(collisionName('a.mp4', 2)).toBe('a (2).mp4')
    expect(collisionName('clip.final.mp4', 2)).toBe('clip.final (2).mp4')
    expect(collisionName('noext', 1)).toBe('noext (1)')
    expect(collisionName('clip.mp4', 0)).toBe('clip.mp4')
    expect(collisionName('.bashrc', 1)).toBe('.bashrc (1)')
  })

  it('splitExt handles dotfiles and multi-dot names', () => {
    expect(splitExt('a.tar.gz')).toEqual({ stem: 'a.tar', ext: '.gz' })
    expect(splitExt('.bashrc')).toEqual({ stem: '.bashrc', ext: '' })
    expect(splitExt('noext')).toEqual({ stem: 'noext', ext: '' })
    expect(splitExt('v.mp4.0.mp4')).toEqual({ stem: 'v.mp4.0', ext: '.mp4' })
  })
})

describe('isDerivedOutput', () => {
  const none = new Set<string>()

  it('flags outputs of earlier runs', () => {
    for (const name of ['v.mp4.0.mp4', 'v.mkv.12.mp4', 'v.mp4.copy.mp4', 'v.mp4.converted.mp4', 'v.mp4.0.part.mp4', 'v.mp4.copy.part.mp4', 'V.MP4.COPY.MP4']) {
      expect(isDerivedOutput(name, none), name).toBe(true)
    }
  })

  it('flags <video>.mp4 only when the source video sits next to it', () => {
    expect(isDerivedOutput('v.mp4.mp4', new Set(['v.mp4']))).toBe(true)
    expect(isDerivedOutput('v.mp4.mp4', none)).toBe(false)
    expect(isDerivedOutput('clip.mp4', new Set(['clip']))).toBe(false)
  })

  it('leaves plain sources alone', () => {
    for (const name of ['v.mp4', 'v.mkv', 'clip.2.mp4', 'a.txt.0.mp4']) {
      expect(isDerivedOutput(name, none), name).toBe(false)
    }
  })

  it('recognises outputs that got a collision name', () => {
    for (const name of ['v.mp4.0 (1).mp4', 'v.mp4.12 (3).mp4', 'v.mp4.copy (1).mp4', 'v.mp4.converted (1).mp4', 'v.mp4.0.part (1).mp4']) {
      expect(isDerivedOutput(name, none), name).toBe(true)
    }
    expect(isDerivedOutput('v.mp4 (2).mp4', new Set(['v.mp4']))).toBe(true)
  })

  it('keeps user videos named like derived ones as sources, unless the stem is a video', () => {
    for (const name of ['holiday.copy.mp4', 'x.converted.mp4', 'trip.part.mp4', 'trip.part (1).mp4']) {
      expect(isDerivedOutput(name, none), name).toBe(false)
    }
    for (const name of ['v.mp4.0.part.mp4', 'v.mp4.part.mp4', 'v.mkv.converted.mp4', 'v.mp4.copy.part.mp4']) {
      expect(isDerivedOutput(name, none), name).toBe(true)
    }
  })

  it('keeps user files with a (n) suffix as sources', () => {
    expect(isDerivedOutput('holiday (1).mp4', none)).toBe(false)
    expect(isDerivedOutput('holiday (1).mp4', new Set(['holiday']))).toBe(false)
    expect(isDerivedOutput('clip (2).mkv', none)).toBe(false)
    expect(isDerivedOutput('a (1).mp4', new Set(['a.mp4']))).toBe(false)
    expect(isDerivedOutput('v.mp4 (2).mp4', none)).toBe(false)
  })

  it('honours a custom extension list', () => {
    expect(isDerivedOutput('v.xyz.0.mp4', none)).toBe(false)
    expect(isDerivedOutput('v.xyz.0.mp4', none, ['.xyz'])).toBe(true)
  })
})

describe('parseExtensionList', () => {
  it('normalises, lower-cases and de-duplicates', () => {
    expect(parseExtensionList('mp4, .MKV,webm')).toEqual(['.mp4', '.mkv', '.webm'])
    expect(parseExtensionList('mp4,.MP4, mp4')).toEqual(['.mp4'])
    expect(parseExtensionList(' mov ,')).toEqual(['.mov'])
  })

  it('throws on empty lists and bad entries', () => {
    expect(() => parseExtensionList('')).toThrow(/empty/)
    expect(() => parseExtensionList(' , ,')).toThrow(/empty/)
    expect(() => parseExtensionList('mp4,a/b')).toThrow(/Invalid/)
    expect(() => parseExtensionList('mp4,a\\b')).toThrow(/Invalid/)
    expect(() => parseExtensionList('m p4')).toThrow(/Invalid/)
    expect(() => parseExtensionList('.')).toThrow(/Invalid/)
  })

  it('feeds isVideoFileName', () => {
    expect(isVideoFileName('a.MKV', parseExtensionList('mkv'))).toBe(true)
    expect(isVideoFileName('a.mp4', parseExtensionList('mkv'))).toBe(false)
  })
})

const IN = '/d/v.mp4'
const MEDIA: BuilderMedia = { durationMs: 60_000, width: 1280, height: 720, bitrateKbps: 1000, rotation: 0, hasAudio: true }
const OPTS: BuilderOpts = {
  encoder: 'libx264', hwaccel: false, strategy: 'direct', sameSize: false, verbose: false, maxRateKbps: 500, maxSide: 640
}

function job(over: Partial<VideoJob>): VideoJob {
  return {
    filename: IN, originalPath: IN, crop: null, bright: null, contrast: null, transpose: null, mediaPath: null,
    convert: false, size: null, rate: null, avgrate: null, times: [], posExecution: 1, version: 2, ...over
  }
}

describe('durations', () => {
  it('one duration per range, or their sum for concat; -1 means the whole source', () => {
    expect(expectedDurationsMs(job({ times: [[0, 1000], [5000, 8000]] }), 60_000)).toEqual([1000, 3000])
    expect(expectedDurationsMs(job({ times: [[0, 1000], [5000, 8000]], posExecution: 2 }), 60_000)).toEqual([4000])
    expect(expectedDurationsMs(job({}), 90_500)).toEqual([90_500])
    expect(expectedDurationsMs(job({ times: [[-1, 90_500]] }), 90_500)).toEqual([90_500])
  })

  it('withinTolerance: max(2000 ms, 10%) slack', () => {
    expect(withinTolerance(1000, 1000)).toBe(true)
    expect(withinTolerance(3000, 1000)).toBe(true)
    expect(withinTolerance(3001, 1000)).toBe(false)
    expect(withinTolerance(109_000, 100_000)).toBe(true)
    expect(withinTolerance(111_000, 100_000)).toBe(false)
    expect(withinTolerance(89_000, 100_000)).toBe(false)
    expect(withinTolerance(90_000, 100_000)).toBe(true)
  })

  it('withinTolerance takes a custom ratio (permanent delete uses 1%)', () => {
    const hours3 = 3 * 3600_000
    expect(withinTolerance(hours3 - 15 * 60_000, hours3)).toBe(true)
    expect(withinTolerance(hours3 - 15 * 60_000, hours3, 0.01)).toBe(false)
    expect(withinTolerance(hours3 - 100_000, hours3, 0.01)).toBe(true)
    expect(withinTolerance(1000, 1500, 0.01)).toBe(true)
    expect(withinTolerance(100, 5000, 0.01)).toBe(false)
  })

  it('expectedOutputNames', () => {
    expect(expectedOutputNames(job({ times: [[0, 1], [2, 3]] }), '/v/a.mp4')).toEqual(['/v/a.mp4.0.mp4', '/v/a.mp4.1.mp4'])
    expect(expectedOutputNames(job({}), '/v/a.mp4')).toEqual(['/v/a.mp4.0.mp4'])
    expect(expectedOutputNames(job({ times: [[0, 1], [2, 3]], posExecution: 2 }), '/v/a.mp4')).toEqual(['/v/a.mp4.mp4'])
  })

  it('agrees with the final outputs of buildFfmpegArgs', () => {
    const cases: Partial<VideoJob>[] = [
      {},
      { times: [[0, 1000]] },
      { times: [[0, 1000], [2000, 3000], [4000, 5000]] },
      { times: [[0, 1000], [2000, 3000]], posExecution: 2 },
      { times: [[-1, 60_000]] }
    ]
    for (const strategy of ['direct', 'copyThenCut'] as const) {
      for (const over of cases) {
        const j = job(over)
        const steps = buildFfmpegArgs(j, MEDIA, IN, { ...OPTS, strategy })
        const finals = j.posExecution === 2 ? steps.filter((s) => s.kind === 'concat') : steps.filter((s) => s.kind === 'cut')
        expect(finals.map((s) => s.output), JSON.stringify(over)).toEqual(expectedOutputNames(j, IN))
      }
    }
  })
})
