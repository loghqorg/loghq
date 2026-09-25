import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth, createTwoFactorChallenge, getTwoFactorState } from '@stacksjs/auth'
import { User } from '@stacksjs/orm'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { buildAuthCookie, sessionExpiryMinutes } from '../../Support/authCookie'

/**
 * Email/password sign-in, registered at POST /api/auth/login (routes/auth.ts).
 *
 * Replaces the old login.stx page action. loghq is server-rendered stx with no
 * client hydration, so on success the issued bearer is mirrored into the
 * HttpOnly `auth-token` cookie (see authCookie.ts) — that cookie IS the session
 * every server-rendered page and every same-origin dashboard fetch
 * authenticates from. There is no localStorage token and no Authorization
 * header anywhere in the client any more.
 *
 * `Auth.attempt` carries the rate limiting (RateLimiter, keyed by email) and
 * verifies credentials WITHOUT minting a token, so a 2FA-enabled account never
 * gets a token pack before its TOTP code is also checked.
 */
export default new Action({
  name: 'LoginAction',
  description: 'Login to the application',
  method: 'POST',

  validations: {
    email: {
      rule: schema.string().email(),
      message: 'Email must be a valid email address.',
    },
    password: {
      rule: schema.string().min(6).max(255),
      message: 'Password must be between 6 and 255 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const email = String(request.get('email') ?? '').trim()
    const password = String(request.get('password') ?? '')

    const isValid = await Auth.attempt({ email, password })
    if (!isValid)
      return response.unauthorized('Invalid email or password.')

    const authedUser = await User.where('email', '=', email).first()
    if (!authedUser)
      return response.unauthorized('Invalid email or password.')

    // 2FA is dormant in loghq (no enrolment UI), but wired so a 2FA-enabled
    // account can never lock itself out. getTwoFactorState reads two_factor_*
    // columns that may not exist on this database yet — treat any failure as
    // "not enabled" so a normal login is never broken by their absence.
    let twoFactorEnabled = false
    try {
      twoFactorEnabled = (await getTwoFactorState(authedUser.id as number)).enabled
    }
    catch {
      twoFactorEnabled = false
    }

    if (twoFactorEnabled) {
      const challengeToken = await createTwoFactorChallenge(authedUser.id as number)
      return response.json({
        requires_two_factor: true,
        challenge_token: challengeToken,
      })
    }

    // Session length is set once, here, from the "remember me" checkbox: a week
    // by default, 30 days when checked. See sessionExpiryMinutes.
    const expiresInMinutes = sessionExpiryMinutes(request.get('remember'))
    const result = await Auth.loginUsingId(authedUser.id as number, { expiresInMinutes })
    if (!result)
      return response.unauthorized('Invalid email or password.')

    const user = result.user

    return response.json(
      {
        access_token: result.token,
        token_type: 'Bearer',
        expires_in: result.expiresIn,
        token: result.token,
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
        },
      },
      { status: 200, headers: { 'Set-Cookie': buildAuthCookie(result.token, result.expiresIn) } },
    )
  },
})
