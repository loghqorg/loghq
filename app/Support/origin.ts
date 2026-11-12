import { env } from '@stacksjs/env'
import { appUrl } from './urls'

/**
 * Is this request's `Origin` one of ours?
 *
 * A CSRF guard for a cookie-authenticated JSON endpoint: a browser attaches
 * `Origin` to every cross-site POST, so refusing the ones that are not ours
 * stops a third-party page driving the endpoint with the visitor's session.
 * A request with no `Origin` passes, because that is what a server-to-server
 * call and curl look like, and the endpoint behind this still needs a session.
 *
 * Compared against configuration, not the `Host` header: behind the proxy the
 * app sees `Host: localhost:<port>` while the browser sends the public origin,
 * so the two can never match in production. `APP_URL` is the statement of who
 * this application is, and every absolute link is already built from it
 * (./urls.ts).
 */
export function sameOrigin(request: { headers?: { get?: (name: string) => string | null } }): boolean {
  const origin = request.headers?.get?.('origin')
  if (!origin)
    return true
  try {
    return allowedHosts().has(new URL(origin).host)
  }
  catch {
    // A malformed Origin is not something any browser of ours sent.
    return false
  }
}

/** Read on every call: config overrides resolve after module load. */
function allowedHosts(): Set<string> {
  const hosts = new Set<string>()
  for (const configured of [env.APP_URL, env.APP_DOMAIN, appUrl()]) {
    const raw = String(configured ?? '').trim()
    if (!raw)
      continue
    try {
      // APP_URL carries a scheme in production and is a bare host in local dev.
      hosts.add(new URL(raw.includes('://') ? raw : `https://${raw}`).host)
    }
    catch {}
  }
  // `www.` alongside the bare host: the redirect to the apex happens after the
  // browser has already chosen the Origin it sends.
  for (const host of [...hosts])
    hosts.add(host.startsWith('www.') ? host.slice(4) : `www.${host}`)
  return hosts
}
