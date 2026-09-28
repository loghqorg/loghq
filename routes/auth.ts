import { passwordResets } from '@stacksjs/auth'
import { response, route } from '@stacksjs/router'

/**
 * Uniform cookie-session auth (matches statushq and the other HQ apps).
 *
 * Sign-in, sign-up and 2FA are custom API actions under the proxied `/api/`
 * prefix (config/server.ts). login.stx / register.stx are now client-fetch
 * forms that POST here with `credentials: 'same-origin'`; on success each
 * action returns a single HttpOnly `auth-token` cookie (see
 * Support/authCookie.ts) that IS the session — there is no localStorage
 * token, no Authorization header and no refresh exchange anywhere.
 *
 * `.skipCsrf()` stays: the endpoints are same-origin fetches, and the cookie
 * they set is SameSite=Lax, which is the CSRF barrier for the state-changing
 * routes it later authenticates. `Auth.attempt` inside LoginAction carries its
 * own per-email rate limiting; the `.rateLimit(...)` here adds an IP bucket on
 * top. User route files load before the framework defaults, so these win on any
 * duplicate method+path.
 */
route.post('/api/auth/login', 'Actions/Auth/LoginAction').skipCsrf().rateLimit(5, 'minute')
route.post('/api/auth/register', 'Actions/Auth/RegisterAction').skipCsrf().rateLimit(5, 'minute')
route.post('/api/auth/verify-two-factor-login', 'Actions/Auth/VerifyTwoFactorLoginAction').skipCsrf().rateLimit(10, 'minute')

// Logout is still a same-origin fetch from the session store's signOut(); the
// custom LogoutAction revokes the token and clears the HttpOnly cookie.
route.post('/logout', 'Actions/Auth/LogoutAction').skipCsrf()
route.get('/api/me', 'Actions/MeAction').skipCsrf()

// Password reset. The send side uses the framework's passwordResets helper
// directly: it is anti-enumeration by design (unknown emails are a silent
// no-op), so this endpoint always answers with the same message and never
// reveals whether an account exists. The reset side reuses the framework's
// default action (hashed single-use tokens, expiry, session revocation).
// The emailed link points at /reset-password (config/auth.ts passwordReset.url).
route.post('/password/forgot', async (request: any) => {
  const email = String((request.jsonBody ?? {}).email ?? '').trim().toLowerCase()
  const uniform = { success: true, message: 'If an account exists for that email, a reset link is on its way.' }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return response.json(uniform)
  try {
    await passwordResets(email).sendEmail()
  }
  catch (err) {
    // Transport failure must not leak account existence; surface it in the
    // server log only.
    console.error('[password/forgot] send failed:', err instanceof Error ? err.message : err)
  }
  return response.json(uniform)
}).skipCsrf().rateLimit(3, 'minute')
route.post('/password/reset', 'Actions/Password/PasswordResetAction').skipCsrf().rateLimit(5, 'minute')

// Social sign-in (GitHub, Google) via the native @stacksjs/socials drivers.
// GET flows, CSRF-exempt; provider credentials come from config/services.ts.
route.get('/api/auth/{provider}/redirect', 'Actions/Auth/SocialRedirectAction').skipCsrf()
route.get('/api/auth/{provider}/callback', 'Actions/Auth/SocialCallbackAction').skipCsrf()

// Billing (Stripe). Checkout requires an authenticated user (bearer token);
// the webhook is a Stripe callback so it skips CSRF and auth.
route.post('/payments/checkout', 'Actions/Payment/CreateCheckoutAction').middleware('auth').skipCsrf()
route.post('/webhooks/stripe', 'Actions/StripeWebhook').skipCsrf()
