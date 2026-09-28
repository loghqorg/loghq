import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth, register } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { schema } from '@stacksjs/validation'
import { buildAuthCookie } from '../../Support/authCookie'

/**
 * Account creation, registered at POST /api/auth/register (routes/auth.ts).
 *
 * Replaces the old register.stx page action. Like LoginAction, on success the
 * issued bearer is mirrored into the HttpOnly `auth-token` cookie so the very
 * first server-rendered page after signup is already authenticated. loghq has
 * no teams model, so there is no personal-team creation here — just the account
 * and its session. Where the user lands afterwards (an invited user goes to the
 * dashboard, everyone else to the create-your-first-app page) is decided by the
 * client, which knows the invite context from the URL.
 */
export default new Action({
  name: 'RegisterAction',
  description: 'Register a new user',
  method: 'POST',

  validations: {
    name: {
      rule: schema.string().min(2).max(255),
      message: 'Name must be between 2 and 255 characters.',
    },
    email: {
      rule: schema.string().email(),
      message: 'Email must be a valid email address.',
    },
    password: {
      rule: schema.string().min(8).max(255),
      message: 'Password must be at least 8 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const name = String(request.get('name') ?? '').trim()
    const email = String(request.get('email') ?? '').trim()
    const password = String(request.get('password') ?? '')

    // `register` throws an HttpError for an invalid address, a short password or
    // a duplicate. Its duplicate message is deliberately vague — the framework
    // treats "this email exists" as an enumeration oracle — so surface it as-is.
    let result
    try {
      result = await register({ name, email, password })
    }
    catch (err) {
      return response.json(
        { message: (err as Error)?.message || 'Could not create the account.' },
        { status: 422 },
      )
    }

    if (!result?.token)
      return response.json({ message: 'Could not create the account.' }, { status: 422 })

    // register() returns the token pack but not the user record; resolve it for
    // the response body. The cookie's Max-Age matches the token's own expiry
    // (config baseline — a week), so signup lands on the baseline tier.
    const user = await Auth.getUserFromToken(result.token)

    return response.json(
      {
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
