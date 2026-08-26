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
 * are accepted: a bearer header, which is what the API clients send, and the
 * `loghq_token` cookie, which is what the dashboard has after signing in.
 */
import { Auth } from '@stacksjs/auth'

export async function userFromRequest(request: any): Promise<any | null> {
  const authHeader = request.headers?.get?.('authorization') ?? ''
  let token = request.bearerToken?.() ?? authHeader.replace(/^Bearer\s+/i, '')

  if (!token) {
    const cookie = request.headers?.get?.('cookie') ?? ''
    const m = cookie.match(/(?:^|;)\s*loghq_token=([^;]+)/)
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
