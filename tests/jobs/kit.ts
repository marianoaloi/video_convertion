/** Shared helpers of the jobs tests: temp dirs, a default RunConfig, a fake ExecHandle. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createVideoJob, serializeVideoJob } from '../../src/core/videoJob.js'
import { DEFAULT_VIDEO_EXTENSIONS } from '../../src/core/videoFiles.js'
import { DEFAULTS } from '../../src/types.js'
import type { ExecHandle, LogLevel, MediaInfo, RunConfig, RunnerProgress } from '../../src/types.js'

export async function makeTmp(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vconv-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

export async function write(file: string, content: string | Buffer = 'x'.repeat(2000)): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
  return file
}

export function makeConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    inputs: [],
    recursive: false,
    source: 'auto',
    extensions: [...DEFAULT_VIDEO_EXTENSIONS],
    parallel: 2,
    ffmpegPath: null,
    ffprobePath: null,
    encoders: ['libx264'],
    hwaccel: 'none',
    sameSize: false,
    maxSide: DEFAULTS.maxSide,
    maxRateKbps: DEFAULTS.maxRateKbps,
    minOutputBytes: 1000,
    verboseFfmpeg: false,
    ignoreErrors: false,
    keepParts: false,
    existing: 'skip',
    deleteOriginal: false,
    deleteMode: 'permanent',
    moveOrphans: false,
    upload: null,
    uploadAll: null,
    stallTimeoutMs: 0,
    hookTimeoutMs: 0,
    failureLog: false,
    logFile: null,
    stateFile: null,
    dryRun: false,
    listOnly: false,
    jobDefaults: { size: null, rate: null, crop: null, bright: null, contrast: null, transpose: null, convert: false },
    output: 'plain',
    quiet: false,
    ...overrides
  }
}

export interface FakeHandle extends ExecHandle {
  readonly logs: { line: string; level: LogLevel }[]
  readonly reports: RunnerProgress[]
  logPath: string | null
  abort(): void
}

export function fakeHandle(): FakeHandle {
  const controller = new AbortController()
  const logs: { line: string; level: LogLevel }[] = []
  const reports: RunnerProgress[] = []
  const handle: FakeHandle = {
    signal: controller.signal,
    logs,
    reports,
    logPath: null,
    progress: (r) => void reports.push(r),
    log: (line, level = 'info') => void logs.push({ line, level }),
    lines: () => logs.map((l) => l.line),
    setLogPath: (p) => {
      handle.logPath = p
    },
    abort: () => controller.abort()
  }
  return handle
}

export function fakeMedia(durationMs: number, extra: Partial<MediaInfo> = {}): MediaInfo {
  return {
    path: '',
    container: 'mov,mp4',
    formatLongName: null,
    durationMs,
    sizeBytes: 1000,
    bitrateKbps: 1000,
    hasVideo: true,
    width: 640,
    height: 480,
    displayWidth: 640,
    displayHeight: 480,
    rotation: 0,
    fps: 25,
    videoCodec: 'h264',
    pixFmt: 'yuv420p',
    hasAudio: true,
    audioCodec: 'aac',
    audioChannels: 2,
    streamCount: 2,
    ...extra
  }
}

export function jobJson(videoPath: string, times: [number, number][], posExecution: 1 | 2 = 1): string {
  return serializeVideoJob(createVideoJob(videoPath, { times, posExecution }))
}
