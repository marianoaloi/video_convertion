import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { describe, it } from 'node:test'
import { LogSink, MAX_BUFFERED_BYTES } from '../../src/jobs/logSink.js'
import { StderrLimiter } from '../../src/jobs/stderrLimit.js'

describe('StderrLimiter', () => {
  it('forwards at most max lines, collapses repeats, then notes the suppressed ones', () => {
    const out: string[] = []
    const limiter = new StderrLimiter((l) => out.push(l), 3)
    for (const line of ['a', 'a', 'a', 'b', 'c', 'd', 'e', 'f']) limiter.push(line)
    limiter.finish()
    assert.deepEqual(out, ['a', '(last line repeated 2 times)', 'b', 'c', '… 3 more ffmpeg lines suppressed'])
  })

  it('a trailing repeat is flushed on finish', () => {
    const out: string[] = []
    const limiter = new StderrLimiter((l) => out.push(l))
    limiter.push('x')
    limiter.push('x')
    limiter.finish()
    assert.deepEqual(out, ['x', '(last line repeated 1 times)'])
  })
})

/** A stream that stays full until the test releases its writes one by one. */
class SlowStream extends Writable {
  readonly chunks: string[] = []
  private pending: (() => void)[] = []

  constructor() {
    super({ highWaterMark: 16 })
  }

  override _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString())
    this.pending.push(callback)
  }

  async flushAll(): Promise<void> {
    while (this.pending.length > 0) {
      this.pending.shift()?.()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

describe('LogSink backpressure', () => {
  it('buffers while the stream is full, drops beyond ~1 MiB and reports the drop', async () => {
    const stream = new SlowStream()
    const sink = new LogSink(stream)
    const line = `${'x'.repeat(1000)}\n`
    const count = Math.ceil(MAX_BUFFERED_BYTES / line.length) + 50
    for (let i = 0; i < count; i += 1) sink.write(line)
    const ending = sink.end()
    for (let round = 0; round < 3; round += 1) {
      await stream.flushAll()
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await ending
    const text = stream.chunks.join('')
    assert.match(text, /\[vconv\] \d+ log lines dropped\n$/)
    const written = text.split('\n').filter((l) => l.startsWith('xxx')).length
    assert.ok(written < count, `written ${written} of ${count}`)
    assert.ok(written >= MAX_BUFFERED_BYTES / line.length - 5, `written ${written}`)
  })

  it('writes everything when the stream keeps up', async () => {
    const chunks: string[] = []
    const sink = new LogSink(
      new Writable({
        write: (chunk, _encoding, callback) => {
          chunks.push(String(chunk))
          callback()
        }
      })
    )
    for (let i = 0; i < 100; i += 1) sink.write(`line ${i}\n`)
    await sink.end()
    assert.equal(chunks.join('').split('\n').length, 101)
  })
})
