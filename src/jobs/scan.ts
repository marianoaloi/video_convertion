/**
 * Input scan: turns folders / video files / job files into planned jobs (port of the app's
 * `enqueueFolder` / `enqueueFiles` / `scanJsonFile` / `scanJobsDir` / `listFolderVideos`).
 *
 * Phase 1 walks the folders listing names only (`readdir` with file types, no per-file stat);
 * phase 2 classifies the candidates with a small worker pool (job JSON reads, ledger and output
 * checks); phase 3 sorts and numbers the jobs. One bad entry never throws: it becomes `skipped`.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { expectedOutputNames } from '../core/durations.js'
import { collisionName } from '../core/naming.js'
import { isDerivedOutput, isVideoFileName } from '../core/videoFiles.js'
import { createVideoJob, parseVideoJobText } from '../core/videoJob.js'
import { isAlreadyExists, moveExclusive } from '../ffmpeg/outputs.js'
import { DEFAULTS } from '../types.js'
import type { PlannedJob, RunConfig, ScanCounts, ScanResult, SkippedItem, SourceMode, VideoJob } from '../types.js'
import { fold, isFile, isNotFound, messageOf, pathKey, rootOfVideo } from './paths.js'
import type { StateLedger } from './state.js'

export { rootOfVideo } from './paths.js'

const JSON_SUFFIX = /\.json$/i
const POOL_SIZE = 16

type Candidate =
  | { kind: 'video'; videoPath: string; mode: SourceMode; sidecar: boolean | null }
  | { kind: 'json'; jsonPath: string; videoPath: string; videoExists: boolean | null }

interface Draft {
  videoPath: string
  jsonPath: string | null
  job: VideoJob
  warnings: string[]
}

type Outcome =
  | { kind: 'job'; draft: Draft }
  | { kind: 'skip'; item: SkippedItem; bucket: 'invalid' | 'done' | 'none'; videoCounted: boolean }

type JsonClass =
  | { kind: 'job'; draft: Draft }
  | { kind: 'orphan' | 'empty' | 'invalid'; reason: string }

export interface ScanOptions {
  ledger?: StateLedger
  /** Aborting returns what was found so far, with no jobs, and moves nothing. */
  signal?: AbortSignal
}

const WIN_SYSTEM_DIRS = new Set(['$recycle.bin', 'system volume information'])

/** Folders that hold trashed originals or filesystem internals: never scanned. */
export function isSystemFolder(name: string): boolean {
  return process.platform === 'win32' ? WIN_SYSTEM_DIRS.has(name.toLowerCase()) : name === 'lost+found'
}

export async function scanInputs(config: RunConfig, opts: ScanOptions = {}): Promise<ScanResult> {
  const counts: ScanCounts = { videos: 0, withJson: 0, wholeVideo: 0, alreadyDone: 0, invalid: 0 }
  const skipped: SkippedItem[] = []
  const { signal } = opts
  const candidates = await collectCandidates(config, skipped, counts, signal)
  const outcomes = await mapPool(candidates, POOL_SIZE, async (candidate) => {
    if (signal?.aborted) return null
    try {
      return await resolveCandidate(candidate, config, opts.ledger, signal)
    } catch (error) {
      return failure(candidate, error)
    }
  })
  const drafts: Draft[] = []
  for (const outcome of outcomes) {
    if (outcome === null) continue
    if (outcome.kind === 'job') {
      drafts.push(outcome.draft)
      if (outcome.draft.jsonPath === null) counts.wholeVideo += 1
      else counts.withJson += 1
      counts.videos += 1
      continue
    }
    skipped.push(outcome.item)
    if (outcome.videoCounted) counts.videos += 1
    if (outcome.bucket === 'invalid') counts.invalid += 1
    if (outcome.bucket === 'done') counts.alreadyDone += 1
  }
  if (signal?.aborted) return { jobs: [], skipped, counts }
  return { jobs: drafts.map((draft, index) => plan(draft, index + 1)), skipped, counts }
}

function plan(draft: Draft, id: number): PlannedJob {
  return {
    id,
    videoPath: draft.videoPath,
    jsonPath: draft.jsonPath,
    job: draft.job,
    warnings: draft.warnings,
    root: rootOfVideo(draft.videoPath, DEFAULTS.customFolder),
    expectedOutputs: expectedOutputNames(draft.job, draft.videoPath)
  }
}

function failure(candidate: Candidate, error: unknown): Outcome {
  const target = candidate.kind === 'json' ? candidate.jsonPath : candidate.videoPath
  const reason = isNotFound(error) ? `Not found: ${messageOf(error)}` : messageOf(error)
  return { kind: 'skip', item: { path: target, reason, movedTo: null }, bucket: 'invalid', videoCounted: false }
}

// ---- phase 1: candidates ----------------------------------------------------------------------

