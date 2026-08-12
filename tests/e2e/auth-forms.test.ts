/**
 * The five forms, end to end, as a browser with scripting disabled submits
 * them.
 *
 * These are the flows stx#1847 measured as inert — five of five carried no
 * `action` and no `method` and did nothing without JavaScript. Each one is a
 * page action now, so each is reachable with a plain form POST, which is
 * exactly what this file does.
 *
 * The assertions are deliberately about the CONTRACT rather than the copy: a
 * status, a Location, a Set-Cookie, whether the submitted value came back.
 * Asserting on exact sentences would make this suite fail on a wording change,
 * which is the fastest way to get a test suite ignored.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  cleanupTestAccounts,
  freshEmail,
  get,
  postForm,
  registerAndSignIn,
  sessionCookie,
  SERVER_UP,
  TEST_PASSWORD,
} from './helpers'

// Skipped, not passed, when nothing is listening. A suite that reports green
// because it never ran is worse than no suite — it is the exact false-clean
// shape of stx#1918.
const only = test.skipIf(!SERVER_UP)

afterAll(async () => { if (SERVER_UP) await cleanupTestAccounts() })

describe('sign-in', () => {
  only('the form is submittable without JavaScript', async () => {
    const html = await (await get('/login')).text()
    // action + method are the whole point: without them the browser has
    // nothing to submit to.
    expect(html).toContain('action="/login"')
    expect(html).toContain('method="POST"')
  })

  only('rejects bad credentials without leaking whether the account exists', async () => {
    const res = await postForm('/login', { email: 'nobody@example.com', password: 'wrong-password' })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBe('')
    expect(html).toContain('err-box')
    // the address is kept so a retry is not a retype
    expect(html).toContain('value="nobody@example.com"')
  })

  only('an unknown account and a wrong password are indistinguishable', async () => {
    const { email } = await registerAndSignIn('login-oracle')

    const unknown = await (await postForm('/login', { email: freshEmail('ghost'), password: 'whatever-1' })).text()
    const wrongPw = await (await postForm('/login', { email, password: 'definitely-not-it' })).text()

    const msg = (h: string) => h.match(/err-box[^>]*>([^<]*)/)?.[1]?.trim()
    expect(msg(unknown)).toBeTruthy()
    expect(msg(unknown)).toBe(msg(wrongPw))
  })

  only('accepts valid credentials and establishes a session', async () => {
    const { email } = await registerAndSignIn('login-ok')
    const res = await postForm('/login', { email, password: TEST_PASSWORD })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard')

    const cookie = res.headers.get('set-cookie') || ''
    expect(cookie).toContain('loghq_token=')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('SameSite=Lax')
    // NOT HttpOnly — the session store reads this cookie to attach the bearer
    // to API calls. See the note in login.stx; making it HttpOnly would sign
    // the user in and leave every client fetch unauthenticated.
    expect(cookie).not.toContain('HttpOnly')
  })

  only('the minted session authenticates a server-rendered page', async () => {
    const { cookie } = await registerAndSignIn('login-session')
    expect(cookie).not.toBe('')

    const html = await (await get('/dashboard', cookie)).text()
    // the signed-out skeleton must be gone
    expect(html).not.toContain('id="auth-pending"')
  })
})

describe('sign-up', () => {
  only('rejects a short password and keeps what was typed', async () => {
    const email = freshEmail('short-pw')
    const res = await postForm('/register', { name: 'Ada', email, password: 'short' })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBe('')
    expect(html).toContain('err-box')
    expect(html).toContain(`value="${email}"`)
    expect(html).toContain('value="Ada"')
  })

  only('rejects a duplicate address without confirming it is taken', async () => {
    const { email } = await registerAndSignIn('dupe')
    const res = await postForm('/register', { name: 'Someone Else', email, password: TEST_PASSWORD })
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(sessionCookie(res)).toBe('')
    // the framework's own message is deliberately vague; the test asserts it
    // does NOT name the cause rather than pinning the wording
    expect(html.toLowerCase()).not.toContain('already exists')
  })

  only('creates the account, signs in, and routes to onboarding', async () => {
    const res = await postForm('/register', {
      name: 'E2E User',
      email: freshEmail('signup-ok'),
      password: TEST_PASSWORD,
    })

    expect(res.status).toBe(303)
    // no project yet, so the destination is create-your-first-app
    expect(res.headers.get('location')).toBe('/projects/new')
    expect(sessionCookie(res)).not.toBe('')
  })

  only('an invited sign-up skips onboarding and goes to the dashboard', async () => {
    const res = await postForm('/register', {
      name: 'Invited User',
      email: freshEmail('signup-invited'),
      password: TEST_PASSWORD,
      invite: '1',
    })

    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/dashboard')
  })

  only('the invite flag survives the POST as a hidden field', async () => {
    const html = await (await get('/register?invite=1&email=friend@example.com')).text()
    // a form posts with no query string, so the flag has to travel in the body
    expect(html).toContain('name="invite"')
    expect(html).toContain('value="friend@example.com"')
  })
})

describe('forgot password', () => {
  only('answers identically for a real and an unknown address', async () => {
    const { email } = await registerAndSignIn('forgot-real')

    const real = await (await postForm('/forgot-password', { email })).text()
    const ghost = await (await postForm('/forgot-password', { email: freshEmail('ghost') })).text()

    // Same confirmation, and neither redirects — a redirect would put the
    // outcome in the URL.
    const confirmation = 'reset link is on its way'
    expect(real).toContain(confirmation)
    expect(ghost).toContain(confirmation)
    expect(real.includes('<form action="/forgot-password"')).toBe(false)
  })
})

describe('reset password', () => {
  only('carries the link token and address across the POST', async () => {
    const html = await (await get('/reset-password?token=tok123&email=a@b.test')).text()
    expect(html).toContain('name="token"')
    expect(html).toContain('value="tok123"')
    expect(html).toContain('value="a@b.test"')
  })

  only('rejects a mismatch, a short password, and a bad token', async () => {
    const base = { token: 'tok', email: 'a@b.test' }

    const mismatch = await (await postForm('/reset-password', {
      ...base, password: 'long-enough-1', password_confirmation: 'something-else-1',
    })).text()
    const tooShort = await (await postForm('/reset-password', {
      ...base, password: 'short', password_confirmation: 'short',
    })).text()
    const badToken = await (await postForm('/reset-password', {
      ...base, password: 'long-enough-1', password_confirmation: 'long-enough-1',
    })).text()

    for (const html of [mismatch, tooShort, badToken])
      expect(html).toContain('err-box')

    // and none of them signs anyone in
    expect(mismatch).not.toContain('Your password has been reset')
  })
})
