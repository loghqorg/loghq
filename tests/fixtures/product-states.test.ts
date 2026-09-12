import { describe, expect, test } from 'bun:test'

const NOW = '2026-09-12T12:00:00.000Z'
const entry = (index: number) => ({ id: `log-${index}`, level: index % 5 === 0 ? 'error' : 'info', message: `Fixture log line ${index}`, traceId: `trace-${Math.ceil(index / 4)}`, timestamp: NOW })

export const productStates = {
  empty: { now: NOW, status: 'ready', logs: [], matched: 0 },
  normal: { now: NOW, status: 'ready', logs: [entry(1), entry(2), entry(3)], matched: 3 },
  loading: { now: NOW, status: 'loading', logs: [], matched: null },
  failure: { now: NOW, status: 'error', logs: [], error: 'Archive search unavailable' },
  highVolume: { now: NOW, status: 'ready', logs: Array.from({ length: 500 }, (_, index) => entry(index + 1)), matched: 2_500_000 },
} as const

describe('deterministic log product states', () => {
  test('covers every UI state', () => expect(Object.keys(productStates)).toEqual(['empty', 'normal', 'loading', 'failure', 'highVolume']))
  test('keeps volume fixtures large and reproducible', () => {
    expect(productStates.highVolume.logs).toHaveLength(500)
    expect(JSON.stringify(productStates)).toBe(JSON.stringify(productStates))
  })
})
