/** Tiny vitest-style `expect` over `node:assert/strict`, so the app's tests port unchanged. */
import assert from 'node:assert/strict'

interface Matchers {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toBeNull(): void
  toBeTruthy(): void
  toContain(item: unknown): void
  toHaveLength(length: number): void
  toMatchObject(expected: Record<string, unknown>): void
  toBeGreaterThanOrEqual(min: number): void
  toThrow(expected?: RegExp | (new (...args: never[]) => Error)): void
}

function matchSubset(actual: unknown, expected: unknown, label: string): void {
  if (typeof expected === 'object' && expected !== null && !Array.isArray(expected)) {
    assert.ok(typeof actual === 'object' && actual !== null, `${label}: expected an object`)
    for (const [key, value] of Object.entries(expected)) {
      matchSubset((actual as Record<string, unknown>)[key], value, `${label}.${key}`)
    }
    return
  }
  assert.deepEqual(actual, expected, label)
}

function make(actual: unknown, message: string | undefined, negate: boolean): Matchers {
  const check = (ok: boolean, text: string): void => {
    assert.ok(negate ? !ok : ok, `${message === undefined ? '' : `${message}: `}${negate ? 'not ' : ''}${text}`)
  }
  const same = (expected: unknown, strict: boolean): boolean => {
    try {
      if (strict) assert.strictEqual(actual, expected)
      else assert.deepStrictEqual(actual, expected)
      return true
    } catch {
      return false
    }
  }
  return {
    toBe: (expected) => check(same(expected, true), `${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`),
    toEqual: (expected) => {
      if (!negate) assert.deepStrictEqual(actual, expected, message)
      else check(same(expected, false), 'equal')
    },
    toBeNull: () => check(actual === null, `${JSON.stringify(actual)} to be null`),
    toBeTruthy: () => check(Boolean(actual), `${JSON.stringify(actual)} to be truthy`),
    toContain: (item) => {
      const has = typeof actual === 'string' ? actual.includes(item as string) : (actual as unknown[]).includes(item)
      check(has, `${JSON.stringify(actual)} to contain ${JSON.stringify(item)}`)
    },
    toHaveLength: (length) => check((actual as { length: number }).length === length, `length ${(actual as { length: number }).length} to be ${length}`),
    toMatchObject: (expected) => {
      if (!negate) return matchSubset(actual, expected, message ?? 'value')
      assert.throws(() => matchSubset(actual, expected, 'value'))
    },
    toBeGreaterThanOrEqual: (min) => check((actual as number) >= min, `${String(actual)} >= ${min}`),
    toThrow: (expected) => {
      assert.ok(!negate, 'negated toThrow is not supported')
      assert.throws(actual as () => unknown, expected as RegExp)
    }
  }
}

export function expect(actual: unknown, message?: string): Matchers & { not: Matchers } {
  return { ...make(actual, message, false), not: make(actual, message, true) }
}
