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
import { Auth, findToken } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { PROJECT_SCOPES, projectForToken } from './project-tokens'
import { READ_SCOPE } from './read-token'

/** What a sign-in is issued, and what a read token never carries. */
const FULL_ACCESS = '*'

/**
 * Whether these scopes are a full session rather than a read token.
 *
 * Every sign-in is issued `*` (config.auth.defaultAbilities) and a read token
 * is created with `logs:read` alone, so `*` is what separates "this is the
 * person" from "this may read on their behalf".
 */
export function isFullSession(scopes: readonly string[]): boolean {
  return scopes.includes(FULL_ACCESS)
}

/** The user a token belongs to and the scopes it carries, or null. */
async function tokenHolder(token: string): Promise<{ user: any, scopes: readonly string[] } | null> {
  if (!token)
    return null
  try {
    // The native lookup: it answers only for a live token (not revoked, not
    // expired, not issued before the last password change).
    const access = await findToken(token)
    // A person's token only. A project's read key is a framework token too,
    // owned by the project's principal rather than a user
    // (app/Support/project-tokens.ts), and it is nobody's session.
    if (!access || (access.subjectType ?? 'users') !== 'users')
      return null
    const user = await Auth.getUserFromToken(token)
    return user ? { user, scopes: access.scopes } : null
  }
  catch {
    return null
  }
}

/**
 * The person signed in behind this token, and only a full session.
 *
 * This is the one place a token becomes "the user" for everything a signed-in
 * person can do. A read token is refused here, so it cannot be put in an
 * `auth-token` cookie or a bearer header and used as its owner. Routes, the
 * auth middleware and the views call this rather than
 * `Auth.getUserFromToken`, which answers for any valid token whatever its
 * scopes (tests/unit/read-token.test.ts holds that).
 */
export async function sessionUser(token: string | null | undefined): Promise<any | null> {
  const holder = await tokenHolder(String(token ?? ''))
  return holder && isFullSession(holder.scopes) ? holder.user : null
}

export async function userFromRequest(request: any): Promise<any | null> {
  return sessionUser(bearerFrom(request))
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
 * Null covers every way a token can be no good: never issued, revoked,
 * expired, left behind by a deleted account, or simply not a read token. The
 * caller answers all of them the same way, so a guess learns nothing about
 * which. A full session is not a read token and answers null here too: it is
 * resolved by `userFromRequest`.
 *
 * Returns only the id and email, which is all `ownsProject` reads. This is
 * deliberately not a full user: nothing downstream should be able to mistake a
 * read token's bearer for a signed-in session.
 */
export async function userFromReadToken(request: any): Promise<{ id: number, email: string } | null> {
  const holder = await tokenHolder(bearerFrom(request))
  if (!holder || isFullSession(holder.scopes) || !holder.scopes.includes(READ_SCOPE))
    return null
  return { id: Number(holder.user.id), email: String(holder.user.email ?? '') }
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
 * A read key is a project token carrying `project:read`
 * (app/Support/project-tokens.ts). It is checked first, because it names its
 * project and answering it needs no user at all. A key for a different project
 * answers 404 rather than 403, matching what `ownsProject` already does: a
 * caller who cannot read a project should not be able to learn that it exists.
 */
export async function projectReadAccess(request: any, projectId: string, ownsProject: (user: any, id: string) => Promise<boolean>): Promise<ProjectReadAccess> {
  const presented = bearerFrom(request)

  const key = await projectForToken(presented, PROJECT_SCOPES.read)
  if (key) {
    if (key.projectId !== String(projectId))
      return { ok: false, status: 404, error: 'not found' }
    if (!key.isActive)
      return { ok: false, status: 403, error: 'project inactive' }
    return { ok: true, as: 'key' }
  }

  // A person's read token: whatever its owner can read right now. Membership
  // is checked on every request, exactly as it is for a session, so leaving a
  // project ends the token's access to it without the token changing.
  const reader = await userFromReadToken(request)
  if (reader) {
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
