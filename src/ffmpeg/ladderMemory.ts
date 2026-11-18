/**
 * Run-wide memory of the attempt ladder: an (encoder, hwaccel) pair that failed `threshold` times
 * without a single success in this run is skipped for the next jobs (e.g. no NVIDIA GPU would
 * otherwise cost every one of 50k videos several failed attempts). The strategy is ignored.
 */
import type { Attempt, LadderMemory } from '../types.js'

export function createLadderMemory(threshold = 3): LadderMemory {
  const failures = new Map<string, number>()
  const successes = new Set<string>()
  const key = (a: Attempt): string => `${a.encoder}|${a.hwaccel ? 'hw' : 'sw'}`
  return {
    shouldSkip: (a) => !successes.has(key(a)) && (failures.get(key(a)) ?? 0) >= threshold,
    record: (a, ok) => {
      if (ok) successes.add(key(a))
      else failures.set(key(a), (failures.get(key(a)) ?? 0) + 1)
    }
  }
}
