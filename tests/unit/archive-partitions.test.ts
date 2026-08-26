/**
 * Partition planning: which days have aged out, and which of those need work.
 *
 * The arithmetic here decides what gets deleted from the hot database, so the
 * boundary cases are the interesting ones. An off-by-one in `cutoffDay` either
 * archives a day that is still inside the window the pricing page promises, or
 * leaves a day behind forever.
 */
import { describe, expect, test } from 'bun:test'
import {
  cutoffDay,
  dayBounds,
  dayOf,
  daysBetween,
  freePruneCutoff,
  nextDay,
  objectKeyFor,
  partitionsToExport,
  TERMINAL_STATUSES,
} from '../../app/Archive/partitions'

const NOW = new Date('2026-08-26T04:10:00.000Z')

describe('cutoffDay', () => {
  test('is the first day still inside the window', () => {
    // 30 days back from 2026-08-26. Everything before this is archivable.
    expect(cutoffDay(NOW, 30)).toBe('2026-07-27')
  })

  test('crosses a year boundary', () => {
    expect(cutoffDay(new Date('2027-01-05T00:00:00Z'), 30)).toBe('2026-12-06')
  })

  test('handles a leap year without drifting', () => {
    expect(cutoffDay(new Date('2028-03-05T00:00:00Z'), 5)).toBe('2028-02-29')
  })

  test('a zero window makes today the cutoff', () => {
    expect(cutoffDay(NOW, 0)).toBe('2026-08-26')
  })

  test('a negative window is treated as zero rather than moving the cutoff forward', () => {
    expect(cutoffDay(NOW, -10)).toBe('2026-08-26')
  })
})

describe('the cutoff works as a string comparison', () => {
  // This is the load-bearing assumption of the whole feature: log_entries
  // .timestamp is ISO-8601 text, not a timestamp column, so `timestamp < day`
  // is a string comparison that has to mean what a date comparison would.
  const cutoff = cutoffDay(NOW, 30) // 2026-07-27

  test('the last instant of the preceding day sorts before the cutoff', () => {
    expect('2026-07-26T23:59:59.999Z' < cutoff).toBe(true)
  })

  test('midnight of the cutoff day does not', () => {
    expect('2026-07-27T00:00:00.000Z' < cutoff).toBe(false)
  })
})

describe('dayBounds', () => {
  test('is half-open, so sub-second entries in the last second are included', () => {
    expect(dayBounds('2026-07-27')).toEqual({ from: '2026-07-27', to: '2026-07-28' })
  })

  test('an entry at 23:59:59.999 falls inside its own day', () => {
    const { from, to } = dayBounds('2026-07-27')
    const ts = '2026-07-27T23:59:59.999Z'
    expect(ts >= from && ts < to).toBe(true)
  })

  test('midnight belongs to the new day, not the old one', () => {
    const { to } = dayBounds('2026-07-27')
    expect('2026-07-28T00:00:00.000Z' < to).toBe(false)
  })
})

