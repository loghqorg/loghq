/**
 * Session store — the cached viewer and the current-project browsing preference.
 *
 * Same file contract as theme.ts: no value imports (they are deleted before
 * transpile), no reserved filename, and every top-level name here must be unique
 * across resources/stores/*.ts, because the loader concatenates them into one
 * shared IIFE.
 *
 * THERE IS NO CLIENT TOKEN
 *
 * The session is a single HttpOnly `auth-token` cookie the server sets at
 * sign-in (see app/Actions/Auth/authCookie.ts). It is invisible to JavaScript
 * by design, so the client cannot read it, cannot attach a bearer and cannot
 * clear it — the browser sends it automatically on every same-origin request,
 * and only the server LogoutAction can remove it. Every authenticated data call
 * therefore rides the cookie: `credentials: 'same-origin'`, no Authorization
 * header anywhere. This replaced the old readable `loghq_token` cookie + bearer
 * plumbing wholesale.
 *
 * The only cookie this store still owns is `loghq_project`, a browsing
 * preference (which project the dashboard is looking at), not a credential.
 */

function registerSessionStore() {
  defineStore('session', () => {
    // Which project the dashboard and settings pages are looking at. A browsing
    // preference, not a credential, so it gets a year and stays readable.
    const project = useCookie('loghq_project', { maxAge: 31536000, sameSite: 'Lax' })

    // ---- the viewer -------------------------------------------------------
    // GET /api/me was fetched independently by account.stx and dashboard.stx,
    // each with its own `pro` signal, so navigating between the two refetched
    // every time and the two copies could disagree. It lives here now: one
    // request per page load, shared across SPA navigations because the store
    // registry survives a fragment swap.
    const viewer: StxSignal<MeUser | null> = state(null as MeUser | null)
    const pro = state(false)
    const viewerLoaded = state(false)

    // One place authentication is carried, and one place a signed-out response
    // is noticed. Applies to every stx data primitive — useFetch, useQuery,
    // useMutation all route through the same __stxFetch — so a call site says
    // what it wants and never how to authenticate.
    //
    // onRequest sends the HttpOnly cookie (credentials: 'same-origin') and NO
    // Authorization header — there is no client token to attach. onResponseError
    // treats a 401 as a stale/absent session: the cookie the browser sent did
    // not resolve a user, so clear the cached viewer and leave for /login. The
    // cookie itself cannot be cleared here (HttpOnly); the server owns that.
    configureFetch({
      onRequest(ctx: StxFetchRequestContext) {
        ctx.options.credentials = 'same-origin'
      },
      onResponseError(ctx: StxFetchErrorContext) {
        if (ctx.response?.status !== 401)
          return
        batch(() => {
          viewer.set(null)
          pro.set(false)
          viewerLoaded.set(false)
        })
        navigate('/login', { reload: true })
      },
    })

    // In-flight de-duplication. A `viewerLoaded()` check alone is not enough:
    // two callers that arrive before the first response lands both pass it and
    // both fetch. Measured — /account issued two /api/me requests. Holding the
    // promise means every caller after the first awaits the same request.
    let viewerRequest: Promise<void> | null = null

    async function loadViewer(): Promise<void> {
      if (viewerLoaded())
        return
      if (viewerRequest)
        return viewerRequest
      viewerRequest = fetchViewer().finally(() => { viewerRequest = null })
      return viewerRequest
    }

    async function fetchViewer(): Promise<void> {
      try {
        const res = await fetch('/api/me', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        if (res.status === 401) {
          // Signed out. The cookie is HttpOnly, so there is nothing to clear
          // client-side — just leave.
          navigate('/login', { reload: true })
          return
        }
        if (!res.ok)
          return
        const data = await res.json()
        if (!data?.user)
          return
        batch(() => {
          viewer.set(data.user)
          pro.set(data.pro === true)
          viewerLoaded.set(true)
        })
      }
      catch {}
    }

    return {
      project,
      viewer,
      pro,
      viewerLoaded,
      loadViewer,

      /**
       * Clear the cached viewer and leave. The revoke request is
       * fire-and-forget on purpose: the session is being discarded either way,
       * so a failed or slow revoke must not strand someone on a page they have
       * already logged out of. The server LogoutAction clears the HttpOnly
       * cookie; the client cannot.
       */
      signOut() {
        fetch('/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
        batch(() => {
          viewer.set(null)
          pro.set(false)
          viewerLoaded.set(false)
        })
        // reload, not a fragment swap: signing out should drop every signal and
        // cached query in memory, not carry them to the next page.
        navigate('/login', { reload: true })
      },
    }
  })
}

// Same guard as theme.ts: on the pages that hand-write their own document the
// store bundle is injected before the signals runtime, so defineStore is not yet
// defined. See resources/stores/theme.ts for the full explanation.
if (typeof defineStore === 'function')
  registerSessionStore()
else
  document.addEventListener('DOMContentLoaded', registerSessionStore, { once: true })
