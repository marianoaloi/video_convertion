/**
 * Can ffmpeg run detached (own console process group) on this machine? Detached children do not
 * receive the console's Ctrl+C, so the CLI's first Ctrl+C can let running conversions finish.
 * On win32 some launchers (console shims) lose their stdout/stderr when detached, so it is probed.
 */
import type { SpawnPolicy } from '../types.js'
import { runProcess } from './process.js'

const PROBE_TIMEOUT_MS = 10_000

export async function detectConsoleIsolation(ffmpegPath: string): Promise<SpawnPolicy> {
  if (process.platform !== 'win32') return { detached: true }
  const result = await runProcess({
    command: ffmpegPath,
    args: ['-hide_banner', '-version'],
    detached: true,
    timeoutMs: PROBE_TIMEOUT_MS
  })
  const works = result.status === 'exited' && result.exitCode === 0 && result.stdout.trim().length > 0
  return { detached: works }
}
