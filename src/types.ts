/**
 * Shared contracts of vconv. Owned by the lead (integration owner): module owners import from here
 * and never edit this file; ask the lead when a contract must change.
 *
 * Module map (who exports what) — see each section below for the types:
 *   src/core/**    pure logic, no I/O   (job JSON, ffmpeg argv builder, ladder, progress parser,
 *                                         naming, video file detection, hook templates, durations)
 *   src/ffmpeg/**  processes and files   (locate, process runner, probe, step executor, outputs,
 *                                         ladder runner, tools status)
 *   src/jobs/**    batch orchestration   (scan, executor, post steps, queue, hooks, trash, state, run)
 *   src/cli/**     command line          (args, reporter, main)
 */

// ---- job file (`<video>.json`) ----------------------------------------------------------------

/** Legacy `ProcessingFF`: cut = one output per range (`<video>.<i>.mp4`), concat = one output. */
export const ProcessingMode = { cut: 1, concat: 2 } as const
export type ProcessingMode = 1 | 2

/** `[-1, durationMs]` means "the whole video". */
export const WHOLE_VIDEO_START_MS = -1

/** `[startMs, endMs]`, integers. */
export type Range = [number, number]

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The v2 job file (same key set and order as the VideoEditor app). */
export interface VideoJob {
  filename: string
  originalPath: string
  crop: Rect | null
  /** -1..1 (ffmpeg eq brightness). */
  bright: number | null
  /** -4..4, 1 = neutral. */
  contrast: number | null
  /** Degrees, legacy sign. */
  transpose: number | null
  mediaPath: string | null
  /** "Convert first": re-encode the whole source to a clean H.264/MP4 before processing. */
  convert: boolean
  /** `"WxH"`, `"W:H"` or `"-1"` (keep the source size). */
  size: string | null
  /** Video bitrate kbit/s; null = source bitrate capped at maxRateKbps. */
  rate: number | null
  avgrate: number | null
  times: Range[]
  posExecution: ProcessingMode
  version: 2
}

export type VideoJobFormat = 'v2' | 'legacy' | 'legacy-old'

/** What `createVideoJob` accepts; missing fields get the defaults (null / false / [] / cut). */
export interface VideoJobDraft {
  originalPath?: string
  crop?: Rect | null
  bright?: number | null
  contrast?: number | null
  transpose?: number | null
  mediaPath?: string | null
  convert?: boolean
  size?: string | null
  rate?: number | null
  avgrate?: number | null
  times?: Range[]
  posExecution?: ProcessingMode
}

export type ParseVideoJobResult =
  | { readonly ok: true; readonly job: VideoJob; readonly format: VideoJobFormat; readonly warnings: string[] }
  | { readonly ok: false; readonly error: string; readonly warnings: string[] }

// ---- media (ffprobe) --------------------------------------------------------------------------

export interface MediaInfo {
  path: string
  container: string
  formatLongName: string | null
  /** 0 when unknown. */
  durationMs: number
  sizeBytes: number
  bitrateKbps: number | null
  hasVideo: boolean
  width: number
  height: number
  displayWidth: number
  displayHeight: number
  /** Degrees counter-clockwise in (-180, 180]. */
  rotation: number
  fps: number | null
  videoCodec: string | null
  pixFmt: string | null
  hasAudio: boolean
  audioCodec: string | null
  audioChannels: number | null
  streamCount: number
}

export type BuilderMedia = Pick<MediaInfo, 'durationMs' | 'width' | 'height' | 'bitrateKbps' | 'rotation' | 'hasAudio'>

// ---- ffmpeg steps -----------------------------------------------------------------------------

export type Strategy = 'direct' | 'copyThenCut'

export interface Attempt {
  readonly encoder: string
  readonly hwaccel: boolean
  readonly strategy: Strategy
}

export interface BuilderOpts {
  readonly encoder: string
  /** Adds the CUDA decode flags before every `-i`. */
  readonly hwaccel: boolean
  readonly strategy: Strategy
  /** "Same Size": no maxSide cap (sides still made even). */
  readonly sameSize: boolean
  /** Drops `-loglevel error`. */
  readonly verbose: boolean
  readonly maxRateKbps: number
  readonly maxSide: number
  /** Prefix of every output name; defaults to the input path. */
  readonly outputBase?: string
}

export interface FfmpegStep {
  readonly kind: 'cut' | 'copy' | 'concat'
  /** Without the executable and without the runner prefix. `-y` is last. */
  readonly argv: string[]
  readonly output: string
  /** Output duration in ms (progress denominator); null when unknown. */
  readonly expectedMs: number | null
}

