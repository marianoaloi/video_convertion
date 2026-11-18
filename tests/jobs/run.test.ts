import assert from 'node:assert/strict'
import { access, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { parseCommandTemplate } from '../../src/core/template.js'
import { runHook } from '../../src/jobs/hooks.js'
import { lockPathFor } from '../../src/jobs/lock.js'
import { startRun, type RunDeps } from '../../src/jobs/run.js'
import type { RunEvent } from '../../src/types.js'
import { fakeMedia, makeConfig, makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)
const tools = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }

const fakes: Partial<RunDeps> = {
  probe: async () => fakeMedia(5000),
  stepExecutor: () => async (request) => {
    await write(request.argv[request.argv.length - 2] as string, 'n'.repeat(5000))
    return { status: 'exited', exitCode: 0 }
  }
}

describe('startRun with fakes', () => {
  it('skips a video locked by another live vconv, converts the rest, and cleans up its own locks', async () => {
    const a = await write(path.join(tmp.dir, 'a.mp4'))
    const b = await write(path.join(tmp.dir, 'b.mp4'))
    await writeFile(lockPathFor(a), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }))
    const events: RunEvent[] = []
    const summary = await startRun(makeConfig({ inputs: [tmp.dir] }), tools, (e) => events.push(e), fakes).done
    assert.equal(summary.counters.done, 1)
    assert.equal(summary.counters.cancelled, 1)
    assert.ok(await exists(`${b}.0.mp4`))
    assert.ok(!(await exists(`${a}.0.mp4`)))
    assert.ok(!(await exists(lockPathFor(b))))
    assert.ok(await exists(lockPathFor(a)), 'the other instance lock is left alone')
    assert.ok(events.some((e) => e.type === 'log' && e.level === 'warn' && /being converted by another vconv/.test(e.line)))
  })

  it('takes no locks in a dry run or list-only', async () => {
    const a = await write(path.join(tmp.dir, 'a.mp4'))
    await writeFile(lockPathFor(a), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: Date.now() }))
    const listed = await startRun(makeConfig({ inputs: [tmp.dir], listOnly: true }), tools, () => undefined, fakes).done
    assert.equal(listed.counters.total, 1)
    const dry = await startRun(makeConfig({ inputs: [tmp.dir], dryRun: true }), tools, () => undefined, fakes).done
    assert.equal(dry.counters.cancelled, 0)
  })

  it('Ctrl+C during the scan: no jobs, interrupted', async () => {
    await write(path.join(tmp.dir, 'a.mp4'))
    const run = startRun(makeConfig({ inputs: [tmp.dir] }), tools, () => undefined, fakes)
    run.controller.stopLaunching()
    const summary = await run.done
    assert.equal(summary.interrupted, true)
    assert.equal(summary.counters.total, 0)
    assert.equal(summary.counters.done, 0)
  })

  it('a throwing reporter does not break the run', async () => {
    await write(path.join(tmp.dir, 'a.mp4'))
    await write(path.join(tmp.dir, 'b.mp4'))
    const summary = await startRun(
      makeConfig({ inputs: [tmp.dir] }),
      tools,
      (e) => {
        if (e.type !== 'finished') throw new Error('boom')
      },
      fakes
    ).done
    assert.equal(summary.counters.done, 2)
  })

  it('writes the log file', async () => {
    await write(path.join(tmp.dir, 'a.mp4'))
    const logFile = path.join(tmp.dir, 'out', 'run.log')
    await startRun(makeConfig({ inputs: [tmp.dir], logFile }), tools, () => undefined, fakes).done
    assert.match(await readFile(logFile, 'utf8'), /\[#1 a\.mp4\] done:/)
  })
})

describe('runHook', () => {
  const node = process.execPath

  it('logs the command name and argument count, never the arguments (they may hold secrets)', async () => {
    const lines: { line: string; level?: string }[] = []
    const template = parseCommandTemplate(`"${node}" -e "process.exit(0)" SECRET-TOKEN`)
    const outcome = await runHook(template, {}, (line, level) => lines.push({ line, level }))
    assert.equal(outcome, 'ok')
    const visible = lines.filter((l) => l.level !== 'stderr').map((l) => l.line).join('\n')
    assert.ok(!visible.includes('SECRET-TOKEN'))
    assert.match(visible, /Running upload hook: node(\.exe)? \((3 arguments)\)/)
    assert.ok(lines.some((l) => l.level === 'stderr' && l.line.includes('SECRET-TOKEN')))
  })

  it('a hook that runs past the timeout is failed', async () => {
    const lines: string[] = []
    const template = parseCommandTemplate(`"${node}" -e "setTimeout(Boolean, 10000)"`)
    const started = Date.now()
    const outcome = await runHook(template, {}, (line) => lines.push(line), { timeoutMs: 300 })
    assert.equal(outcome, 'failed')
    assert.ok(Date.now() - started < 8000)
    assert.ok(lines.some((l) => /timed out/.test(l)))
  })

  it('a non-zero exit and a missing command are failed, never thrown', async () => {
    assert.equal(await runHook(parseCommandTemplate(`"${node}" -e "process.exit(3)"`), {}, () => undefined), 'failed')
    assert.equal(await runHook({ command: 'definitely-not-a-command-xyz', args: [] }, {}, () => undefined), 'failed')
  })
})
