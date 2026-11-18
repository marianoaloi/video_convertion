import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MAX_CAPTURE_BYTES, runProcess, taskkillPath } from '../../src/ffmpeg/process.js'

const NODE = process.execPath
const script = (code: string): string[] => ['-e', code]

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !alive(pid)
}

describe('taskkillPath', () => {
  it('is an absolute System32 path, never a bare name', () => {
    assert.equal(taskkillPath({ SystemRoot: 'D:\\WINNT' }), 'D:\\WINNT\\System32\\taskkill.exe')
    assert.equal(taskkillPath({}), 'C:\\Windows\\System32\\taskkill.exe')
  })
})

describe('runProcess', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const r = await runProcess({
      command: NODE,
      args: script('process.stdout.write("out");process.stderr.write("err");process.exit(3)')
    })
    assert.equal(r.status, 'exited')
    assert.equal(r.exitCode, 3)
    assert.equal(r.stdout, 'out')
    assert.equal(r.stderr, 'err')
  })

  it('passes arguments verbatim, never through a shell', async () => {
    const nasty = 'a b & echo pwned | "quoted" $HOME %PATH% `x`'
    const r = await runProcess({
      command: NODE,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', nasty, '--flag=1']
    })
    assert.equal(r.exitCode, 0)
    assert.deepEqual(JSON.parse(r.stdout), [nasty, '--flag=1'])
  })

  it('streams lines split on \\n, \\r\\n and lone \\r, including a partial last line', async () => {
    const lines: string[] = []
    const r = await runProcess({
      command: NODE,
      args: script('process.stdout.write("a\\nb\\r\\nc\\rd")'),
      onStdoutLine: (l) => lines.push(l)
    })
    assert.equal(r.exitCode, 0)
    assert.deepEqual(lines, ['a', 'b', 'c', 'd'])
  })

  it('streams stderr lines and can skip capturing', async () => {
    const lines: string[] = []
    const r = await runProcess({
      command: NODE,
      args: script('console.error("e1");console.error("e2")'),
      onStderrLine: (l) => lines.push(l),
      captureStderr: false
    })
    assert.deepEqual(lines, ['e1', 'e2'])
    assert.equal(r.stderr, '')
  })

  it('merges env over process.env', async () => {
    const r = await runProcess({
      command: NODE,
      args: script('process.stdout.write(process.env.VC_TEST + "|" + (process.env.PATH ? "path" : ""))'),
      env: { VC_TEST: 'x\ny' }
    })
    assert.equal(r.stdout, 'x\ny|path')
  })

  it('reports a missing executable as spawn-error with the error code', async () => {
    const r = await runProcess({ command: 'definitely-not-a-real-program-xyz', args: [] })
    assert.equal(r.status, 'spawn-error')
    assert.equal(r.error?.code, 'ENOENT')
    assert.equal(r.exitCode, null)
  })

  it('keeps only the last MAX_CAPTURE_BYTES of a chatty stream', async () => {
    const total = MAX_CAPTURE_BYTES + 5000
    const r = await runProcess({
      command: NODE,
      args: script(`process.stdout.write("a".repeat(${total - 10}) + "0123456789")`)
    })
    assert.equal(r.stdout.length, MAX_CAPTURE_BYTES)
    assert.ok(r.stdout.endsWith('0123456789'))
  })

  it('times out and kills the process', async () => {
    const started = Date.now()
    const r = await runProcess({ command: NODE, args: script('setInterval(()=>{},1000)'), timeoutMs: 300 })
    assert.equal(r.status, 'timeout')
    assert.ok(Date.now() - started < 8000)
  })

  it('does not start when the signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await runProcess({ command: NODE, args: script('process.exit(0)'), signal: ac.signal })
    assert.equal(r.status, 'cancelled')
  })

  it('cancels a long-running child and resolves cancelled', async () => {
    const ac = new AbortController()
    const started = Date.now()
    const pending = runProcess({ command: NODE, args: script('setInterval(()=>{},1000)'), signal: ac.signal })
    setTimeout(() => ac.abort(), 300)
    const r = await pending
    assert.equal(r.status, 'cancelled')
    assert.ok(Date.now() - started < 8000)
  })

  it('kills the whole process tree on abort', async () => {
    const ac = new AbortController()
    const code = `
      const { spawn } = require('node:child_process');
      const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      process.stdout.write('PID:' + c.pid + '\\n');
      setInterval(()=>{},1000);
    `
    let childPid = 0
    const r = await runProcess({
      command: NODE,
      args: script(code),
      signal: ac.signal,
      onStdoutLine: (line) => {
        const m = /^PID:(\d+)$/.exec(line)
        if (m?.[1] !== undefined) {
          childPid = Number(m[1])
          ac.abort()
        }
      }
    })
    assert.equal(r.status, 'cancelled')
    assert.ok(childPid > 0)
    assert.equal(await waitDead(childPid), true)
  })
})
