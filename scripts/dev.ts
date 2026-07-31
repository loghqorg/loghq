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