export interface ConvertStep {
  readonly argv: string[]
  readonly output: string
}

/** One complete block of `ffmpeg -progress pipe:1`. */
export interface ProgressSample {
  readonly outTimeMs: number | null
  readonly speed: number | null
  readonly end: boolean
}

export interface RunnerProgress {
  /** 0..1 over all steps of the job. */
  readonly progress: number
  readonly stepIndex: number
  readonly stepCount: number
  readonly outTimeMs: number | null
  readonly speed: number | null
}

// ---- processes --------------------------------------------------------------------------------

export interface ProcessRequest {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  /** Merged over process.env. */
  readonly env?: Record<string, string>
  readonly signal?: AbortSignal
  /** Kill after this many ms (status 'timeout'). No timeout when omitted. */
  readonly timeoutMs?: number
  /**
   * Own process group, so the console's Ctrl+C does not reach the child. Default: true on POSIX,
   * false on win32 (detached win32 children lose their output when the binary is a console shim).
   */
  readonly detached?: boolean
  /** Cap of the captured stdout/stderr text (the end is kept). Default 1 MiB. */
  readonly maxCaptureBytes?: number
  /** Keep the whole stdout/stderr text in the result (default true). */
  readonly captureStdout?: boolean
  readonly captureStderr?: boolean
  readonly onStdoutLine?: (line: string) => void
  readonly onStderrLine?: (line: string) => void
}

export interface ProcessResult {
  readonly status: 'exited' | 'cancelled' | 'timeout' | 'spawn-error'
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly error?: { readonly code?: string; readonly message: string }
}

export interface StepRequest {
  /** The step argv WITHOUT the executable and WITHOUT the runner prefix. */
  readonly argv: readonly string[]
  readonly signal?: AbortSignal
  /**
   * Stall watchdog: kill the step (exit status 'timeout', a non-fatal failure) when ffmpeg has
   * printed no progress block with an advancing `out_time` for this many ms. 0/omitted = off.
   */
  readonly stallTimeoutMs?: number
  onProgress(sample: ProgressSample): void
  onStderrLine(line: string): void
}

export interface StepExit {
  readonly status: 'exited' | 'cancelled' | 'timeout' | 'spawn-error'
  readonly exitCode: number | null
  readonly spawnError?: string
}

/** Runs one ffmpeg step. Injectable so tests can fake ffmpeg. */
export type StepExecutor = (request: StepRequest) => Promise<StepExit>

export type StepVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly fatal: boolean }

export interface FfmpegJobRequest {
  readonly ffmpegPath: string
  readonly job: VideoJob
  readonly media: BuilderMedia
  readonly inputPath: string
  readonly outputBase?: string
  readonly encoders: readonly string[]
  readonly gpu: boolean
  readonly sameSize: boolean
  readonly verbose?: boolean
  readonly maxRateKbps: number
  readonly maxSide: number
  readonly minOutputBytes: number
  readonly keepParts?: boolean
  /** Passed to every step (see `StepRequest.stallTimeoutMs`). */
  readonly stallTimeoutMs?: number
  /** Shared by every job of a run: skips ladder rungs that keep failing (see `LadderMemory`). */
  readonly ladderMemory?: LadderMemory
  /** Log the argv of the first attempt and run nothing; touches no file. */
  readonly dryRun?: boolean
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: RunnerProgress) => void
  readonly onLog?: (line: string, source: 'info' | 'stderr') => void
  /** Removes a finished concat part. Without it the parts stay on disk. */
  readonly trashPart?: (path: string) => Promise<void>
  /** Removes an existing final output before the new one takes its name; without it a `name (n).mp4` is used. */
  readonly trashExisting?: (path: string) => Promise<void>
  readonly executor?: StepExecutor
}

/**
 * Run-wide memory of the attempt ladder (circuit breaker): an `{encoder, hwaccel}` pair that has
 * failed on the first N videos of a run without a single success (e.g. no NVIDIA GPU) is skipped
 * for the remaining videos, instead of costing every one of 50k files several failed attempts.
 */
export interface LadderMemory {
  /** True when this attempt should be skipped for the next job (never skips every rung). */
  shouldSkip(attempt: Attempt): boolean
  record(attempt: Attempt, ok: boolean): void
}

export type FfmpegJobResult =
  | { readonly ok: true; readonly outputs: string[]; readonly attempt: Attempt }
  | { readonly ok: false; readonly cancelled: boolean; readonly error: string; readonly lastLines: string[] }

