import { createHash } from 'node:crypto'

/**
 * The short code a person compares between their terminal and the approve
 * page before they approve a connect.
 *
 * Why it exists: an approve link is just a URL with a connect code in it, and
 * anyone can mint one (`POST /api/cli/connect`) for any app name. Approving
 * hands that project's keys to whoever holds the code. So a signed-in person
 * talked into opening somebody else's link, and clicking the one button on
 * it, would give away their keys. The confirmation code ties the page to a
 * terminal: it is returned to the caller that asked for the connect code, and
 * the page will not approve until the person has entered what THEIR terminal
 * shows. A link that arrives by chat or email comes with no terminal.
 *
 * Derived from the connect code rather than stored, so it needs no column and
 * cannot drift from the code it belongs to. It reveals nothing useful about
 * the connect code: six characters of a SHA-256 under a different prefix from
 * the one the store hashes with.
 *
 * It is typed in, not displayed for comparison. A code the page shows is a
 * code the person can agree with without looking at anything.
 *
 * This belongs in `@stacksjs/hq/service` (the contract, the CLI and every HQ
 * service need the same thing). It is here until it is there.
 */

// No 0/O, 1/I/L: the code is read off one screen and typed into another.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

export function confirmationCode(connectCode: string): string {
  const digest = createHash('sha256').update(`hq-connect-confirm:${connectCode}`).digest()
  let text = ''
  for (let i = 0; i < 6; i++)
    text += ALPHABET[digest[i]! % ALPHABET.length]
  return `${text.slice(0, 3)}-${text.slice(3)}`
}

/** What a person typed, reduced to what is compared: case and the dash do not matter. */
function normalized(value: unknown): string {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Constant time, like every other secret comparison here (app/Support/read-key.ts). */
export function confirmationMatches(connectCode: string, typed: unknown): boolean {
  const expected = normalized(confirmationCode(connectCode))
  const given = normalized(typed)
  if (given.length !== expected.length)
    return false
  let diff = 0
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i)
  return diff === 0
}
