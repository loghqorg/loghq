import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

/**
 * Structural guards on app/Archive/exporter.ts.
 *
 * Its two loops are the parts that only misbehave at a scale no unit test
 * reaches: a day large enough to exhaust memory, or one with enough batches for
 * a per-batch count to dominate. Both were wrong once. These assert the shape
 * that made them right, so a later edit cannot quietly undo it.
 */
const SOURCE = readFileSync(join(import.meta.dir, '../../app/Archive/exporter.ts'), 'utf8')

function body(fn: string): string {
  const start = SOURCE.indexOf(`async function ${fn}(`)
  expect(start).toBeGreaterThan(-1)
  const end = SOURCE.indexOf('\n}', start)
  return SOURCE.slice(start, end)
}

describe('stageDay streams rather than buffering the day', () => {
  const fn = body('stageDay')

  test('writes each row to a sink instead of collecting lines', () => {
    // The original pushed every row into an array and joined at the end, which
    // held the whole day in memory twice. A single message can be 16KB and a
    // context blob 96KB, so a busy day is measured in gigabytes.
    expect(fn).toContain('.writer()')
    expect(fn).toContain('sink.write(')
    expect(fn).not.toMatch(/lines\.push\(/)
    expect(fn).not.toMatch(/lines\.join\(/)
  })

  test('closes the sink in a finally, so a thrown page cannot leak the handle', () => {
    expect(fn).toContain('finally')
    expect(fn).toContain('sink.end()')
  })

  test('pages with a keyset cursor, not OFFSET', () => {
    expect(fn).toContain('ORDER BY timestamp, id')
    expect(fn).not.toContain('OFFSET')
  })

  test('spells the cursor as an OR, which both engines accept', () => {
    // Row-value comparison `(a, b) > (x, y)` is not portable to SQLite here.
    expect(fn).toMatch(/timestamp > \$.*OR.*timestamp = \$.*AND id > \$/s)
  })
})

describe('deleteDay counts once and stops on a cheap check', () => {
  const fn = body('deleteDay')

  test('does not COUNT inside the delete loop', () => {
    // Counting per batch made deletion quadratic in the batch count: a million
    // row day spent five hundred full range scans deciding whether to continue.
    const counts = fn.match(/COUNT\(\*\)/g) ?? []
    // One up front for the return value, one on the give-up path. Never in the loop.
    expect(counts.length).toBeLessThanOrEqual(2)
    expect(fn).toContain('SELECT 1 AS more')
  })

  test('returns the counted total rather than a batch estimate', () => {
    // prunePartition records this as the partition's row_count, so an estimate
    // would be stored as fact.
    expect(fn).toContain('return total')
    expect(fn).not.toMatch(/removed \+= Math\.min/)
  })

  test('bounds the loop so a delete matching nothing cannot spin forever', () => {
    expect(fn).toContain('maxBatches')
  })

  test('batches with a subselect, since DELETE ... LIMIT is not portable', () => {
    expect(fn).toContain('WHERE id IN (')
    expect(fn).not.toMatch(/DELETE FROM log_entries\s+WHERE project_id[\s\S]{0,120}LIMIT/)
  })
})
