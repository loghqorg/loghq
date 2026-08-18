import type { DnsConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **DNS Options** — declarative mirror of loghq.org's live Porkbun zone.
 *
 * IMPORTANT: `buddy deploy` already manages most of this zone automatically:
 *   - the apex + `www` A records are upserted to the provisioned box IP,
 *   - mail routing (MX → mail.loghq.org, SPF, DKIM, DMARC) is published by the
 *     deploy's mail step,
 *   - the `cloud.loghq.org` dashboard host is set by its own site.
 *
 * The deploy applies whatever's in the arrays below ADDITIVELY, and it does so
 * once per site domain (apex AND cloud.loghq.org, …). So any record here is
 * also created under every non-apex site — e.g. a `www` entry would spawn a
 * stray `www.cloud.loghq.org`. To avoid that we only declare the apex here (a
 * no-op re-affirm of what the deploy already set) and leave the rest to the
 * deploy. The full intended zone is documented in comments for reference.
 *
 * `APP_SERVER_IP` / `STAGING_SERVER_IP` (set in the encrypted .env.production)
 * pin the box IPs so this file never falls back to a stale address.
 */
// String(): env values are typed `string | number | true`, and DnsConfig's
// `address` is a plain `string`. Coerced explicitly rather than relying on the
// value happening to be a string at runtime.
//
// There is deliberately no fallback address. This used to read
// `env.APP_SERVER_IP || '91.98.39.176'`, and that literal is bughq's live
// server, not loghq's. It resolved on every run from this tree. Ordering
// masked it, because the deploy upserts the real box IP first and this sync is
// additive (create-or-keep, never update), so it planned "keep" and never
// compared the address. It became a genuinely wrong write the moment that
// earlier write failed or went unverified, or a new site domain had no A
// record yet, at which point loghq's zone would point at bughq's box.
//
// Unset APP_SERVER_IP now emits no A record at all. The deploy upserts the
// apex itself, so declaring nothing here is safe; declaring someone else's
// address is not.
const boxIp = env.APP_SERVER_IP ? String(env.APP_SERVER_IP) : null

export default {
  // Apex only — the deploy also upserts `@` and `www` to the box IP.
  a: boxIp
    ? [{ name: '@', address: boxIp, ttl: 600 }]
    : [],
  aaaa: [],
  cname: [],

  // Mail is published by the deploy's mail step; declaring MX/TXT here would
  // additively duplicate them under every site subdomain. Documented only:
  //   MX     @                 → mail.loghq.org (prio 10)
  //   TXT    @                 → v=spf1 ip4:<box> ~all
  //   TXT    mail._domainkey   → v=DKIM1; k=rsa; p=…
  //   TXT    _dmarc            → v=DMARC1; p=quarantine; rua=mailto:noreply@loghq.org
  mx: [],
  txt: [],

  // Registrar delegation (Porkbun); the deploy never writes nameservers.
  nameservers: [
    'curitiba.porkbun.com',
    'fortaleza.porkbun.com',
    'maceio.porkbun.com',
    'salvador.porkbun.com',
  ],
} satisfies DnsConfig
