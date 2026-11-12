import type { UsageCounter } from '@stacksjs/hq/meter'
import { describe, expect, test } from 'bun:test'
import { createCounter, createMemoryCounterStore, droppedMeter, parseUsageHeader, USAGE_HEADER } from '@stacksjs/hq/meter'
import { admitLines } from '../../app/Billing/meter'
import { FREE_LOG_LINES_PER_MONTH, LOG_LINES_METER } from '../../app/Billing/plans'

const UPGRADE = 'https://loghq.test/pricing'
const LIMIT = FREE_LOG_LINES_PER_MONTH
const CEILING = LIMIT + LIMIT / 5

function meter(): { counter: UsageCounter, store: ReturnType<typeof createMemoryCounterStore> } {
  const store = createMemoryCounterStore()
  // No timer: a test flushes when it wants the store to see the counts.
  return { store, counter: createCounter({ store, flushMs: 0, now: () => new Date('2026-03-10T12:00:00Z') }) }
}

const free = (counter: UsageCounter, lines: number, owner: number | null = 1) => admitLines(counter, owner, false, lines, UPGRADE)
const header = (verdict: { headers: Record<string, string> }) => parseUsageHeader(verdict.headers[USAGE_HEADER])

describe('the limits file', () => {
  test('free is 10,000 log lines a month', () => {
    expect(FREE_LOG_LINES_PER_MONTH).toBe(10_000)
  })
})

describe('under the allowance', () => {
  test('every line is stored and the header reports the count', () => {
    const { counter } = meter()
    const verdict = free(counter, 3)
    expect(verdict).toMatchObject({ stored: 3, sampled: 0, keep: [true, true, true] })
    expect(header(verdict)).toEqual({ meter: LOG_LINES_METER, used: 3, limit: LIMIT, state: 'ok', upgradeUrl: UPGRADE })
  })

  test('the state turns to warn at 80%', () => {
    const { counter } = meter()
    expect(free(counter, LIMIT * 0.8 - 1).usage.state).toBe('ok')
    expect(free(counter, 1).usage).toMatchObject({ used: LIMIT * 0.8, state: 'warn' })
  })
})

describe('batch counting', () => {
  test('a batch of 50 lines is 50 against the allowance, not 1', () => {
    const { counter } = meter()
    expect(free(counter, 50).usage.used).toBe(50)
    expect(free(counter, 50).usage.used).toBe(100)
    expect(counter.usageOf(1, LOG_LINES_METER)).toBe(100)
  })

  test('the count reaches the store as lines', async () => {
    const { counter, store } = meter()
    free(counter, 50)
    free(counter, 7)
    await counter.flush()
    expect(store.totals()).toEqual([{ owner: '1', meter: LOG_LINES_METER, period: '2026-03', delta: 57 }])
  })

  test('usage is the account\'s: two owners do not share an allowance', () => {
    const { counter } = meter()
    free(counter, 500, 1)
    expect(free(counter, 20, 2).usage.used).toBe(20)
  })

  test('an empty batch decides nothing and still reports standing', () => {
    const { counter } = meter()
    free(counter, 12)
    const verdict = free(counter, 0)
    expect(verdict).toMatchObject({ stored: 0, sampled: 0, keep: [] })
    expect(header(verdict)).toMatchObject({ used: 12, limit: LIMIT, state: 'ok' })
  })
})

describe('the 100% to 120% band', () => {
  test('lines past the allowance are still stored in full', () => {
    const { counter } = meter()
    free(counter, LIMIT - 1)
    expect(free(counter, 1).usage).toMatchObject({ used: LIMIT, state: 'over' })

    const band = free(counter, CEILING - LIMIT)
    expect(band).toMatchObject({ stored: CEILING - LIMIT, sampled: 0 })
    expect(band.keep.every(Boolean)).toBe(true)
    expect(header(band)).toMatchObject({ used: CEILING, limit: LIMIT, state: 'over', upgradeUrl: UPGRADE })
  })
})

describe('past 120%', () => {
  test('one line in ten is kept', () => {
    const { counter } = meter()
    free(counter, CEILING)

    const verdict = free(counter, 100)
    expect(verdict).toMatchObject({ stored: 10, sampled: 90 })
    // Every tenth line received past the ceiling, not the first ten.
    expect(verdict.keep.map((kept, i) => kept ? i + 1 : 0).filter(Boolean)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
    expect(header(verdict)).toMatchObject({ used: CEILING + 10, limit: LIMIT, state: 'sampled' })
  })

  test('used counts what was stored, and the dropped lines are counted apart', async () => {
    const { counter, store } = meter()
    free(counter, CEILING)
    free(counter, 100)
    await counter.flush()
    const totals = Object.fromEntries(store.totals().map(total => [total.meter, total.delta]))
    expect(totals).toEqual({ [LOG_LINES_METER]: CEILING + 10, [droppedMeter(LOG_LINES_METER)]: 90 })
  })

  test('a batch that straddles the ceiling is stored up to it and sampled after', () => {
    const { counter } = meter()
    free(counter, CEILING - 5)
    const verdict = free(counter, 25)
    expect(verdict.keep.slice(0, 5)).toEqual([true, true, true, true, true])
    // 20 lines past the ceiling: the 10th and the 20th.
    expect(verdict).toMatchObject({ stored: 7, sampled: 18 })
  })

  test('sampling continues across requests instead of restarting each batch', () => {
    const { counter } = meter()
    free(counter, CEILING)
    const kept = Array.from({ length: 10 }, () => free(counter, 3).stored).reduce((a, b) => a + b, 0)
    expect(kept).toBe(3)
  })
})

describe('a paid account', () => {
  test('is never limited, and is still counted', () => {
    const { counter } = meter()
    const verdict = admitLines(counter, 9, true, CEILING + 500, UPGRADE)
    expect(verdict).toMatchObject({ stored: CEILING + 500, sampled: 0 })
    expect(header(verdict)).toEqual({ meter: LOG_LINES_METER, used: CEILING + 500, limit: null, state: 'ok', upgradeUrl: UPGRADE })
    expect(verdict.headers[USAGE_HEADER]).toContain(';unlimited;')
  })

  test('upgrading mid-month lifts sampling at once', () => {
    const { counter } = meter()
    free(counter, CEILING + 50)
    expect(admitLines(counter, 1, true, 40, UPGRADE)).toMatchObject({ stored: 40, sampled: 0 })
  })
})

describe('a project with no owner', () => {
  test('is not metered and never dropped', () => {
    const { counter } = meter()
    const verdict = free(counter, CEILING + 100, null)
    expect(verdict).toMatchObject({ stored: CEILING + 100, sampled: 0 })
    expect(header(verdict)).toMatchObject({ limit: null, state: 'ok' })
  })
})

describe('the response header', () => {
  test('is always present, so the route can always answer 2xx with it', () => {
    const { counter } = meter()
    for (const lines of [0, 1, LIMIT, CEILING, 300]) {
      const value = free(counter, lines).headers[USAGE_HEADER]
      expect(parseUsageHeader(value)).not.toBeNull()
      expect(value).toContain(`upgrade=${encodeURIComponent(UPGRADE)}`)
    }
  })
})