// ---- tools ------------------------------------------------------------------------------------

export interface ToolsConfig {
  /** A file, or a folder that contains ffmpeg(.exe); null = PATH. */
  readonly ffmpegPath: string | null
  readonly ffprobePath: string | null
}

export interface LocatedTools {
  readonly ffmpeg: string | null
  readonly ffprobe: string | null
  readonly warnings: string[]
}

/** How ffmpeg/ffprobe are started (decided once at startup by `detectConsoleIsolation`). */
export interface SpawnPolicy {
  /** Pass `detached: true`: the console's first Ctrl+C does not kill running conversions. */
  readonly detached: boolean
}

export interface ToolInfo {
  readonly path: string
  readonly version: string | null
}

export interface ToolsStatus {
  readonly ffmpeg: ToolInfo | null
  readonly ffprobe: ToolInfo | null
  readonly h264Encoders: string[]
  readonly hwaccels: string[]
  readonly error: string | null
}

// ---- hooks (upload commands) ------------------------------------------------------------------

/** Placeholder values: `{file}` `{files}` `{dir}` `{root}` `{md5}` `{outputs}`. */
export interface HookContext {
  file?: string
  files?: string[]
  dir?: string
  root?: string
  md5?: string
  outputs?: string[]
}

/** A command template parsed from the command line: argv[0] is the command. */
export interface CommandTemplate {
  readonly command: string
  readonly args: string[]
}

export type HookOutcome = 'skipped' | 'ok' | 'failed'

// ---- run configuration (CLI -> jobs) ----------------------------------------------------------

/**
 * auto:  a video with a valid `<video>.json` uses it, a video without one is processed whole;
 * json:  only `*.json` job files (the app's "process folder");
 * force: every video processed whole, job files ignored (the app's "Force").
 */
export type SourceMode = 'auto' | 'json' | 'force'
export type DeleteMode = 'trash' | 'permanent'
/** When a final output name is already taken: skip the job (at scan), use `name (n).mp4`, or remove the old file. */
export type ExistingPolicy = 'skip' | 'rename' | 'replace'
/** GPU decoding: cuda/auto add the CUDA decode attempts first; none = CPU only. */
export type Hwaccel = 'none' | 'auto' | 'cuda'
export type OutputMode = 'tty' | 'plain' | 'json'

/** Job fields applied to whole-video jobs (videos without a job file, and force mode). */
export interface JobDefaults {
  size: string | null
  rate: number | null
  crop: Rect | null
  bright: number | null
  contrast: number | null
  transpose: number | null
  convert: boolean
}

export interface RunConfig {
  /** Folders, video files and/or `.json` job files (absolute). */
  inputs: string[]
  recursive: boolean
  source: SourceMode
  /** Lowercase with a dot: `.mp4`. */
  extensions: string[]
  parallel: number
  ffmpegPath: string | null
  ffprobePath: string | null
  encoders: string[]
  hwaccel: Hwaccel
  sameSize: boolean
  maxSide: number
  maxRateKbps: number
  minOutputBytes: number
  verboseFfmpeg: boolean
  /** "Ignore Error": ffmpeg stderr is kept in the job log but not printed. */
  ignoreErrors: boolean
  /** Concat: keep the cut parts. */
  keepParts: boolean
  existing: ExistingPolicy
  /** Remove the source video (and its .json) after a verified success. Default false. */
  deleteOriginal: boolean
  deleteMode: DeleteMode
  /** Move orphan/empty job files to `<root>/ruimFolder/` (otherwise only reported). */
  moveOrphans: boolean
  /** Per-job upload hook (after success, before delete). */
  upload: CommandTemplate | null
  /** Batch hook with every output when the run ends. */
  uploadAll: CommandTemplate | null
  /** Kill an ffmpeg step whose progress has not advanced for this long. 0 = off. */
  stallTimeoutMs: number
  /** Kill an upload hook after this long (counts as a failed hook). 0 = no limit. */
  hookTimeoutMs: number
  /** Write `<video>.log` when a job fails. */
  failureLog: boolean
  /** Append every log line here. */
  logFile: string | null
  /** Resume ledger: videos recorded as done are skipped on the next run. */
  stateFile: string | null
  dryRun: boolean
  /** Scan and count only. */
  listOnly: boolean
  jobDefaults: JobDefaults
  output: OutputMode
  quiet: boolean
}

