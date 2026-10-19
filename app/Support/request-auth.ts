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

  if (!token)
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

export type ProjectReadAccess =
  | { ok: true, as: 'user', user: any }
  | { ok: true, as: 'key' }
  | { ok: false, status: 401 | 403 | 404, error: string }

/**
 * Who may read this project: the person signed in, or a key issued for it.
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
    const row = (await db.unsafe(
      'SELECT id, read_key, read_key_last_used_at, is_active FROM projects WHERE id = $1 LIMIT 1',
      [String(projectId)],
    ))?.[0] ?? null
    const verdict = authorizeRead(row, presented)
    // A key that is valid for some other project must not reveal that this one
    // exists, so its refusal is the same 404 an unknown id gets.
    if (!verdict.ok)
      return verdict.status === 401 ? { ok: false, status: 404, error: 'not found' } : verdict
    await recordReadKeyUse(row)
    return { ok: true, as: 'key' }
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
  // Never let the stamp fail a read: it is an aid to revoking a key, not part
  // of authorising one.
  await db.unsafe('UPDATE projects SET read_key_last_used_at = $1 WHERE id = $2', [now.toISOString(), String(project.id)]).catch(() => {})
}
