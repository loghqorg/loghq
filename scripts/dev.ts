#!/usr/bin/env bun
/**
 * Fast local dev for this frontend-less stx app.
 *
 * `./buddy dev` advertises a Vue/Vite frontend on :3100 that never binds for
 * a pure-stx app, then blocks the "ready" banner on a hardcoded 30s timeout
 * (readinessTimeoutMs in @stacksjs/buddy) — ~46s to boot, and the :3100 URL it
 * prints refuses connections. See stacksjs/stacks#2036.
 *
 * This starts the two servers that actually matter, directly, in ~2s:
 *   - Views + public assets → PORT      (@stacksjs/actions dev/views.js)
 *   - API / SSR pages       → PORT_API  (@stacksjs/actions dev/api.js)
 *
 * Open the views URL — that server serves public/marketing.css and proxies
 * app/SSR routes to the API, so the whole styled site is there.
 *
 * The ports are read from the environment rather than hardcoded here. They
 * used to be printed as :3100/:3108, which did not match config/ports.ts
 * (`frontend: env.PORT ?? 3000`, `api: env.PORT_API ?? 3008`) or the committed
 * .env. A wrong URL in the banner is worse than no URL: it sends you to a port
 * nothing is listening on, or — if another Stacks app happens to be running
 * there — to a different project's pages that look plausibly like your own.
 *
 * TWO KNOWN DEV-ONLY BREAKAGES, both in the shipped servers, neither present
 * in production. Verified against the installed build, not assumed:
 *
 * 1. `/docs` returns 500 here and works in production.
 *    dev/views.js:97-98 proxies `/docs` and `/docs/*` to PORT_DOCS
 *    (config/ports.ts → 3006) unconditionally, before any routing, and nothing
 *    listens on that port. resources/views/docs.stx is therefore unreachable
 *    in dev. There is no flag to turn it off — the check ignores config/ui.ts
 *    entirely. @stacksjs/buddy/dist/production-server.js has no such proxy
 *    (grep: zero hits), so the page serves normally once deployed.
 *
 * 2. The API server renders stx pages with broken @include.
 *    dev/api.js never passes componentsDir/layoutsDir/partialsDir, so includes
 *    resolve against pagesDir — `resources/views/partials/SiteNav.stx`, which
 *    does not exist — and the page body becomes an include error. views.js
 *    sets all three (72-74), as does production-server.js (131-133), so this
 *    is specific to :3008.
 *
 *    It is not user-facing: open the views URL, which is what the banner
 *    prints. Every page there renders with zero include errors. It matters
 *    only if you curl :3008 directly for a PAGE — for /api routes, which is
 *    what that server is for, it is irrelevant.
 */
const env = { ...process.env, STACKS_DEV_SERVER: '1' }
const opts = { env, stdout: 'inherit', stderr: 'inherit' } as const

const viewsPort = env.PORT ?? '3000'
const apiPort = env.PORT_API ?? '3008'

const api = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/api.js'], opts)
const views = Bun.spawn(['bun', 'node_modules/@stacksjs/actions/dist/dev/views.js'], opts)

console.log(`\n  loghq dev\n    → http://localhost:${viewsPort}   (full styled site: app + marketing)\n    → http://localhost:${apiPort}   (API only)\n`)

function shutdown() {
  api.kill()
  views.kill()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// If either server exits on its own, tear the other down too.
await Promise.race([api.exited, views.exited])
shutdown()
