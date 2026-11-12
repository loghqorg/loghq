import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatAllowance, FREE_LOG_LINES_PER_MONTH, FREE_RETENTION_DAYS, logLinesPerMonth, retentionDays } from '../../app/Billing/plans'
import { createPlanResolver } from '../../app/Billing/pro'

const ROOT = join(import.meta.dir, '..', '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

describe('plan limits', () => {
  test('free is 10,000 lines and 30 days; pro is unlimited', () => {
    expect(logLinesPerMonth(false)).toBe(10_000)
    expect(retentionDays(false)).toBe(30)
    expect(logLinesPerMonth(true)).toBeNull()
    expect(retentionDays(true)).toBeNull()
    expect(formatAllowance(FREE_LOG_LINES_PER_MONTH)).toBe('10,000')
  })

  test('the pricing page prints the limits file instead of restating it', () => {
    const pricing = read('resources/views/pricing.stx')
    expect(pricing).toContain('app/Billing/plans')
    expect(pricing).toContain('{{ freeLines }} log lines / mo')
    expect(pricing).toContain('{{ freeRetention }}-day retention')
    // The numbers themselves appear nowhere in the page.
    expect(pricing).not.toMatch(/10,000|10k|5k/)
    // LogHQ meters log lines. "errors" was copy inherited from the error tracker.
    expect(pricing).not.toMatch(/\berrors\b/i)
  })

  test('the archive hot window defaults to the same retention', () => {
    expect(read('app/Archive/config.ts')).toContain('num(env.ARCHIVE_HOT_WINDOW_DAYS, FREE_RETENTION_DAYS)')
    expect(FREE_RETENTION_DAYS).toBe(30)
  })
})

describe('plan resolver', () => {
  function setup(answers: Record<number, boolean | Error>) {
    const clock = { at: 0 }
    const calls: number[] = []
    const resolver = createPlanResolver({
      now: () => clock.at,
      onError: () => {},
      lookup: async (id) => {
        calls.push(id)
        const answer = answers[id]
        if (answer instanceof Error || answer === undefined)
          throw answer ?? new Error('no such user')
        return answer
      },
    })
    return { resolver, clock, calls, answers }
  }

  test('caches a verdict so the ingest does not query per request', async () => {
    const { resolver, calls } = setup({ 1: true })
    expect(await resolver.isPro(1)).toBe(true)
    expect(await resolver.isPro(1)).toBe(true)
    expect(calls).toEqual([1])
  })

  test('re-checks a free account sooner than a paid one', async () => {
    const { resolver, clock, calls, answers } = setup({ 1: false })
    expect(await resolver.isPro(1)).toBe(false)
    answers[1] = true
    clock.at += 10_001
    expect(await resolver.isPro(1)).toBe(true)
    expect(calls).toHaveLength(2)
  })

  test('a failed lookup answers the last known plan', async () => {
    const { resolver, clock, answers } = setup({ 1: true })
    expect(await resolver.isPro(1)).toBe(true)
    answers[1] = new Error('database is locked')
    clock.at += 120_000
    expect(await resolver.isPro(1)).toBe(true)
  })

  test('a failed lookup with nothing known is free, never unlimited', async () => {
    const { resolver } = setup({ 1: new Error('database is locked') })
    expect(await resolver.isPro(1)).toBe(false)
  })

  test('a project with no owner has nobody to bill', async () => {
    const { resolver, calls } = setup({})
    expect(await resolver.isPro(null)).toBe(true)
    expect(calls).toEqual([])
  })

  test('known() never guesses: a failed lookup is null, not free', async () => {
    const { resolver, answers } = setup({ 1: false, 2: true })
    expect(await resolver.known(1)).toBe(false)
    expect(await resolver.known(2)).toBe(true)
    answers[1] = new Error('database is locked')
    expect(await resolver.known(1)).toBeNull()
    expect(await resolver.known(null)).toBeNull()
  })

  test('forget makes a plan change apply at once', async () => {
    const { resolver, answers } = setup({ 1: false })
    expect(await resolver.isPro(1)).toBe(false)
    answers[1] = true
    resolver.forget(1)
    expect(await resolver.isPro(1)).toBe(true)
  })
})