describe('nextDay and dayOf', () => {
  test('nextDay crosses months and years', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  test('dayOf takes the UTC day, not the local one', () => {
    expect(dayOf(new Date('2026-08-26T23:30:00.000Z'))).toBe('2026-08-26')
  })
})

describe('objectKeyFor', () => {
  test('uses hive-style segments a parquet reader understands as partitions', () => {
    expect(objectKeyFor('logs', 'demo-a1b2', '2026-07-27'))
      .toBe('logs/project_id=demo-a1b2/date=2026-07-27/part-000.parquet')
  })

  test('tolerates a prefix written with stray slashes', () => {
    expect(objectKeyFor('/logs/', 'demo', '2026-07-27'))
      .toBe('logs/project_id=demo/date=2026-07-27/part-000.parquet')
  })

  test('an empty prefix puts partitions at the bucket root', () => {
    expect(objectKeyFor('', 'demo', '2026-07-27'))
      .toBe('project_id=demo/date=2026-07-27/part-000.parquet')
  })
})

describe('partitionsToExport', () => {
  const aged = [
    { project_id: 'a', day: '2026-07-01', n: 10 },
    { project_id: 'a', day: '2026-07-02', n: 20 },
    { project_id: 'b', day: '2026-07-01', n: 30 },
  ]

  test('plans every partition when the ledger is empty', () => {
    expect(partitionsToExport(aged, [])).toHaveLength(3)
  })

  test('skips anything already finished', () => {
    for (const status of TERMINAL_STATUSES) {
      const plans = partitionsToExport(aged, [{ project_id: 'a', day: '2026-07-01', status }])
      expect(plans.find(p => p.projectId === 'a' && p.day === '2026-07-01')).toBeUndefined()
      expect(plans).toHaveLength(2)
    }
  })

  test('retries a failed partition, marked as a reclaim', () => {
    const plans = partitionsToExport(aged, [{ project_id: 'a', day: '2026-07-01', status: 'failed' }])
    const plan = plans.find(p => p.projectId === 'a' && p.day === '2026-07-01')
    expect(plan?.reclaim).toBe(true)
  })

  test('leaves a live claim alone', () => {
    // Another run holds it. Touching it would mean two exporters on one day.
    const plans = partitionsToExport(
      aged,
      [{ project_id: 'a', day: '2026-07-01', status: 'exporting', updated_at: '2026-08-26 04:00:00' }],
      { staleClaimsBefore: '2026-08-25 22:10:00' },
    )
    expect(plans.find(p => p.projectId === 'a' && p.day === '2026-07-01')).toBeUndefined()
  })

  test('reclaims a claim old enough that the run holding it must have died', () => {
    const plans = partitionsToExport(
      aged,
      [{ project_id: 'a', day: '2026-07-01', status: 'exporting', updated_at: '2026-08-20 01:00:00' }],
      { staleClaimsBefore: '2026-08-25 22:10:00' },
    )
    expect(plans.find(p => p.projectId === 'a' && p.day === '2026-07-01')?.reclaim).toBe(true)
  })

  test('will not reclaim a stale claim when no staleness bound is given', () => {
    const plans = partitionsToExport(
      aged,
      [{ project_id: 'a', day: '2026-07-01', status: 'exporting', updated_at: '2020-01-01 00:00:00' }],
    )
    expect(plans.find(p => p.projectId === 'a' && p.day === '2026-07-01')).toBeUndefined()
  })

  test('keys on project and day together, so one project finishing does not skip another', () => {
    const plans = partitionsToExport(aged, [{ project_id: 'a', day: '2026-07-01', status: 'deleted' }])
    expect(plans.find(p => p.projectId === 'b' && p.day === '2026-07-01')).toBeDefined()
  })

  test('carries the row count through for reporting', () => {
    const plans = partitionsToExport(aged, [])
    expect(plans.find(p => p.projectId === 'b')?.rows).toBe(30)
  })
})

describe('freePruneCutoff', () => {
  test('sits a grace period further back than the hot window', () => {
    // Window 30 + grace 7: free rows survive 37 days, so an upgrade in week five
    // still finds them there to archive.
    expect(freePruneCutoff(NOW, 30, 7)).toBe('2026-07-20')
  })

  test('equals the hot cutoff when the grace is zero', () => {
    expect(freePruneCutoff(NOW, 30, 0)).toBe(cutoffDay(NOW, 30))
  })

  test('is never later than the hot cutoff', () => {
    expect(freePruneCutoff(NOW, 30, 7) <= cutoffDay(NOW, 30)).toBe(true)
  })

  test('the boundary day itself is not yet prunable', () => {
    // runArchive prunes only when `day < freeCutoff`.
    const cutoff = freePruneCutoff(NOW, 30, 7)
    expect(cutoff < cutoff).toBe(false)
    expect('2026-07-19' < cutoff).toBe(true)
  })
})

describe('daysBetween', () => {
  test('is inclusive at both ends', () => {
    expect(daysBetween('2026-07-01', '2026-07-03')).toEqual(['2026-07-01', '2026-07-02', '2026-07-03'])
  })

  test('returns a single day when both ends match', () => {
    expect(daysBetween('2026-07-01', '2026-07-01')).toEqual(['2026-07-01'])
  })

  test('returns nothing for an inverted range rather than looping', () => {
    expect(daysBetween('2026-07-03', '2026-07-01')).toEqual([])
  })

  test('stops at the cap so a wide range cannot run away', () => {
    expect(daysBetween('2000-01-01', '2030-01-01', 10)).toHaveLength(10)
  })
})
