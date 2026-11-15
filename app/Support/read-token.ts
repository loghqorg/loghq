/**
 * A person's read token: one credential that reads every project they can see.
 *
 * A project read key (app/Support/read-key.ts) authorises exactly one project
 * and has no account behind it, which is right for a server and wrong for a
 * desktop app: somebody following four projects from one window would paste
 * four keys, and being added to a fifth would mean a fifth. A read token
 * stands for the person instead. It reads whatever they can read at the moment
 * of each request, so joining a project extends it and leaving one narrows it,
 * with nothing to reissue.
 *
 * It is a Stacks personal access token carrying one scope, `logs:read`, and
 * nothing here generates, stores or compares it: `createToken` mints it and
 * keeps only a hash, `findToken` resolves it, `tokens` lists it and
 * `revokeTokenById` ends it (@stacksjs/auth). This file used to do all of
 * that itself, with its own table, prefix and SHA-256. What is left is the
 * app's side: what one is called, how long it lasts and how many somebody may
 * hold.
 *
 * It reads and does nothing else. Only the read paths accept it (the log
 * stream, the tail, one entry, and the project list a client needs to find
 * ids). Every route that changes something resolves a signed-in user through
 * `userFromRequest`, which accepts a full session and nothing narrower
 * (app/Support/request-auth.ts).
 */

/** The one thing a read token may do. */
export const READ_SCOPE = 'logs:read'

/** A person can hold this many at once. Enough for every machine they own. */
export const MAX_READ_TOKENS_PER_USER = 20
export const MAX_TOKEN_NAME = 80

/** A label for the list. Blank becomes a default so a row is never nameless. */
export function readTokenName(value: unknown): string {
  // Control characters are dropped rather than rejected: the name is only ever
  // a label somebody reads back, and a pasted newline should not fail a create.
  const name = Array.from(String(value ?? ''), ch => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TOKEN_NAME)
  return name || 'Read token'
}

/** The longest a token may last, and how long one lasts when no lifetime is given. */
export const MAX_EXPIRY_DAYS = 3650

/**
 * When a token stops working, from an optional lifetime in days.
 *
 * A framework token always has an expiry, so "no lifetime given" is the
 * longest one allowed rather than forever: ten years, and revocable at any
 * point before that. Anything that is not a positive number of days within
 * the limit is refused rather than read as the default.
 */
export function readTokenExpiry(days: unknown, now: Date = new Date()): { ok: true, expiresAt: Date } | { ok: false } {
  const n = days == null || days === '' ? MAX_EXPIRY_DAYS : Number(days)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_EXPIRY_DAYS)
    return { ok: false }
  return { ok: true, expiresAt: new Date(now.getTime() + n * 86_400_000) }
}
