/**
 * loghq: the HQ connect and usage endpoints (`@stacksjs/hq/service`).
 *
 *   POST /api/cli/connect                 -> { code, approveUrl, confirmCode }
 *   GET  /api/cli/connect/{code}          -> pending | approved + keys (once) | expired
 *   GET  /api/v1/usage      (read key)    -> [{ meter, used, limit, period, state, upgradeUrl }]
 *   POST /api/cli/connect/{code}/approve  -> the approve page's action (signed-in user)
 *
 * `buddy hq:connect` drives the first two; an app's own dashboard reads the
 * third with its project's read key. All of them live under /api because the
 * public origin only routes /api/* to this server (see the health routes in
 * routes/logs.ts).
 */

import type { HqRequest } from '@stacksjs/hq/service'
import { route } from '@stacksjs/router'
import { rateLimit } from '../app/Errors/limits'
import { ConnectRefusedError } from '../app/Hq/adapter'
import { confirmationCode, confirmationMatches } from '../app/Hq/confirm'
import { hq } from '../app/Hq/service'
import { clientIp } from '../app/Support/client-ip'
import { sameOrigin } from '../app/Support/origin'
import { userFromRequest } from '../app/Support/request-auth'

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  })
}

/**
 * The router has already read the body into `jsonBody`, so the stream the
 * package would call `json()` on is spent. Hand it what was parsed.
 */
function hqRequest(request: any): HqRequest {
  return {
    url: String(request.url),
    method: request.method,
    headers: request.headers,
    params: request.params,
    json: async () => request.jsonBody ?? {},
  }
}

// Anyone can ask for a code, and each one is a row until it expires ten
// minutes later. Ten a minute per address is far more than a CLI needs and
// bounds what a script can pile up.
const START_LIMIT = 10
const START_WINDOW_MS = 60_000
// A CLI polls about once a second while the person approves.
const POLL_LIMIT = 120
const POLL_WINDOW_MS = 60_000

route.post('/api/cli/connect', async (request: any) => {
  const limit = await rateLimit(`hq-connect:${clientIp(request)}`, START_LIMIT, START_WINDOW_MS)
  if (!limit.ok)
    return json({ error: 'rate limited' }, 429, { 'Retry-After': String(limit.retryAfter) })
  // The package answers `{ code, approveUrl }`. `confirmCode` is added here:
  // the CLI prints it, and the approve page will not approve until the person
  // has typed it (app/Hq/confirm.ts). It goes ONLY to the caller that asked
  // for the code, never into the approve URL.
  const started = await hq.startConnect(hqRequest(request))
  if (started.status !== 201)
    return started
  const body = await started.json() as { code: string, approveUrl: string }
  return json({ ...body, confirmCode: confirmationCode(body.code) }, 201)
}).skipCsrf() // called by a CLI: no browser, no cookie, nothing to forge

route.get('/api/cli/connect/{code}', async (request: any) => {
  const limit = await rateLimit(`hq-poll:${clientIp(request)}`, POLL_LIMIT, POLL_WINDOW_MS)
  if (!limit.ok)
    return json({ error: 'rate limited' }, 429, { 'Retry-After': String(limit.retryAfter) })
  return hq.pollConnect(hqRequest(request), String(request.params?.code ?? ''))
})

route.get('/api/v1/usage', (request: any) => hq.usage(hqRequest(request)))

// The approve page's button. Cookie-authenticated, so it checks the Origin:
// approving hands a project's keys to whoever holds the code, which is exactly
// what a forged cross-site POST would want. A read key or a read token is not
// a session (userFromRequest refuses both), so neither can approve.
//
// It also needs the confirmation code from the terminal that started the
// connect. Enforced here and not only in the page, so there is no request
// that approves without it. Wrong guesses are limited per person: the code is
// six characters, and ten tries a minute makes guessing it within the ten
// minutes a connect lives a one in several million chance.
const APPROVE_LIMIT = 10
const APPROVE_WINDOW_MS = 60_000

route.post('/api/cli/connect/{code}/approve', async (request: any) => {
  if (!sameOrigin(request))
    return json({ error: 'forbidden' }, 403)
  const user = await userFromRequest(request)
  if (!user)
    return json({ error: 'unauthorized' }, 401)

  const limit = await rateLimit(`hq-approve:${Number(user.id)}`, APPROVE_LIMIT, APPROVE_WINDOW_MS)
  if (!limit.ok)
    return json({ error: 'Too many attempts. Wait a minute and try again.' }, 429, { 'Retry-After': String(limit.retryAfter) })

  const code = String(request.params?.code ?? '')
  if (!confirmationMatches(code, request.jsonBody?.confirm)) {
    return json({
      error: 'That code does not match. Enter the confirmation code your terminal is showing.',
      reason: 'confirmation_mismatch',
    }, 422)
  }

  try {
    const result = await hq.approveConnect(code, { id: Number(user.id) })
    if (!result.ok) {
      return json({
        error: result.reason === 'already_approved'
          ? 'This connection was already approved.'
          : 'This connection request has expired. Run the command again.',
        reason: result.reason,
      }, result.reason === 'already_approved' ? 409 : 410)
    }
    return json({ ok: true, project: result.project })
  }
  catch (error) {
    if (error instanceof ConnectRefusedError)
      return json({ error: error.message, reason: error.reason }, 409)
    console.error('[hq] could not approve connect:', error instanceof Error ? error.message : error)
    return json({ error: 'Could not approve the connection. Please try again.' }, 500)
  }
}).skipCsrf()
