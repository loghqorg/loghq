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
 * It reads and does nothing else. Only the read paths ask for it (the log
 * stream, the tail, one entry, and the project list a client needs to find
 * ids). Every route that changes something resolves a signed-in user through
 * `userFromRequest`, which never sees one of these as a user: the prefix keeps
 * it out of `Auth.getUserFromToken`, the same way `lhq_read_` does.
 *
 * Only a SHA-256 of the token is stored. A read key sits in its project row in
 * the clear because there is one per project and the owner manages it there;
 * these are many per person and outlive sessions, so a copy of the table must
 * not be a copy of the credentials. The token is 256 random bits, so an
 * unsalted hash is enough: there is nothing to dictionary.
 */
import { createHash } from 'node:crypto'

const PREFIX = 'lhq_user_'
const BODY = /^[0-9a-f]{64}$/

/** A person can hold this many at once. Enough for every machine they own, and a ceiling on the table. */
export const MAX_READ_TOKENS_PER_USER = 20
export const MAX_TOKEN_NAME = 80

export function newReadToken(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  return PREFIX + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export function newReadTokenId(): string {
  return `rtk_${globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

/** Whether a presented credential is shaped like a read token at all. */
export function looksLikeReadToken(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX) && BODY.test(value.slice(PREFIX.length))
}

/** What is stored and looked up. Lookup is by this value, so there is no comparison to time. */
export function hashReadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** The last four characters, kept so two tokens in a list can be told apart without storing either. */
export function readTokenHint(token: string): string {
  return token.slice(-4)
}

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

export interface StoredReadToken {
  id: string
  user_id: number | string
  expires_at?: string | null
}

/** A token with no expiry lasts until it is revoked; one with an expiry stops at it. */
export function readTokenUsable(row: StoredReadToken | null | undefined, now: Date = new Date()): row is StoredReadToken {
  if (!row)
    return false
  if (!row.expires_at)
    return true
  const until = Date.parse(String(row.expires_at).replace(' ', 'T').replace(/(?<!Z)$/, 'Z'))
  return !Number.isNaN(until) && until > now.getTime()
}

export const MAX_EXPIRY_DAYS = 3650

/**
 * An optional lifetime in days, as the `YYYY-MM-DD HH:MM:SS` the timestamp
 * columns hold. Null means no expiry; anything that is not a positive number of
 * days is refused rather than read as "forever".
 */
export function readTokenExpiry(days: unknown, now: Date = new Date()): { ok: true, expiresAt: string | null } | { ok: false } {
  if (days == null || days === '')
    return { ok: true, expiresAt: null }
  const n = Number(days)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_EXPIRY_DAYS)
    return { ok: false }
  return { ok: true, expiresAt: new Date(now.getTime() + n * 86_400_000).toISOString().slice(0, 19).replace('T', ' ') }
}
