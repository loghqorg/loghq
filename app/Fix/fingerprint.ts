/**
 * A stable identity for "the same error, again".
 *
 * loghq stores a flat stream and groups nothing (app/Models/LogEntry.ts is
 * explicit about it), which is right for reading logs and wrong for paying an
 * AI provider: a retry loop that logs the same failure 400 times would be 400
 * separate analyses of one bug. This module derives a key that collapses those
 * 400 lines onto one answer.
 *
 * The normalization is deliberately conservative. Over-normalizing merges
 * genuinely different errors and hands the user a cached answer about someone
 * else's bug, which is far worse than paying twice - so only tokens that are
 * *always* incidental are masked (ids, addresses, clock values, sizes), and
 * words are left alone.
 */
import { createHash } from 'node:crypto'

/** Longest message prefix that feeds the hash. */
const MAX_MESSAGE = 2000

/**
 * Ordered mask list. Order matters: UUID before hex before digits, or the
 * digit rule would chew a UUID into pieces first and the UUID rule would never
 * match.
 */
const MASKS: Array<[RegExp, string]> = [
  // UUIDs, with or without dashes.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  // ISO-8601 timestamps, before the plain-number rule can shred them.
  [/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, '<time>'],
  [/\b\d{4}-\d{2}-\d{2}\b/g, '<date>'],
  // IPv4 with an optional port.
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
  [/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, '<email>'],
  // Long hex/base-ish runs: tokens, hashes, ids. 12 is high enough that
  // ordinary words and short hex codes are not swept up.
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  // Prefixed opaque identifiers: `sub_88213`, `cus_ABC123XYZ789`,
  // `order_10422`. These are the single most common reason two lines about the
  // same bug look different, and the digit rule below cannot reach them - an
  // underscore is a word character, so `sub_88213` is one unbroken token and no
  // `\b` ever falls before the digits.
  [/\b[a-z][a-z0-9]*_[a-z0-9]{4,}\b/gi, '<id>'],
  // Digit runs anywhere, including welded to a word (`order-10422`,
  // `attempt3of5`). Two or more, so version-ish suffixes that are really part
  // of a name survive: `s3`, `utf8`, `v2`, `ipv6`.
  [/\d{2,}/g, '<n>'],
  // ...and a lone digit only when it stands alone, for the same reason.
  [/\b\d\b/g, '<n>'],
]

/**
 * Reduce a message to its shape.
 *
 * Exported for the tests, which assert on the normalized form rather than the
 * hash: a fingerprint change is only meaningful if you can see what changed.
 */
export function normalizeMessage(message: string): string {
  let text = String(message ?? '').slice(0, MAX_MESSAGE).toLowerCase()
  for (const [pattern, replacement] of MASKS)
    text = text.replace(pattern, replacement)
  return text.replace(/\s+/g, ' ').trim()
}

export interface FingerprintInput {
  level?: string | null
  channel?: string | null
  message?: string | null
}

/**
 * The grouping key for an entry.
 *
 * Level and channel join the message because the same sentence at `info` and at
 * `critical` are not the same event, and the same sentence from `billing` and
 * from `queue` usually has a different cause.
 */
export function fingerprintOf(entry: FingerprintInput): string {
  const parts = [
    String(entry.level ?? 'info').toLowerCase(),
    String(entry.channel ?? '').toLowerCase(),
    normalizeMessage(entry.message ?? ''),
  ]
  // 40 hex chars: the column is varchar(64), and a truncated sha256 collides
  // about as often as never at any volume this table will see.
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)
}
