import { env } from '@stacksjs/env'

/**
 * Canonical public URLs for things we render or email out (join links, alert
 * links, reset links, the ingest snippet on the settings page).
 *
 * These must be ABSOLUTE (scheme + host) to be usable in an email or a copied
 * snippet. `APP_URL` carries that in production (config/cloud.ts sets
 * `https://loghq.org`), but in local dev it's a bare host (`loghq.localhost`),
 * so we only trust it when it actually looks like a URL and otherwise fall back
 * to the local dev servers.
 */
function abs(value: unknown, fallback: string): string {
  const s = String(value || '').trim().replace(/\/$/, '')
  return /^https?:\/\//.test(s) ? s : fallback
}

/**
 * Local dev fallbacks are derived from the same env vars the servers actually
 * bind (see config/ports.ts: `frontend: env.PORT ?? 3000`, `api: env.PORT_API ??
 * 3008`). They used to be hardcoded to :3100 and :3108 — a hundred off the real
 * ports — so every emailed join link and reset link pointed at a port nothing
 * was listening on. Deriving them means changing PORT in .env cannot silently
 * desync the links from the server again.
 */
const devAppPort = env.PORT ?? 3000
const devApiPort = env.PORT_API ?? 3008

/** Public web-app base — dashboard, join links, reset links. */
export function appUrl(): string {
  return abs(env.APP_URL, `http://localhost:${devAppPort}`)
}

/**
 * Public base where the ingest API (`POST /logs`) is served — a separate
 * host/port from the web app in local dev. Prefers an explicit
 * `LOGHQ_INGEST_URL`, then `APP_URL` (same domain in prod), then the local
 * ingest server.
 */
export function ingestUrl(): string {
  return abs(env.LOGHQ_INGEST_URL || env.APP_URL, `http://localhost:${devApiPort}`)
}
