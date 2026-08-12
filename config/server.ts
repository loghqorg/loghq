import type { ServerConfig } from '@stacksjs/types'

/**
 * **Server Options** - `config/server.ts`.
 *
 * How the views server decides what it renders itself and what it hands to the
 * API server.
 *
 * WHY THIS FILE EXISTS AT ALL
 *
 * It did not, until page actions (stacksjs/stx#1847) arrived. The framework
 * default is `methods: ['POST','PUT','PATCH','DELETE']`, and the matcher tests
 * the method FIRST:
 *
 *   if (rules.methods.has(req.method)) return true      // path never consulted
 *   if (rules.paths.includes(pathname)) return true
 *   return rules.prefixes.some(p => matchesPrefix(pathname, p))
 *
 * So every POST was proxied to the API before a page could render, and a page
 * action — which runs inside the page render — could never fire. Emptying
 * `methods` is the only way to let one run; there is no per-path exemption from
 * the method rule.
 *
 * WHAT THAT COSTS, AND WHY IT IS SAFE HERE
 *
 * With `methods` empty, every non-GET route the API owns has to be named below
 * or it stops being proxied and 404s against the views server. The list was
 * derived by enumerating every `route.*` in routes/, not by memory:
 *
 *   routes/api.ts       auto-prefixed /api        -> covered by the prefix
 *   routes/projects.ts  all under /api/           -> covered by the prefix
 *   routes/auth.ts      NOT prefixed              -> named individually
 *   routes/logs.ts      POST /logs (SDK ingest)   -> named
 *   routes/buddy.ts     POST /jobs/{id}/cancel|retry, parameterised -> prefix
 *
 * `paths` is matched exactly and IGNORES THE METHOD, so a path listed here
 * takes its GET with it. That is why `/login` and `/register` are absent: they
 * are the only two paths in the app that have both a POST route and a GET page,
 * and listing them would proxy the sign-in page itself away. They are page
 * actions now — the page handles its own POST — which is what made emptying
 * `methods` possible without breaking them.
 *
 * Do not add a path here without checking `resources/views/` for a page of the
 * same name first. The failure is silent: the page stops rendering and the
 * proxy answers with whatever the API says about a GET it does not serve.
 */
export default {
  proxy: {
    // Everything the API owns under its own namespace.
    prefixes: [
      '/api/',
      // POST /jobs/{id}/cancel and /retry are parameterised, so an exact path
      // cannot match them. No page lives under /jobs.
      '/jobs/',
    ],

    // Non-GET API routes that sit outside /api/, each verified to have no page
    // of the same name in resources/views/.
    paths: [
      '/logout',
      '/password/forgot',
      '/password/reset',
      '/payments/checkout',
      '/webhooks/stripe',
      // The SDK ingest endpoint. Third parties post here; it must never be
      // answered by a rendered page.
      '/logs',
    ],

    // Deliberately empty — see the note above. This is the whole reason the
    // file exists, and reinstating a method here disables every page action in
    // the app in one line, silently.
    methods: [],
  },
} satisfies ServerConfig
