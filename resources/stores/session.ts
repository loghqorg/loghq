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
    // Called bare, as any other composable would be. It could not be until
    // stx#1838: useCookie is one of ~34 composables that live only on
    // window.stx rather than as a bare window global, and store bundles used to
    // be injected with no runtime-globals preamble — so the straightforward
    // call was a ReferenceError, and this file reached through window.stx to
    // work around it. store-loader now emits the same preamble a <script client>
    // block gets, so the workaround is gone.
    //
    // The failure it caused was worth the detour: the throw happens inside the
    // shared store IIFE, so defineStore never completes and what a developer
    // actually sees is "Store not found" from useStore('session') — raised in a
    // different file, which is fine.
    //
    // 30 days, matching what the hand-serialised writes used. useCookie adds
    // path=/, SameSite=Lax and — only on https — Secure, which is the exact
    // string that was being retyped at every call site.
    const token = useCookie('loghq_token', { maxAge: 2592000, sameSite: 'Lax' })

    // Which project the dashboard and settings pages are looking at. A browsing
    // preference, not a credential, so it gets a year.
    const project = useCookie('loghq_project', { maxAge: 31536000, sameSite: 'Lax' })

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
    // Still a plain fetch, but no longer for the reason this comment used to
    // give. The old note said useQuery throws `HTTP <status>: <statusText>` and
    // never reads the body, so a 401 could only be recovered by matching an
    // error string. That was fixed upstream (stx#1848) and is measured false
    // now: the thrown error carries `.status`, `.statusText`, `.data` and
    // `.response`, so `err.status === 401` and `err.data.message` both work.
    //
    // What keeps it a plain fetch is the in-flight de-duplication below. This is
    // the one caller that must collapse concurrent callers onto a single
    // promise, and it owns that promise directly. The caching useQuery offers is
    // what this store already is.
    const viewer: StxSignal<MeUser | null> = state(null as MeUser | null)
    const pro = state(false)
    const viewerLoaded = state(false)

    // One place the bearer token is attached, and one place a stale one is
    // noticed. Applies to every stx data primitive — useFetch, useQuery,
    // useMutation all route through the same __stxFetch — so a call site says
    // what it wants and never how to authenticate.
    //
    // Hooks REPLACE rather than stack, by design upstream: a module re-evaluated
    // by hot reload or re-run after an SPA swap must not end up sending two
    // Authorization headers or counting one 401 twice.
    //
    // The token check in onRequest is not defensive noise. Sign-in and sign-up
    // post to /login and /register with no session, and sending `Bearer ` with
    // an empty value is not the same as sending nothing.
    //
    // The same check in onResponseError is what keeps a *credential* 401 apart
    // from a *session* 401. Bad password at sign-in answers 401 too, and
    // clearing the session there would be harmless but bouncing to /login from
    // /login is not. A 401 while we are holding a token is the stale-session
    // case, and only that one signs out.
    configureFetch({
      onRequest(ctx: StxFetchRequestContext) {
        const bearer = token()
        if (bearer)
          ctx.options.headers.Authorization = `Bearer ${bearer}`
      },
      onResponseError(ctx: StxFetchErrorContext) {
        if (ctx.response?.status !== 401 || !token())
          return
        batch(() => {
          token.set('')
          user.set(null)
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
        // reload, not a fragment swap: signing out should drop every signal and
        // cached query in memory, not carry them to the next page. `replace`
        // would also be defensible here — it would keep the authed page out of
        // history — but it is a fragment swap, so the in-memory state survives.
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
