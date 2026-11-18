/**
 * A log-file writer that honours stream backpressure: while the stream is full it buffers up to
 * ~1 MiB, then drops lines and writes `[vconv] N log lines dropped` once the stream drains.
 */
import type { Writable } from 'node:stream'

export const MAX_BUFFERED_BYTES = 1024 * 1024

export class LogSink {
  private buffer: string[] = []
  private bytes = 0
  private dropped = 0
  private waiting = false
  private broken = false
  private waiters: (() => void)[] = []

  constructor(private readonly stream: Writable) {
    stream.on('error', () => {
      this.broken = true
      this.buffer = []
      this.settle()
    })
  }

  write(text: string): void {
    if (this.broken) return
    if (this.waiting) {
      this.enqueue(text)
      return
    }
    this.push(text)
  }

  private enqueue(text: string): void {
    if (this.bytes + text.length > MAX_BUFFERED_BYTES) {
      this.dropped += 1
      return
    }
    this.buffer.push(text)
    this.bytes += text.length
  }

  private push(text: string): void {
    if (this.stream.write(text)) return
    this.waiting = true
    this.stream.once('drain', () => {
      this.onDrain()
    })
  }

  private onDrain(): void {
    this.waiting = false
    if (this.dropped > 0) {
      this.buffer.push(`[vconv] ${this.dropped} log lines dropped\n`)
      this.dropped = 0
    }
    while (this.buffer.length > 0 && !this.waiting && !this.broken) {
      const text = this.buffer.shift() as string
      this.bytes -= text.length
      this.push(text)
    }
    if (!this.waiting) this.settle()
  }

  private settle(): void {
    const waiters = this.waiters
    this.waiters = []
    for (const resolve of waiters) resolve()
  }

  /** Flushes what is buffered (waiting for the stream when needed) and closes the stream. */
  async end(): Promise<void> {
    while (this.waiting && !this.broken) await new Promise<void>((resolve) => this.waiters.push(resolve))
    if (this.dropped > 0 && !this.broken) this.push(`[vconv] ${this.dropped} log lines dropped\n`)
    if (this.broken) return
    await new Promise<void>((resolve) => {
      this.stream.once('error', () => {
        resolve()
      })
      this.stream.end(() => {
        resolve()
      })
    })
  }
}
