import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
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

    return response.json({
      user: {
        id: (user as any).id,
        name: (user as any).name,
        email: (user as any).email,
        avatar: profile.avatar ?? (user as any).avatar ?? null,
        provider: profile.provider ?? null,
        created_at: profile.created_at ?? null,
      },
      pro,
      plan: pro ? 'pro' : 'free',
    })
  },
})
