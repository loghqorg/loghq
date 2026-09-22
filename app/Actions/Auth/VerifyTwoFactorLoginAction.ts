import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth, consumeTwoFactorChallenge, verifyTwoFactorLoginCode } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { buildAuthCookie, sessionExpiryMinutes } from './authCookie'

/**
 * Exchange a LoginAction 2FA challenge + TOTP code for a real session,
 * registered at POST /api/auth/verify-two-factor-login (routes/auth.ts).
 *
 * Dormant in loghq (there is no enrolment UI), but wired end to end so a
 * 2FA-enabled account completing step two is signed in exactly like the
 * single-step path: the same HttpOnly `auth-token` cookie, the same
 * remember-me tier. See LoginAction / authCookie.ts.
 */
export default new Action({
  name: 'VerifyTwoFactorLoginAction',
  description: 'Exchange a LoginAction 2FA challenge + TOTP code for a real token pack',
  method: 'POST',

  validations: {
    challenge_token: {
      rule: schema.string().min(1),
      message: 'A challenge token is required.',
    },
    code: {
      rule: schema.string().min(6).max(6),
      message: 'Code must be a 6-digit TOTP code.',
    },
  },

  async handle(request: RequestInstance) {
    const challengeToken = request.get('challenge_token')
    const code = request.get('code')

    // Single-use: a second attempt with the same challenge token (right code or
    // wrong) must start over from LoginAction, not retry.
    const userId = await consumeTwoFactorChallenge(challengeToken)
    if (!userId)
      return response.unauthorized('This login attempt has expired — please sign in again.')

    const valid = await verifyTwoFactorLoginCode(userId, code)
    if (!valid)
      return response.unauthorized('Invalid code — please sign in again.')

    // Carry the "remember me" tier chosen on step one through to the session
    // issued here, so a 2FA account is not silently downgraded to the baseline
    // week. The login page re-sends the checkbox with the TOTP code.
    const expiresInMinutes = sessionExpiryMinutes(request.get('remember'))
    const result = await Auth.loginUsingId(userId, { expiresInMinutes })
    if (!result)
      return response.unauthorized('Invalid code — please sign in again.')

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