async function collectCandidates(
  config: RunConfig,
  skipped: SkippedItem[],
  counts: ScanCounts,
  signal: AbortSignal | undefined
): Promise<Candidate[]> {
  const found = new Map<string, Candidate>()
  const add = (candidate: Candidate): void => {
    // A video and its job file are one job: the first one found wins.
    const key = pathKey(candidate.videoPath)
    if (!found.has(key)) found.set(key, candidate)
  }
  const skip = (target: string, reason: string, invalid: boolean): void => {
    skipped.push({ path: target, reason, movedTo: null })
    if (invalid) counts.invalid += 1
  }
  for (const input of config.inputs) {
    if (signal?.aborted) break
    let info
    try {
      info = await stat(input)
    } catch (error) {
      skip(input, `Not found: ${messageOf(error)}`, true)
      continue
    }
    if (info.isDirectory()) await walkFolder(input, config, add, skip, signal)
    else explicitFile(input, config, add, skip)
  }
  return [...found.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, candidate]) => candidate)
}

function explicitFile(
  input: string,
  config: RunConfig,
  add: (c: Candidate) => void,
  skip: (target: string, reason: string, invalid: boolean) => void
): void {
  const name = path.basename(input)
  if (JSON_SUFFIX.test(name)) {
    if (config.source === 'force') {
      skip(input, 'Job files are ignored in force mode', false)
      return
    }
    const stem = name.replace(JSON_SUFFIX, '')
    if (!isVideoFileName(stem, config.extensions) || isDerivedOutput(stem, new Set(), config.extensions)) {
      skip(input, 'Not a job file', false)
      return
    }
    add({ kind: 'json', jsonPath: input, videoPath: input.replace(JSON_SUFFIX, ''), videoExists: null })
  } else if (isVideoFileName(name, config.extensions)) {
    add({ kind: 'video', videoPath: input, mode: config.source, sidecar: null })
  } else {
    skip(input, 'Not a video file', false)
  }
}

async function walkFolder(
  root: string,
  config: RunConfig,
  add: (c: Candidate) => void,
  skip: (target: string, reason: string, invalid: boolean) => void,
  signal: AbortSignal | undefined
): Promise<void> {
  const pending = [root]
  const ruim = fold(DEFAULTS.ruimFolder)
  for (let dir = pending.pop(); dir !== undefined && !signal?.aborted; dir = pending.pop()) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      skip(dir, `Cannot read folder: ${messageOf(error)}`, true)
      continue
    }
    const names = new Set(entries.map((e) => fold(e.name)))
    const siblings: ReadonlySet<string> = new Set(entries.map((e) => e.name))
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const skipDir = entry.name.startsWith('.') || fold(entry.name) === ruim || isSystemFolder(entry.name)
        if (config.recursive && !skipDir) pending.push(full)
      } else if (entry.isFile() || (entry.isSymbolicLink() && (await followsToFile(full)))) {
        visitFile(entry.name, full, names, siblings, config, add)
      }
    }
  }
}

async function followsToFile(full: string): Promise<boolean> {
  try {
    return await isFile(full)
  } catch {
    return false
  }
}

function visitFile(
  name: string,
  full: string,
  names: ReadonlySet<string>,
  siblings: ReadonlySet<string>,
  config: RunConfig,
  add: (c: Candidate) => void
): void {
  const mode = config.source
  if (JSON_SUFFIX.test(name)) {
    // Only `<video>.json` files are job files; `package.json` and friends are left alone.
    const stem = name.replace(JSON_SUFFIX, '')
    if (mode === 'force' || !isVideoFileName(stem, config.extensions)) return
    if (isDerivedOutput(stem, siblings, config.extensions)) return
    const videoExists = names.has(fold(stem))
    if (mode === 'json' || !videoExists) {
      add({ kind: 'json', jsonPath: full, videoPath: full.replace(JSON_SUFFIX, ''), videoExists })
    }
    return
  }
  if (mode === 'json') return
  if (!isVideoFileName(name, config.extensions) || isDerivedOutput(name, siblings, config.extensions)) return
  add({ kind: 'video', videoPath: full, mode, sidecar: mode === 'force' ? false : names.has(fold(`${name}.json`)) })
}

// ---- phase 2: classification ------------------------------------------------------------------

async function resolveCandidate(
  candidate: Candidate,
  config: RunConfig,
  ledger: StateLedger | undefined,
  signal: AbortSignal | undefined
): Promise<Outcome> {
  const outcome = await classify(candidate, config, signal)
  if (outcome.kind !== 'job') return outcome
  return checkAlreadyDone(outcome.draft, config, ledger)
}

async function classify(candidate: Candidate, config: RunConfig, signal: AbortSignal | undefined): Promise<Outcome> {
  if (candidate.kind === 'json') {
    return fromJson(await classifyJson(candidate.jsonPath, candidate.videoPath, candidate.videoExists), candidate, config, signal)
  }
  const { videoPath, mode } = candidate
  const jsonPath = `${videoPath}.json`
  if (mode !== 'force') {
    const sidecar = candidate.sidecar ?? (await isFile(jsonPath))
    if (sidecar) return fromJson(await classifyJson(jsonPath, videoPath, true), candidate, config, signal)
    if (mode === 'json') {
      const reason = 'No job file for this video (cut it first or process it whole)'
      return { kind: 'skip', item: { path: videoPath, reason, movedTo: null }, bucket: 'invalid', videoCounted: true }
    }
  }
  return wholeVideo(videoPath, config)
}

