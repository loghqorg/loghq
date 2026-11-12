import process from 'node:process'

/**
 * The address a request came from, for per-IP quotas.
 *
 * Moved out of routes/logs.ts when routes/hq.ts needed the same answer: two
 * copies of "which hop do we trust" is one that gets updated and one that
 * does not.
 *
 * `X-Forwarded-For` is only as trustworthy as the number of proxies in front
 * of the app. With `TRUSTED_PROXY_HOPS` proxies, the client is that many
 * entries from the right; anything further left was written by the caller.
 */
const TRUSTED_PROXY_HOPS = Math.max(0, Number(process.env.TRUSTED_PROXY_HOPS ?? 1))

export function clientIp(request: any): string {
  const direct = request.headers?.get('x-real-ip') || request.ip || 'unknown'
  if (TRUSTED_PROXY_HOPS === 0)
    return direct
  const xff = request.headers?.get('x-forwarded-for')
  if (xff) {
    const hops = String(xff).split(',').map((s: string) => s.trim()).filter(Boolean)
    if (hops.length) {
      const idx = hops.length - TRUSTED_PROXY_HOPS
      return hops[idx >= 0 ? idx : 0]
    }
  }
  return direct
}
