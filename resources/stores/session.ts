/**
 * Session store — the auth token and the cached viewer.
 *
 * Same file contract as theme.ts: no value imports (they are deleted before
 * transpile), no reserved filename, and every top-level name here must be unique
 * across resources/stores/*.ts, because the loader concatenates them into one
 * shared IIFE.
 *
 * WHY THE TOKEN IS A COOKIE AND THE USER IS LOCALSTORAGE
 *
 * useLocalStorage JSON.parses on read and JSON.stringifies on write
 * (signals.js:3526-3539), unguarded. loghq stores the token as a RAW string, so
 * useLocalStorage('token') would throw SyntaxError on every existing session —
 * verified, not assumed — and would then write it back quoted, changing the
 * format for the server too. `user` is already JSON, so it is safe.
 *
 * useCookie has no JSON layer at all (signals.js:3568+): it encodes with
 * encodeURIComponent and decodes symmetrically. It is the right home for a
 * bearer token, and it is where the token already had to live — every
 * server-rendered page authenticates from the loghq_token cookie. Making the
 * cookie the single source of truth removes the localStorage copy, the
 * mirror-into-a-cookie step, and the full page reload that followed it.
 *
 * The pre-paint auth guards still read document.cookie directly. That is
 * deliberate and is the one sanctioned exception: they run before the runtime
 * exists, so no composable is available to them, and their whole job is to leave
 * the page before it is worth rendering.
 */

function registerSessionStore() {
  defineStore('session', () => {
    // Reached through window.stx, not called bare. useCookie is the one
    // composable loghq uses that is NOT assigned to window as a global — it
    // exists only on window.stx and reaches <script client> blocks through
    // auto-import destructuring. Store bundles are injected raw, with no
    // auto-import pass, so calling it bare here is a ReferenceError. Verified
    // by shipping exactly that bug.
    const cookie = window.stx.useCookie

    // 30 days, matching what the hand-serialised writes used. useCookie adds
    // path=/, SameSite=Lax and — only on https — Secure, which is the exact
    // string that was being retyped at every call site.
    const token = cookie('loghq_token', { maxAge: 2592000, sameSite: 'Lax' })

    // Which project the dashboard and settings pages are looking at. A browsing
    // preference, not a credential, so it gets a year.
    const project = cookie('loghq_project', { maxAge: 31536000, sameSite: 'Lax' })

    // Safe under useLocalStorage: this value is already written as JSON. The
    // default is widened so the signal is MeUser | null rather than null.
    const user: StxSignal<MeUser | null> = useLocalStorage('user', null as MeUser | null)

    // ---- the viewer -------------------------------------------------------
    // GET /api/me was fetched independently by account.stx and dashboard.stx,
    // each with its own `pro` signal, so navigating between the two refetched
    // every time and the two copies could disagree. It lives here now: one
    // request per page load, shared across SPA navigations because the store
    // registry survives a fragment swap.
    //
    // Deliberately a plain fetch rather than useQuery. useQuery throws
    // `HTTP <status>: <statusText>` on any non-2xx and never reads the body, so
    // the 401 branch below — which must clear the session, not just report an
    // error — would have to be recovered by pattern-matching an error string.
    // The caching useQuery would buy is what this store already provides.
    const viewer: StxSignal<MeUser | null> = state(null as MeUser | null)
    const pro = state(false)
    const viewerLoaded = state(false)

    // In-flight de-duplication. A `viewerLoaded()` check alone is not enough:
    // two callers that arrive before the first response lands both pass it and
    // both fetch. Measured — /account issued two /api/me requests. Holding the
    // promise means every caller after the first awaits the same request.
    let viewerRequest: Promise<void> | null = null

    async function loadViewer(): Promise<void> {
      const bearer = token()
      if (!bearer || viewerLoaded())
        return
      if (viewerRequest)
        return viewerRequest
      viewerRequest = fetchViewer(bearer).finally(() => { viewerRequest = null })
      return viewerRequest
    }

    async function fetchViewer(bearer: string): Promise<void> {
      try {
        const res = await fetch('/api/me', { headers: { Authorization: `Bearer ${bearer}` } })
        if (res.status === 401) {
          // Stale token. Clearing it through the signal also clears the cookie
          // the server authenticates from.
          token.set('')
          ;(navigate as StxNavigate)('/login', true)
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
      token,
      project,
      user,
      viewer,
      pro,
      viewerLoaded,
      loadViewer,
      isAuthed: derived(() => !!token()),

      /**
       * Clear the session locally and leave. The revoke request is
       * fire-and-forget on purpose: the credentials are being discarded either
       * way, so a failed or slow revoke must not strand someone on a page they
       * have already logged out of.
       */
      signOut() {
        const bearer = token()
        if (bearer) {
          fetch('/logout', { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } })
            .catch(() => {})
        }
        batch(() => {
          token.set('')
          user.set(null)
          viewer.set(null)
          pro.set(false)
          viewerLoaded.set(false)
        })
        // forceReload, not a fragment swap: signing out should drop every
        // signal and cached query in memory, not carry them to the next page.
        // The boolean is what the function actually reads — see StxNavigate in
        // types/stx-runtime.d.ts for why the declared signature disagrees.
        ;(navigate as StxNavigate)('/login', true)
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
