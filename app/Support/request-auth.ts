/**
 * Resolving the signed-in user from a request.
 *
 * Extracted from routes/logs.ts so the log routes and the analytics routes
 * cannot drift on it, in the same spirit as app/Support/access.ts owning the
 * "who may see this project" predicate.
 *
 * This exists instead of the `auth` middleware alias because that alias does not
 * reliably populate `request.user()` on these route handlers (see the note in
 * routes/projects.ts), so the token is read and resolved directly. Two carriers
 * are accepted: a bearer header, which is what the external API clients send,
 * and the HttpOnly `auth-token` cookie (config.auth.defaultTokenName), which is
 * what the dashboard has after signing in.
 */
import { Auth } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { authorizeRead, looksLikeReadKey, shouldRecordUse } from './read-key'
import { hashReadToken, looksLikeReadToken, readTokenUsable } from './read-token'

export async function userFromRequest(request: any): Promise<any | null> {
  const authHeader = request.headers?.get?.('authorization') ?? ''
  let token = request.bearerToken?.() ?? authHeader.replace(/^Bearer\s+/i, '')

  if (!token) {
    const cookie = request.headers?.get?.('cookie') ?? ''
    const name = (config.auth?.defaultTokenName || 'auth-token').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const m = cookie.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`))
    if (m)
      token = decodeURIComponent(m[1])
  }

  // A read key or a read token is never a session, whichever header or cookie
  // carried it. Refusing them here, rather than letting the lookup fail, is
  // what keeps every route that asks for a signed-in user closed to both.
  if (!token || looksLikeReadKey(token) || looksLikeReadToken(token))
    return null

  try {
    return await Auth.getUserFromToken(token)
  }
  catch {
    return null
  }
}

/**
 * The bearer a request presents, whatever carries it.
 *
 * Split out of `userFromRequest` so a read key can be recognised before it is
 * sent anywhere near `Auth.getUserFromToken`: the two credentials arrive in
 * the same header and only their shape tells them apart.
 */
function bearerFrom(request: any): string {
  const authHeader = request.headers?.get?.('authorization') ?? ''
  const header = request.bearerToken?.() ?? authHeader.replace(/^Bearer\s+/i, '')
  if (header)
    return header
  const cookie = request.headers?.get?.('cookie') ?? ''
  const name = (config.auth?.defaultTokenName || 'auth-token').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const m = cookie.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : ''
}

/**
 * The person behind a read token, or null.
 *
 * Null covers every way a token can be no good: not shaped like one, never
 * issued, revoked, expired, or left behind by a deleted account. The caller
 * answers all of them the same way, so a guess learns nothing about which.
 *
 * Returns only the id and email, which is all `ownsProject` reads. This is
 * deliberately not a full user: nothing downstream should be able to mistake a
 * read token's bearer for a signed-in session.
 */
export async function userFromReadToken(request: any): Promise<{ id: number, email: string } | null> {
  const presented = bearerFrom(request)
  if (!looksLikeReadToken(presented))
    return null
  const found = (await db.unsafe(
    `SELECT t.id, t.user_id, t.expires_at, t.last_used_at, u.email
    FROM read_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = $1 LIMIT 1`,
    [hashReadToken(presented)],
  ))?.[0]
  const row = found
    ? { id: String(found.id), user_id: Number(found.user_id), expires_at: found.expires_at == null ? null : String(found.expires_at) }
    : null
  if (!readTokenUsable(row))
    return null
  const now = new Date()
  // Same once-a-minute stamp as a read key, for the same reason: it is there so
  // somebody can see whether a token is still in use before revoking it.
  if (shouldRecordUse(found.last_used_at == null ? null : String(found.last_used_at), now))
    await stamp('UPDATE read_tokens SET last_used_at = $1 WHERE id = $2', [now.toISOString().slice(0, 19).replace('T', ' '), row.id])
  return { id: row.user_id, email: String(found.email ?? '') }
}

export type ProjectReadAccess =
  | { ok: true, as: 'user', user: any }
  | { ok: true, as: 'key' }
  | { ok: true, as: 'token', user: { id: number, email: string } }
  | { ok: false, status: 401 | 403 | 404, error: string }

/**
 * Who may read this project: the person signed in, a key issued for it, or a
 * read token belonging to somebody who can see it.
 *
 * Order matters. A read key is checked first when one is presented, because a
 * key is scoped to a single project and answering it does not need a user
 * lookup at all. Anything that is not shaped like a read key falls through to
 * the existing user path unchanged, so the dashboard's cookie and a person's
 * bearer token behave exactly as they did.
 *
 * A key for a different project answers 404 rather than 403, matching what
 * `ownsProject` already does: a caller who cannot read a project should not be
 * able to learn that it exists.
 */
export async function projectReadAccess(request: any, projectId: string, ownsProject: (user: any, id: string) => Promise<boolean>): Promise<ProjectReadAccess> {
  const presented = bearerFrom(request)

  if (looksLikeReadKey(presented)) {
    // db.unsafe answers an untyped row, so the columns are narrowed here rather
    // than asserted: authorizeRead decides who may read a project and should be
    // reading values it can see the shape of.
    const found = (await db.unsafe(
      'SELECT id, read_key, read_key_last_used_at, is_active FROM projects WHERE id = $1 LIMIT 1',
      [String(projectId)],
    ))?.[0]
    const row = found
      ? {
          id: String(found.id),
          read_key: found.read_key == null ? null : String(found.read_key),
          read_key_last_used_at: found.read_key_last_used_at == null ? null : String(found.read_key_last_used_at),
          is_active: found.is_active as boolean | number | null,
        }
      : null
    const verdict = authorizeRead(row, presented)
    // A key that is valid for some other project must not reveal that this one
    // exists, so its refusal is the same 404 an unknown id gets.
    if (!verdict.ok)
      return verdict.status === 401 ? { ok: false, status: 404, error: 'not found' } : verdict
    if (row)
      await recordReadKeyUse(row)
    return { ok: true, as: 'key' }
  }

  // A person's read token: whatever its owner can read right now. Membership
  // is checked on every request, exactly as it is for a session, so leaving a
  // project ends the token's access to it without the token changing.
  if (looksLikeReadToken(presented)) {
    const reader = await userFromReadToken(request)
    if (!reader)
      return { ok: false, status: 401, error: 'unauthorized' }
    if (!(await ownsProject(reader, projectId)))
      return { ok: false, status: 404, error: 'not found' }
    return { ok: true, as: 'token', user: reader }
  }

  const user = await userFromRequest(request)
  if (!user)
    return { ok: false, status: 401, error: 'unauthorized' }
  if (!(await ownsProject(user, projectId)))
    return { ok: false, status: 404, error: 'not found' }
  return { ok: true, as: 'user', user }
}

/** Stamp the key as used, at most once a minute — see LAST_USED_RESOLUTION_MS. */
async function recordReadKeyUse(project: { id: string, read_key_last_used_at?: string | null }): Promise<void> {
  const now = new Date()
  if (!shouldRecordUse(project.read_key_last_used_at, now))
    return
  await stamp('UPDATE projects SET read_key_last_used_at = $1 WHERE id = $2', [now.toISOString(), String(project.id)])
}

/**
 * Write a last-used stamp without ever failing the read it rides on: the stamp
 * is an aid to revoking a credential, not part of authorising one.
 *
 * try/await, not `.catch()`. `db.unsafe` answers a thenable with no `catch`
 * method, so `db.unsafe(...).catch(() => {})` threw a TypeError before the
 * statement ran. That turned the first read with a read key in any minute into
 * a 500, which is the opposite of what the `.catch` was there to guarantee.
 */
async function stamp(sql: string, params: unknown[]): Promise<void> {
  try {
    await db.unsafe(sql, params)
  }
  catch {}
}
