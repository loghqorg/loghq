/**
 * The grouping key behind "Fix with AI".
 *
 * This is a cost control before it is anything else. loghq stores a flat stream
 * and groups nothing, so one bug that fires 400 times is 400 rows; if the
 * fingerprint does not collapse them, the button bills 400 analyses of one bug.
 *
 * Which makes both directions load-bearing, and worth pinning:
 *
 *   - too coarse, and a cached answer about one error is served for a genuinely
 *     different one, which is worse than paying twice
 *   - too fine, and the dedupe does nothing
 *
 * The pairs below are the shapes real logs actually produce. `sub_88213` in
 * particular is not a hypothetical: it was the case that failed first, because
 * an underscore is a word character, so the token never breaks and a
 * boundary-anchored digit rule can never reach the digits.
 */
import { describe, expect, test } from 'bun:test'
import { fingerprintOf, normalizeMessage } from '../../app/Fix/fingerprint'

function same(a: string, b: string): boolean {
  const key = (message: string) => fingerprintOf({ level: 'error', channel: 'billing', message })
  return key(a) === key(b)
}

describe('normalizeMessage', () => {
  test('masks the values that vary between occurrences of one bug', () => {
    expect(normalizeMessage('order 10422 failed after 3 retries')).toBe('order <n> failed after <n> retries')
    expect(normalizeMessage('timeout connecting to 10.0.1.44:5432')).toBe('timeout connecting to <ip>')
    expect(normalizeMessage('charge for sub_88213 declined')).toBe('charge for <id> declined')
  })

  test('leaves the words alone', () => {
    expect(normalizeMessage('Payment gateway unreachable')).toBe('payment gateway unreachable')
  })

  test('collapses whitespace and bounds the input', () => {
    expect(normalizeMessage('a\n\n  b\t c')).toBe('a b c')
    expect(normalizeMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(2000)
  })

  test('survives the empty and the absent', () => {
    expect(normalizeMessage('')).toBe('')
    expect(normalizeMessage(undefined as unknown as string)).toBe('')
  })
})

describe('fingerprintOf collapses repeats of one bug', () => {
  test('counters and durations', () => {
    expect(same('order sync failed after 3 retries', 'order sync failed after 47 retries')).toBe(true)
    expect(same('GET /api/orders/10422 took 1200ms', 'GET /api/orders/99 took 340ms')).toBe(true)
  })

  test('identifiers welded to a prefix, which no word boundary reaches', () => {
    expect(same(
      'renewal failed for subscription sub_88213 after 3 attempts',
      'renewal failed for subscription sub_99999 after 7 attempts',
    )).toBe(true)
    expect(same('charge declined for cus_ABC123XYZ789', 'charge declined for cus_ZZZ999QQQ111')).toBe(true)
  })

  test('addresses, uuids and hashes', () => {
    expect(same('timeout connecting to 10.0.1.44:5432', 'timeout connecting to 192.168.9.2:5432')).toBe(true)
    expect(same(
      'user a3f8e1c2-9b4d-4e7f-8a1b-2c3d4e5f6a7b not found',
      'user 11111111-2222-3333-4444-555555555555 not found',
    )).toBe(true)
  })
})

describe('fingerprintOf keeps genuinely different errors apart', () => {
  test('different subjects with identical numbers', () => {
    expect(same('disk usage at 91%', 'memory usage at 91%')).toBe(false)
  })

  test('opposite outcomes', () => {
    expect(same('payment failed', 'payment succeeded')).toBe(false)
  })

  test('a digit that is part of a name, not a value', () => {
    // `s3`, `utf8`, `v2`: one digit welded to a word is part of the word. Two
    // or more is a value. This is the line the mask draws.
    expect(same('invalid utf8 sequence', 'invalid utf16 sequence')).toBe(false)
    expect(same('upload to s3 failed', 'upload to s4 failed')).toBe(false)
  })

  test('severity and source are part of the identity', () => {
    const message = 'connection reset'
    expect(fingerprintOf({ level: 'info', channel: 'db', message }))
      .not.toBe(fingerprintOf({ level: 'error', channel: 'db', message }))
    expect(fingerprintOf({ level: 'error', channel: 'db', message }))
      .not.toBe(fingerprintOf({ level: 'error', channel: 'queue', message }))
  })
})

describe('fingerprintOf is a usable key', () => {
  test('stable across calls and short enough for the column', () => {
    const entry = { level: 'error', channel: 'billing', message: 'charge declined' }
    expect(fingerprintOf(entry)).toBe(fingerprintOf(entry))
    // log_fix_runs.fingerprint is varchar(64).
    expect(fingerprintOf(entry).length).toBeLessThanOrEqual(64)
  })

  test('a missing level defaults rather than throwing', () => {
    expect(fingerprintOf({ message: 'x' })).toBe(fingerprintOf({ level: 'info', channel: '', message: 'x' }))
  })
})
