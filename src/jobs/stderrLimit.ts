/**
 * Caps the ffmpeg stderr lines forwarded to the log of one job step: at most `max` lines,
 * exact consecutive repeats collapsed into `(last line repeated N times)`, then a single
 * `… N more ffmpeg lines suppressed` note. Memory stays O(1) per step.
 */
export class StderrLimiter {
  private forwarded = 0
  private suppressed = 0
  private last: string | null = null
  private repeats = 0

  constructor(
    private readonly forward: (line: string) => void,
    private readonly max = 200
  ) {}

  push(line: string): void {
    if (this.last !== null && line === this.last) {
      this.repeats += 1
      return
    }
    this.flushRepeats()
    if (this.forwarded >= this.max) {
      this.suppressed += 1
      this.last = null
      return
    }
    this.forwarded += 1
    this.last = line
    this.forward(line)
  }

  /** Call when the step ends: emits the pending repeat and suppression notes. */
  finish(): void {
    this.flushRepeats()
    if (this.suppressed > 0) {
      this.forward(`… ${this.suppressed} more ffmpeg lines suppressed`)
      this.suppressed = 0
    }
  }

  private flushRepeats(): void {
    if (this.repeats > 0) {
      this.forward(`(last line repeated ${this.repeats} times)`)
      this.repeats = 0
    }
  }
}
