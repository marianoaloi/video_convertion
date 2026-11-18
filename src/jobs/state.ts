/**
 * Resume ledger: JSON Lines, append-only (one `appendFile` per record so a crash loses nothing).
 * A video is "done" when its path+size+mtime matches a recorded source OR a recorded output (after
 * delete-original + rename the converted file sits at the source path and must not be redone).
 */
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { isNotFound, pathKey } from './paths.js'

export interface Fingerprint {
  readonly size: number
  readonly mtimeMs: number
}

export interface StateLedger {
  isDone(videoPath: string, size: number, mtimeMs: number): boolean
  recordDone(videoPath: string, source: Fingerprint, outputs: readonly string[]): Promise<void>
  recordFailed(videoPath: string, message: string): Promise<void>
  /** Number of distinct paths known as done (sources and outputs). */
  readonly size: number
  /** Resolves when every queued append reached the disk. */
  close(): Promise<void>
}

interface OutputRecord extends Fingerprint {
  readonly path: string
}

function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.size === b.size && Math.abs(a.mtimeMs - b.mtimeMs) < 1
}

function isFingerprint(value: unknown): value is Fingerprint {
  if (typeof value !== 'object' || value === null) return false
  return typeof Reflect.get(value, 'size') === 'number' && typeof Reflect.get(value, 'mtimeMs') === 'number'
}

function parseOutputs(value: unknown): OutputRecord[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (v): v is OutputRecord => isFingerprint(v) && typeof Reflect.get(v, 'path') === 'string'
  )
}

class FileLedger implements StateLedger {
  private readonly known = new Map<string, Fingerprint[]>()
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  get size(): number {
    return this.known.size
  }

  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isNotFound(error)) return
      throw error
    }
    for (const line of text.split('\n')) this.ingest(line)
  }

  private ingest(line: string): void {
    if (line.trim() === '') return
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      return
    }
    if (typeof record !== 'object' || record === null || Reflect.get(record, 't') !== 'done') return
    const videoPath = Reflect.get(record, 'path')
    if (typeof videoPath === 'string' && isFingerprint(record)) this.remember(videoPath, record)
    for (const out of parseOutputs(Reflect.get(record, 'outputs'))) this.remember(out.path, out)
  }

  private remember(target: string, fp: Fingerprint): void {
    const key = pathKey(target)
    const list = this.known.get(key) ?? []
    if (!list.some((e) => sameFingerprint(e, fp))) list.push({ size: fp.size, mtimeMs: fp.mtimeMs })
    this.known.set(key, list)
  }

  isDone(videoPath: string, size: number, mtimeMs: number): boolean {
    const list = this.known.get(pathKey(videoPath))
    return list?.some((e) => sameFingerprint(e, { size, mtimeMs })) ?? false
  }

  async recordDone(videoPath: string, source: Fingerprint, outputs: readonly string[]): Promise<void> {
    const stats: OutputRecord[] = []
    for (const out of outputs) {
      try {
        const info = await stat(out)
        stats.push({ path: out, size: info.size, mtimeMs: info.mtimeMs })
      } catch {
        // an output that vanished is not recorded
      }
    }
    this.remember(videoPath, source)
    for (const out of stats) this.remember(out.path, out)
    await this.append({
      t: 'done',
      path: videoPath,
      size: source.size,
      mtimeMs: source.mtimeMs,
      outputs: stats,
      at: new Date().toISOString()
    })
  }

  recordFailed(videoPath: string, message: string): Promise<void> {
    return this.append({ t: 'failed', path: videoPath, message, at: new Date().toISOString() })
  }

  private append(record: object): Promise<void> {
    const line = `${JSON.stringify(record)}\n`
    const next = this.chain.then(() => appendFile(this.file, line, 'utf8'))
    this.chain = next.catch(() => undefined)
    return next
  }

  close(): Promise<void> {
    return this.chain
  }
}

export async function openStateLedger(file: string): Promise<StateLedger> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true })
  const ledger = new FileLedger(file)
  await ledger.load()
  return ledger
}
