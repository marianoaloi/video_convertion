/**
 * Test helpers for every test that needs real media: fixtures are generated with ffmpeg lavfi
 * sources in `os.tmpdir()` at test time. Never import this from production code.
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { locateTools } from '../../src/ffmpeg/locate.js'
import { runProcess } from '../../src/ffmpeg/process.js'
import type { VideoJob } from '../../src/types.js'

export interface TestTools {
  readonly ffmpeg: string
  readonly ffprobe: string
}

/** ffmpeg + ffprobe from PATH, or `null` when either is missing (the test then skips). */
export function findTestTools(): TestTools | null {
  const tools = locateTools({ ffmpegPath: null, ffprobePath: null }, { noCache: true })
  if (tools.ffmpeg === null || tools.ffprobe === null) return null
  return { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe }
}

export async function makeTempDir(prefix = 'test'): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `vconv-${prefix}-`))
}

export interface VideoFixtureOptions {
  readonly seconds?: number
  readonly width?: number
  readonly height?: number
  readonly fps?: number
  /** Add a sine audio track. Default true. */
  readonly audio?: boolean
  /** Display-matrix rotation in degrees (ffmpeg `-display_rotation`, counter-clockwise). */
  readonly rotate?: number
}

async function ffmpeg(tools: TestTools, args: readonly string[]): Promise<void> {
  const result = await runProcess({
    command: tools.ffmpeg,
    args: ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args],
    timeoutMs: 60_000
  })
  if (result.status !== 'exited' || result.exitCode !== 0) {
    throw new Error(`ffmpeg fixture failed: ${result.stderr || result.status}`)
  }
}

/** An H.264/AAC clip (testsrc + sine). */
export async function generateVideo(
  tools: TestTools,
  dir: string,
  name: string,
  options: VideoFixtureOptions = {}
): Promise<string> {
  const { seconds = 3, width = 320, height = 240, fps = 25, audio = true } = options
  const out = path.join(dir, name)
  const target = options.rotate === undefined ? out : path.join(dir, `.pre-${name}`)
  const args = ['-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}`]
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100')
  args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p')
  if (audio) args.push('-c:a', 'aac', '-ac', '1')
  args.push(target)
  await ffmpeg(tools, args)
  if (options.rotate !== undefined) {
    await ffmpeg(tools, ['-display_rotation:v:0', String(options.rotate), '-i', target, '-c', 'copy', out])
  }
  return out
}

export async function generateImage(tools: TestTools, dir: string, name: string): Promise<string> {
  const out = path.join(dir, name)
  await ffmpeg(tools, ['-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=1', '-frames:v', '1', out])
  return out
}

export async function generateAudio(tools: TestTools, dir: string, name: string): Promise<string> {
  const out = path.join(dir, name)
  await ffmpeg(tools, ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', out])
  return out
}

/** A v2 job literal (no dependency on core's `createVideoJob`). */
export function makeJob(over: Partial<VideoJob> = {}): VideoJob {
  return {
    filename: '/x/v.mp4',
    originalPath: '/x/v.mp4',
    crop: null,
    bright: null,
    contrast: null,
    transpose: null,
    mediaPath: null,
    convert: false,
    size: null,
    rate: null,
    avgrate: null,
    times: [[1000, 3000]],
    posExecution: 1,
    version: 2,
    ...over
  }
}
