import type { RequestInstance } from '@stacksjs/types'
import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import { clearAuthCookie } from '../../Support/authCookie'

/**
 * Project override of the framework's default LogoutAction — same token
 * revocation, plus clearing the HttpOnly `auth-token` cookie the auth actions
 * set (see authCookie.ts). The cookie is HttpOnly, so only the server can clear
 * it: the client signOut() just calls this and reloads.
 */
export default new Action({
  name: 'LogoutAction',
  description: 'Logout from the application',
  method: 'POST',
  async handle(request: RequestInstance) {
    await Auth.logout()

    const clearCookie = clearAuthCookie()

    // A plain full-page <form method="POST"> logout is a navigation, not an
    // XHR, so returning JSON would render the raw payload in the browser.
    // Redirect browser navigations to /login; XHR/API callers (Accept:
    // application/json) still get JSON.
    const accept = String(request.headers?.get?.('accept') ?? '')
    if (accept.includes('text/html')) {
      return new Response(null, {
        status: 302,
        headers: { 'Location': '/login', 'Set-Cookie': clearCookie },
      })
    }

    return response.json(
      { message: 'Successfully logged out' },
      { status: 200, headers: { 'Set-Cookie': clearCookie } },
    )
  },
})
