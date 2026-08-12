/**
 * Shared plumbing for the end-to-end suite.
 *
 * These tests drive the app over HTTP against a running dev server. That is
 * possible at all because every form in the app handles its own POST now
 * (stx#1847, see resources/views/login.stx) — sign-in, sign-up, password reset
 * and project creation are ordinary form submissions, so a browser is not
 * needed to exercise them and this suite carries no browser dependency.
 *
 * What that does NOT cover is anything whose behaviour only exists after
 * hydration: SPA navigation, the theme toggle, clipboard buttons, the delete
 * modal. Those need a real engine and a dependency decision; they are
 * deliberately out of scope here rather than faked.
 */

const BASE = Bun.env.E2E_BASE_URL || 'http://localhost:3000'

/** A password that satisfies the app's 8-character minimum. */
export const TEST_PASSWORD = 'e2e-test-password'

/**
 * Whether a server is reachable.
 *
 * The suite SKIPS rather than fails when nothing is listening, so `bun test`
 * stays green on a machine that has not started the app. A failing E2E suite
 * should mean the app is broken, not that the developer did not run `bun run
 * dev` — otherwise the signal gets ignored, which is worse than not having it.
 */
export async function serverIsUp(): Promise<boolean> {
  try {
    const res = await fetch(BASE, { signal: AbortSignal.timeout(3000) })
    return res.ok
  }
  catch {
    return false
  }
}

/**
 * Resolved once at module load, so `test.skipIf()` can read it.
 *
 * bun:test evaluates a skipIf condition when it COLLECTS the test, which is
 * before any beforeAll runs — so a flag set in beforeAll is always false here
 * and every test would run anyway. Top-level await is what makes the skip real.
 */
export const SERVER_UP: boolean = await serverIsUp()

export function url(path: string): string {
  return BASE + path
}

/**
 * A GET that never follows redirects, so a test can assert on the 303 itself.
 * `redirect: 'manual'` is the whole point — the default would swallow the
 * status and Location this suite exists to check.
 */
export async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(url(path), {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {},
  })
}

/** A form POST, encoded the way a browser encodes one. */
export async function postForm(
  path: string,
  fields: Record<string, string>,
  cookie?: string,
): Promise<Response> {
  return fetch(url(path), {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  })
}

/** The `loghq_token` value from a response's Set-Cookie, or ''. */
export function sessionCookie(res: Response): string {
  const raw = res.headers.get('set-cookie') || ''
  const m = raw.match(/loghq_token=([^;]*)/)
  return m ? m[1] : ''
}

/**
 * An email nobody else is using.
 *
 * Unique per call so a rerun cannot collide with its own leftovers, and
 * prefixed so the cleanup below can find every account this suite ever made —
 * including from a run that crashed before its own teardown.
 */
export function freshEmail(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@loghq.test`
}

/** Register through the real form and return the session cookie it mints. */
export async function registerAndSignIn(label: string): Promise<{ email: string, cookie: string }> {
  const email = freshEmail(label)
  const res = await postForm('/register', {
    name: 'E2E User',
    email,
    password: TEST_PASSWORD,
  })
  const token = sessionCookie(res)
  return { email, cookie: token ? `loghq_token=${token}` : '' }
}

/**
 * Remove every account this suite has ever created, and anything hanging off
 * one.
 *
 * Matches on the `e2e-%@loghq.test` prefix rather than tracking ids, so a run
 * that died before teardown is cleaned up by the next one. Deletes children
 * first — projects and tokens reference users.
 */
export async function cleanupTestAccounts(): Promise<void> {
  const { db } = await import('@stacksjs/database')
  await db.unsafe(
    `DELETE FROM projects WHERE owner_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@loghq.test')`,
  ).execute()
  await db.unsafe(
    `DELETE FROM oauth_access_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'e2e-%@loghq.test')`,
  ).execute()
  await db.unsafe(`DELETE FROM users WHERE email LIKE 'e2e-%@loghq.test'`).execute()
}
