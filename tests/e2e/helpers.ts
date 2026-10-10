/**
 * Shared plumbing for the end-to-end suite.
 *
 * These tests drive an explicitly opted-in, isolated local server over HTTP.
 * See README.md for the disposable database requirement and the legacy auth
 * expectations that still need migrating to the current JSON API.
 *
 * What that does NOT cover is anything whose behaviour only exists after
 * hydration: SPA navigation, the theme toggle, clipboard buttons, the delete
 * modal. Those need a real engine and a dependency decision; they are
 * deliberately out of scope here rather than faked.
 */

import { cleanupE2EAccounts, e2eUrl, validateE2ETarget } from './safety'

const target = validateE2ETarget(Bun.env)
const createdEmails = new Set<string>()

/** A password that satisfies the app's 8-character minimum. */
export const TEST_PASSWORD = 'e2e-test-password'

/**
 * Whether a server is reachable.
 *
 * The suite SKIPS unless explicitly enabled, and when nothing is listening, so `bun test`
 * stays green on a machine that has not started the app. A failing E2E suite
 * should mean the app is broken, not that the developer did not run `bun run
 * dev` — otherwise the signal gets ignored, which is worse than not having it.
 */
export async function serverIsUp(): Promise<boolean> {
  if (!target)
    return false
  try {
    const res = await fetch(target.baseUrl, { redirect: 'manual', signal: AbortSignal.timeout(3000) })
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
  return e2eUrl(target, path)
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
 * Unique per call so a rerun cannot collide with its own leftovers. Track the
 * exact address for this run's cleanup; the prefix is only a readable QA label.
 */
export function freshEmail(label: string): string {
  const email = `e2e-${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@loghq.test`
  createdEmails.add(email)
  return email
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
 * Remove only this process's generated accounts from the explicit disposable
 * SQLite file. Never import the app's default database connection for cleanup.
 * Failed-run leftovers remain confined to the disposable test database.
 */
export async function cleanupTestAccounts(): Promise<void> {
  cleanupE2EAccounts(target, createdEmails)
  createdEmails.clear()
}