/** Defaults shared by every module (the VideoEditor app defaults). */
export const DEFAULTS = {
  parallel: 2,
  maxParallel: 32,
  encoders: ['h264_nvenc', 'libx264'] as readonly string[],
  hwaccel: 'cuda' as Hwaccel,
  maxSide: 640,
  maxRateKbps: 500,
  minOutputBytes: 1000,
  source: 'auto' as SourceMode,
  existing: 'skip' as ExistingPolicy,
  deleteMode: 'trash' as DeleteMode,
  ruimFolder: 'ruimFolder',
  customFolder: 'CUSTOM',
  /** Allowed output/expected duration gap before "delete original" refuses (app: max(2 s, 10%)). */
  durationToleranceMs: 2000,
  durationToleranceRatio: 0.1,
  /** With `--delete-mode permanent` nothing can be recovered, so the gap must be max(2 s, 1%). */
  durationToleranceRatioPermanent: 0.01,
  stallTimeoutMs: 15 * 60_000,
  hookTimeoutMs: 0,
  /** Each trash call (PowerShell / gio / osascript). */
  trashTimeoutMs: 120_000
} as const

// ---- scan -------------------------------------------------------------------------------------

export interface PlannedJob {
  /** 1-based, in scan order. */
  readonly id: number
  readonly videoPath: string
  /** null for whole-video jobs without a job file. */
  readonly jsonPath: string | null
  readonly job: VideoJob
  readonly warnings: string[]
  /** Session root (`<root>/CUSTOM/x.mp4` belongs to `<root>`). */
  readonly root: string
  /** Final output names (`<video>.<i>.mp4` per range, or `<video>.mp4` for concat). */
  readonly expectedOutputs: string[]
}

export interface SkippedItem {
  readonly path: string
  readonly reason: string
  readonly movedTo: string | null
}

export interface ScanCounts {
  /** Video files found (before skipping). */
  videos: number
  withJson: number
  wholeVideo: number
  /** Skipped because outputs exist (existing = skip) or the state file says done. */
  alreadyDone: number
  /** Orphan, empty or invalid job files, unreadable entries. */
  invalid: number
}

export interface ScanResult {
  readonly jobs: PlannedJob[]
  readonly skipped: SkippedItem[]
  readonly counts: ScanCounts
}

// ---- execution --------------------------------------------------------------------------------

export type LogLevel = 'info' | 'warn' | 'stderr'

/** What a running job can do through the queue. */
export interface ExecHandle {
  readonly signal: AbortSignal
  progress(report: RunnerProgress): void
  log(line: string, level?: LogLevel): void
  /** Every log line of the job so far. */
  lines(): string[]
  setLogPath(path: string): void
}

export type ExecOutcome =
  | { readonly kind: 'done'; readonly outputs: string[] }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'cancelled' }

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface RunCounters {
  total: number
  queued: number
  processing: number
  done: number
  failed: number
  cancelled: number
  /** Skipped at scan time (already done, invalid, ...). */
  skipped: number
}

export interface RunFailure {
  readonly videoPath: string
  readonly message: string
  readonly logPath: string | null
}

export interface RunSummary {
  readonly counters: RunCounters
  readonly startedAt: number
  readonly finishedAt: number
  readonly outputs: string[]
  readonly failures: RunFailure[]
  /** True when the run was stopped by the user. */
  readonly interrupted: boolean
}

export type RunEvent =
  | { readonly type: 'scan-done'; readonly result: ScanResult }
  | { readonly type: 'started'; readonly jobId: number; readonly videoPath: string; readonly at: number }
  | {
      readonly type: 'progress'
      readonly jobId: number
      readonly progress: number
      readonly stepIndex: number
      readonly stepCount: number
      readonly outTimeMs: number | null
      readonly speed: number | null
    }
  /** jobId null = a batch-level line (upload-all, state file, ...). */
  | { readonly type: 'log'; readonly jobId: number | null; readonly line: string; readonly level: LogLevel }
  | { readonly type: 'done'; readonly jobId: number; readonly outputs: string[]; readonly durationMs: number }
  | { readonly type: 'error'; readonly jobId: number; readonly message: string; readonly logPath: string | null }
  | { readonly type: 'cancelled'; readonly jobId: number }
  /** Emitted after every status change. */
  | { readonly type: 'counters'; readonly counters: RunCounters }
  | { readonly type: 'finished'; readonly summary: RunSummary }

export interface RunController {
  /** Ctrl+C once: start no new job, cancel the queued ones, let the running ones finish. */
  stopLaunching(): void
  /** Ctrl+C twice: also kill the running ffmpeg processes (their partial outputs are removed). */
  abortAll(): void
}
