import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { getTwoFactorState } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { Payment } from '@stacksjs/payments'
import { response } from '@stacksjs/router'
import { userFromRequest } from '../Support/request-auth'

/**
 * Return the authenticated user plus their Pro status. The dashboard calls this
 * to gate Pro features and reflect the plan after a successful checkout. Pro is
 * true when a local `subscriptions` row for this user (type 'default') is
 * active/trialing — kept in sync by the Stripe webhook.
 */
export default new Action({
  name: 'MeAction',
  description: 'Return the current user and their Pro status',
  method: 'GET',
  async handle(request: RequestInstance) {
    // Resolve from either carrier: an external bearer header, or the HttpOnly
    // `auth-token` cookie the dashboard sends on same-origin fetches. /api/me
    // has no `.middleware('auth')`, so the resolution happens here.
    const user = await userFromRequest(request)
    if (!user)
      return response.unauthorized('Authentication required')

    let pro = false
    try {
      pro = await Payment.hasActiveSubscription(user as any, 'default')
    }
    catch {
      pro = false
    }

    // Enrich with profile fields the account page shows (avatar + which
    // provider the account signed in with). Tolerate columns not existing yet.
    let profile: any = {}
    try {
      profile = await db.selectFrom('users')
        .where('id', '=', (user as any).id)
        .select(['avatar', 'provider', 'created_at'])
        .executeTakeFirst() ?? {}
    }
    catch {
      profile = {}
    }

    // Only `enabled` reaches the client: getTwoFactorState also returns the TOTP
    // secret, which must never leave the server. The account page needs to know
    // whether to show "set up" or "turn off", nothing more. Fails closed (shows
    // "off") on a read error rather than hiding an enabled factor - the safer
    // wrong answer, since it offers re-setup and never implies a protection that
    // is not there.
    const twoFactor = await getTwoFactorState(Number((user as any).id)).catch(() => ({ enabled: false }))

    return response.json({
      user: {
        id: (user as any).id,
        name: (user as any).name,
        email: (user as any).email,
        avatar: profile.avatar ?? (user as any).avatar ?? null,
        provider: profile.provider ?? null,
        created_at: profile.created_at ?? null,
        two_factor_enabled: Boolean(twoFactor.enabled),
      },
      pro,
      plan: pro ? 'pro' : 'free',
    })
  },
})