function wholeVideo(videoPath: string, config: RunConfig): Outcome {
  try {
    const job = createVideoJob(videoPath, { times: [], ...config.jobDefaults })
    return { kind: 'job', draft: { videoPath, jsonPath: null, job, warnings: [] } }
  } catch (error) {
    const reason = `Invalid conversion settings: ${messageOf(error)}`
    return { kind: 'skip', item: { path: videoPath, reason, movedTo: null }, bucket: 'invalid', videoCounted: true }
  }
}

/** Port of `scanJsonFile`: empty, then orphan, then parse. */
async function classifyJson(jsonPath: string, videoPath: string, videoExists: boolean | null): Promise<JsonClass> {
  const info = await stat(jsonPath)
  if (!info.isFile()) return { kind: 'invalid', reason: 'The job file is not a regular file' }
  const empty: JsonClass = { kind: 'empty', reason: 'The job file is empty' }
  if (info.size === 0) return empty
  if (!(videoExists ?? (await isFile(videoPath)))) {
    return { kind: 'orphan', reason: 'The video of this job file is missing' }
  }
  const text = await readFile(jsonPath, 'utf8')
  if (text.trim() === '') return empty
  const parsed = parseVideoJobText(text, { videoPath })
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.error }
  return { kind: 'job', draft: { videoPath, jsonPath, job: parsed.job, warnings: parsed.warnings } }
}

async function fromJson(
  result: JsonClass,
  candidate: Candidate,
  config: RunConfig,
  signal: AbortSignal | undefined
): Promise<Outcome> {
  if (result.kind === 'job') return { kind: 'job', draft: result.draft }
  const jsonPath = candidate.kind === 'json' ? candidate.jsonPath : `${candidate.videoPath}.json`
  const videoCounted = result.kind !== 'orphan'
  if (result.kind === 'invalid') {
    const reason = `Invalid job file: ${result.reason}`
    return { kind: 'skip', item: { path: jsonPath, reason, movedTo: null }, bucket: 'invalid', videoCounted }
  }
  const item = await moveAsideIfAllowed(jsonPath, candidate.videoPath, result.reason, config, signal)
  return { kind: 'skip', item, bucket: 'invalid', videoCounted }
}

async function moveAsideIfAllowed(
  jsonPath: string,
  videoPath: string,
  reason: string,
  config: RunConfig,
  signal: AbortSignal | undefined
): Promise<SkippedItem> {
  if (!config.moveOrphans || config.dryRun || config.listOnly || signal?.aborted) return { path: jsonPath, reason, movedTo: null }
  try {
    const root = rootOfVideo(videoPath, DEFAULTS.customFolder)
    return { path: jsonPath, reason, movedTo: await moveAside(jsonPath, root, DEFAULTS.ruimFolder) }
  } catch (error) {
    return { path: jsonPath, reason: `${reason}; it could not be moved aside: ${messageOf(error)}`, movedTo: null }
  }
}

/** Moves `source` into `<root>/<folder>/`, picking a free name; never replaces a file. */
export async function moveAside(source: string, root: string, folder: string): Promise<string> {
  const destDir = path.join(root, folder)
  await mkdir(destDir, { recursive: true })
  const name = path.basename(source)
  for (let n = 0; n < 1000; n += 1) {
    const target = path.join(destDir, collisionName(name, n))
    try {
      await moveExclusive(source, target)
      return target
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }
  }
  throw new Error(`No free name for ${name} in ${destDir}`)
}

async function checkAlreadyDone(draft: Draft, config: RunConfig, ledger: StateLedger | undefined): Promise<Outcome> {
  const done = (reason: string): Outcome => ({
    kind: 'skip',
    item: { path: draft.videoPath, reason, movedTo: null },
    bucket: 'done',
    videoCounted: true
  })
  if (ledger !== undefined) {
    const info = await stat(draft.videoPath)
    if (ledger.isDone(draft.videoPath, info.size, info.mtimeMs)) return done('already converted (state file; use --no-state to convert it again)')
  }
  if (config.existing === 'skip' && (await outputsExist(draft, config.minOutputBytes))) {
    return done('outputs already exist')
  }
  return { kind: 'job', draft }
}

async function outputsExist(draft: Draft, minBytes: number): Promise<boolean> {
  for (const output of expectedOutputNames(draft.job, draft.videoPath)) {
    try {
      const info = await stat(output)
      if (!info.isFile() || info.size < minBytes) return false
    } catch {
      return false
    }
  }
  return true
}

/** Maps with at most `limit` calls in flight; results keep the input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
