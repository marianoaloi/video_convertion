/**
 * ffmpeg job runner: walks the attempt ladder, runs the builder's steps, judges every step
 * (exit 0 AND size >= minimum), cleans up failed attempts and reports progress.
 *
 * Contract: never throws for ffmpeg failures; the result says `ok`, `cancelled` or the error.
 * Every step writes `*.part.mp4`; a successful attempt renames the parts to their final names
 * without replacing an existing file, a failed one removes only its own `.part` files. After a
 * successful concat the parts go through `trashPart` (journalled by the caller) and are never
 * deleted permanently.
 */
import { buildFfmpegArgs, FfmpegArgsError, partOutputs } from '../core/ffmpegArgs.js'
import { buildLadder, describeAttempt } from '../core/ladder.js'
import { overallProgress, stepFraction } from '../core/progress.js'
import type {
  Attempt,
  FfmpegJobRequest,
  FfmpegJobResult,
  FfmpegStep,
  LadderMemory,
  ProgressSample,
  StepExecutor
} from '../types.js'
import { promotePart, toPartSteps } from './outputs.js'
import { createProcessExecutor, judgeStep, removeQuietly, TailBuffer } from './steps.js'

type AttemptOutcome =
  | { readonly ok: true; readonly outputs: string[] }
  | { readonly ok: false; readonly cancelled: boolean; readonly fatal: boolean; readonly error: string }

class JobRun {
  readonly tail = new TailBuffer(60)
  private readonly executor: StepExecutor

  constructor(readonly request: FfmpegJobRequest) {
    this.executor = request.executor ?? createProcessExecutor(request.ffmpegPath)
  }

  log(line: string, source: 'info' | 'stderr' = 'info'): void {
    this.request.onLog?.(line, source)
  }

  get cancelled(): boolean {
    return this.request.signal?.aborted === true
  }

  async attempt(finalSteps: readonly FfmpegStep[]): Promise<AttemptOutcome> {
    const steps = toPartSteps(finalSteps)
    const created: string[] = []
    this.tail.clear()
    for (const [index, step] of steps.entries()) {
      this.log(`$ ffmpeg ${step.argv.join(' ')}`)
      if (this.request.dryRun === true) continue
      await removeQuietly(step.output)
      created.push(step.output)
      const failure = await this.runStep(steps, index)
      if (failure !== null) {
        await Promise.all(created.map(removeQuietly))
        return failure
      }
      if (step.kind === 'cut') await this.dropCopyBefore(steps, index)
    }
    if (this.request.dryRun === true) return { ok: true, outputs: [] }
    try {
      return { ok: true, outputs: await this.finish(finalSteps, steps) }
    } catch (error) {
      await Promise.all(created.map(removeQuietly))
      const why = error instanceof Error ? error.message : String(error)
      return { ok: false, cancelled: false, fatal: true, error: `Could not finish the outputs: ${why}` }
    }
  }

  private async runStep(
    steps: readonly FfmpegStep[],
    index: number
  ): Promise<Extract<AttemptOutcome, { ok: false }> | null> {
    const step = steps[index]
    if (step === undefined) return null
    const exit = await this.executor({
      argv: step.argv,
      ...(this.request.stallTimeoutMs === undefined ? {} : { stallTimeoutMs: this.request.stallTimeoutMs }),
      ...(this.request.signal === undefined ? {} : { signal: this.request.signal }),
      onProgress: (sample) => {
        this.emitProgress(steps, index, sample)
      },
      onStderrLine: (line) => {
        this.tail.push(line)
        this.log(line, 'stderr')
      }
    })
    if (exit.status === 'cancelled' || this.cancelled) {
      return { ok: false, cancelled: true, fatal: true, error: 'Cancelled' }
    }
    const verdict = await judgeStep(exit, step.output, this.request.minOutputBytes)
    if (verdict.ok) {
      this.report(steps.length, index, 1, null, null)
      return null
    }
    return { ok: false, cancelled: false, fatal: verdict.fatal, error: verdict.reason }
  }

  /** `copyThenCut`: the temp copy is deleted as soon as its re-encode succeeded. */
  private async dropCopyBefore(steps: readonly FfmpegStep[], index: number): Promise<void> {
    const previous = steps[index - 1]
    if (previous?.kind === 'copy') await removeQuietly(previous.output)
  }

  private async finish(finals: readonly FfmpegStep[], parts: readonly FfmpegStep[]): Promise<string[]> {
    const concat = finals.findIndex((s) => s.kind === 'concat')
    if (concat < 0) return this.promoteAll(finals, parts, (s) => s.kind === 'cut')
    const finalNames = await this.promoteAll(finals, parts, (s) => s.kind === 'concat')
    const cutParts = partOutputs(parts)
    if (this.request.keepParts !== true && this.request.trashPart !== undefined) {
      await this.trashParts(cutParts)
    } else {
      await this.promoteAll(finals, parts, (s) => s.kind === 'cut')
    }
    return finalNames
  }

