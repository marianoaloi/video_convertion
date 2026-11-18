import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVideoJob } from '../../src/core/videoJob.js'
import { runQueue } from '../../src/jobs/queue.js'
import type { ExecHandle, ExecOutcome, PlannedJob, RunEvent } from '../../src/types.js'

function planned(count: number): PlannedJob[] {
  return Array.from({ length: count }, (_, i) => {
    const videoPath = `/v/${i + 1}.mp4`
    return {
      id: i + 1,
      videoPath,
      jsonPath: null,
      job: createVideoJob(videoPath, { times: [] }),
      warnings: [],
      root: '/v',
      expectedOutputs: [`${videoPath}.0.mp4`]
    }
  })
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))
const types = (events: RunEvent[], id: number): string[] =>
  events
    .filter((e) => 'jobId' in e && e.jobId === id && e.type !== 'log' && e.type !== 'progress')
    .map((e) => e.type)

describe('runQueue', () => {
  it('honours the concurrency limit and emits ordered events + counters', async () => {
    const events: RunEvent[] = []
    let active = 0
    let peak = 0
    const { done } = runQueue(planned(6), {
      parallel: 2,
      skipped: 3,
      emit: (e) => events.push(e),
      execute: async (job): Promise<ExecOutcome> => {
        active += 1
        peak = Math.max(peak, active)
        await tick()
        active -= 1
        return { kind: 'done', outputs: [`${job.videoPath}.0.mp4`] }
      }
    })
    const summary = await done
    assert.equal(peak, 2)
    assert.deepEqual(summary.counters, { total: 6, queued: 0, processing: 0, done: 6, failed: 0, cancelled: 0, skipped: 3 })
    assert.equal(summary.outputs.length, 6)
    assert.equal(summary.interrupted, false)
    assert.deepEqual(types(events, 1), ['started', 'done'])
    assert.equal(events.at(-1)?.type, 'finished')
    const counters = events.filter((e) => e.type === 'counters')
    assert.ok(counters.length >= 12)
    assert.equal(counters[0]?.type === 'counters' && counters[0].counters.queued, 6)
  })

  it('a worker survives an exception, and a failure is recorded', async () => {
    const events: RunEvent[] = []
    const { done } = runQueue(planned(3), {
      parallel: 1,
      skipped: 0,
      emit: (e) => events.push(e),
      execute: async (job, handle) => {
        handle.setLogPath('/x.log')
        if (job.id === 1) throw new Error('boom')
        if (job.id === 2) return { kind: 'error', message: 'bad' }
        return { kind: 'done', outputs: ['o'] }
      }
    })
    const summary = await done
    assert.equal(summary.counters.failed, 2)
    assert.equal(summary.counters.done, 1)
    assert.deepEqual(summary.failures.map((f) => f.message), ['boom', 'bad'])
    assert.equal(summary.failures[0]?.logPath, '/x.log')
  })

  it('stopLaunching cancels only the queued jobs and lets the running one finish', async () => {
    const events: RunEvent[] = []
    const g = gate()
    const run = runQueue(planned(4), {
      parallel: 1,
      skipped: 0,
      emit: (e) => events.push(e),
      execute: async () => {
        await g.promise
        return { kind: 'done', outputs: ['o'] }
      }
    })
    await tick()
    run.controller.stopLaunching()
    g.open()
    const summary = await run.done
    assert.equal(summary.counters.done, 1)
    assert.equal(summary.counters.cancelled, 3)
    assert.equal(summary.interrupted, true)
    assert.deepEqual(types(events, 3), ['cancelled'])
  })

  it('stopLaunching before the first job starts cancels everything', async () => {
    let executed = 0
    const run = runQueue(planned(3), {
      parallel: 2,
      skipped: 0,
      emit: () => undefined,
      execute: async () => {
        executed += 1
        return { kind: 'done', outputs: [] }
      }
    })
    run.controller.stopLaunching()
    const summary = await run.done
    assert.equal(executed, 0)
    assert.equal(summary.counters.cancelled, 3)
  })

  it('abortAll aborts the running jobs too', async () => {
    const run = runQueue(planned(3), {
      parallel: 2,
      skipped: 0,
      emit: () => undefined,
      execute: (_job, handle: ExecHandle) =>
        new Promise<ExecOutcome>((resolve) => {
          handle.signal.addEventListener('abort', () => resolve({ kind: 'error', message: 'killed' }))
        })
    })
    await tick()
    run.controller.abortAll()
    const summary = await run.done
    assert.equal(summary.counters.cancelled, 3)
    assert.equal(summary.counters.failed, 0)
    assert.equal(summary.interrupted, true)
  })

  it('afterDone runs inside the slot, may change the outputs, and its errors are logged', async () => {
    const events: RunEvent[] = []
    let active = 0
    let peak = 0
    const { done } = runQueue(planned(4), {
      parallel: 1,
      skipped: 0,
      emit: (e) => events.push(e),
      execute: async () => {
        active += 1
        peak = Math.max(peak, active)
        return { kind: 'done', outputs: ['a'] }
      },
      afterDone: async (job) => {
        await tick()
        active -= 1
        if (job.id === 2) throw new Error('post failed')
        return ['renamed']
      }
    })
    const summary = await done
    assert.equal(peak, 1)
    assert.equal(summary.counters.done, 4)
    assert.deepEqual(summary.outputs, ['renamed', 'a', 'renamed', 'renamed'])
    assert.ok(events.some((e) => e.type === 'log' && e.level === 'warn' && /post failed/.test(e.line)))
  })

  it('throttles progress but always emits 1', async () => {
    const events: RunEvent[] = []
    let clock = 0
    const { done } = runQueue(planned(1), {
      parallel: 1,
      skipped: 0,
      now: () => clock,
      progressIntervalMs: 250,
      emit: (e) => events.push(e),
      execute: async (_job, handle) => {
        for (const progress of [0.1, 0.2, 0.3, 0.5, 1]) {
          handle.progress({ progress, stepIndex: 0, stepCount: 1, outTimeMs: null, speed: null })
          clock += 100
        }
        return { kind: 'done', outputs: [] }
      }
    })
    await done
    const progress = events.flatMap((e) => (e.type === 'progress' ? [e.progress] : []))
    assert.deepEqual(progress, [0.1, 0.5, 1])
  })

  it('onAllSettled gets the done jobs; zero jobs finish immediately', async () => {
    let seen = 0
    const run = runQueue(planned(3), {
      parallel: 2,
      skipped: 0,
      emit: () => undefined,
      execute: async (job) => (job.id === 2 ? { kind: 'error', message: 'x' } : { kind: 'done', outputs: [`o${job.id}`] }),
      onAllSettled: async (list, log) => {
        seen = list.length
        log('batch line')
      }
    })
    await run.done
    assert.equal(seen, 2)
    const empty = await runQueue([], { parallel: 2, skipped: 1, emit: () => undefined, execute: async () => ({ kind: 'cancelled' }) }).done
    assert.equal(empty.counters.total, 0)
    assert.equal(empty.counters.skipped, 1)
  })

  it('caps the per-job log lines kept in memory', async () => {
    let kept = 0
    const { done } = runQueue(planned(1), {
      parallel: 1,
      skipped: 0,
      emit: () => undefined,
      execute: async (_job, handle) => {
        for (let i = 0; i < 6000; i += 1) handle.log(`line ${i}`)
        kept = handle.lines().length
        return { kind: 'done', outputs: [] }
      }
    })
    await done
    assert.equal(kept, 5000)
  })

  it('a throwing emit (reporter or log writer) cannot kill a worker', async () => {
    let executed = 0
    const { done } = runQueue(planned(6), {
      parallel: 2,
      skipped: 0,
      emit: (e) => {
        if (e.type !== 'finished') throw new Error('reporter exploded')
      },
      execute: async (_job, handle) => {
        executed += 1
        handle.log('hello')
        handle.progress({ progress: 1, stepIndex: 0, stepCount: 1, outTimeMs: null, speed: null })
        return { kind: 'done', outputs: ['o'] }
      },
      afterDone: async (_job, _outputs, handle) => {
        handle.log('post')
      }
    })
    const summary = await done
    assert.equal(executed, 6)
    assert.equal(summary.counters.done, 6)
    assert.equal(summary.counters.processing, 0)
  })
})