  private async promoteAll(
    finals: readonly FfmpegStep[],
    parts: readonly FfmpegStep[],
    pick: (step: FfmpegStep) => boolean
  ): Promise<string[]> {
    const options = {
      log: (line: string): void => this.log(line),
      ...(this.request.trashExisting === undefined ? {} : { trashExisting: this.request.trashExisting })
    }
    const outputs: string[] = []
    for (const [index, step] of finals.entries()) {
      const part = parts[index]
      if (part === undefined || !pick(step)) continue
      outputs.push(await promotePart(part.output, step.output, options))
    }
    return outputs
  }

  private async trashParts(parts: readonly string[]): Promise<void> {
    const trash = this.request.trashPart
    if (trash === undefined) return
    for (const part of parts) {
      try {
        await trash(part)
      } catch (error) {
        this.log(`Could not trash ${part}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  private emitProgress(steps: readonly FfmpegStep[], index: number, sample: ProgressSample): void {
    const expected = steps[index]?.expectedMs ?? null
    const fraction = stepFraction(sample.outTimeMs, expected) ?? 0
    this.report(steps.length, index, fraction, sample.outTimeMs, sample.speed)
  }

  private report(
    count: number,
    index: number,
    fraction: number,
    outTimeMs: number | null,
    speed: number | null
  ): void {
    const done = fraction >= 1 ? index + 1 : index
    const within = fraction >= 1 ? 0 : fraction
    this.request.onProgress?.({
      progress: overallProgress(done, count, within),
      stepIndex: index,
      stepCount: count,
      outTimeMs,
      speed
    })
  }
}

function buildSteps(request: FfmpegJobRequest, attempt: Attempt): FfmpegStep[] {
  return buildFfmpegArgs(request.job, request.media, request.inputPath, {
    encoder: attempt.encoder,
    hwaccel: attempt.hwaccel,
    strategy: attempt.strategy,
    sameSize: request.sameSize,
    verbose: request.verbose === true,
    maxRateKbps: request.maxRateKbps,
    maxSide: request.maxSide,
    ...(request.outputBase === undefined ? {} : { outputBase: request.outputBase })
  })
}

/** Drops the rungs the memory says keep failing; never returns an empty ladder. */
function applyMemory(ladder: Attempt[], request: FfmpegJobRequest, run: JobRun): Attempt[] {
  const memory = request.ladderMemory
  if (memory === undefined) return ladder
  const kept = ladder.filter((a) => !memory.shouldSkip(a))
  if (kept.length === 0 || kept.length === ladder.length) return ladder
  const skipped = new Set<string>()
  for (const a of ladder) {
    if (!kept.includes(a)) skipped.add(`${a.encoder} + ${a.hwaccel ? 'GPU decode' : 'CPU decode'}`)
  }
  for (const what of skipped) run.log(`Skipping ${what}: it failed on every earlier video of this run`)
  return kept
}

/** Successes and non-fatal failures count; cancellations and fatal errors say nothing about the rung. */
function recordOutcome(memory: LadderMemory | undefined, attempt: Attempt, outcome: AttemptOutcome): void {
  if (memory === undefined) return
  if (outcome.ok) memory.record(attempt, true)
  else if (!outcome.cancelled && !outcome.fatal) memory.record(attempt, false)
}

function failed(cancelled: boolean, error: string, lastLines: string[]): FfmpegJobResult {
  return { ok: false, cancelled, error, lastLines }
}

/**
 * Runs the ladder until one attempt succeeds. A dry run logs the argv of the first attempt only
 * and touches nothing.
 */
export async function runFfmpegJob(request: FfmpegJobRequest): Promise<FfmpegJobResult> {
  const run = new JobRun(request)
  const ladder = applyMemory(buildLadder(request.encoders, request.gpu), request, run)
  let lastError = 'No encoder is configured'
  let lastLines: string[] = []
  for (const [index, attempt] of ladder.entries()) {
    if (run.cancelled) return failed(true, 'Cancelled', lastLines)
    run.log(describeAttempt(attempt, index, ladder.length))
    let steps: FfmpegStep[]
    try {
      steps = buildSteps(request, attempt)
    } catch (error) {
      if (error instanceof FfmpegArgsError) return failed(false, error.message, [])
      throw error
    }
    const outcome = await run.attempt(steps)
    if (request.dryRun !== true) recordOutcome(request.ladderMemory, attempt, outcome)
    if (outcome.ok) return { ok: true, outputs: outcome.outputs, attempt }
    if (outcome.cancelled) return failed(true, 'Cancelled', run.tail.snapshot())
    lastError = outcome.error
    lastLines = run.tail.snapshot()
    run.log(`Attempt ${index + 1} failed: ${outcome.error}`)
    if (outcome.fatal) break
  }
  return failed(false, lastError, lastLines)
}
