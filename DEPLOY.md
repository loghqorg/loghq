# Deploying loghq

loghq runs on a **dedicated Hetzner Cloud server**, provisioned and shipped by
**ts-cloud** (`buddy deploy` → `@stacksjs/ts-cloud`), with DNS at **Porkbun** and
push-to-deploy from **GitHub Actions**.

There is no AWS in this path. `config/cloud.ts` still carries AWS-shaped keys
(`region`, `loadBalancer`, `ssl.provider: 'acm'`) because the config type is
shared across providers, but nothing reads them once `provider` is `hetzner`.
Ignore them.

> This document is written from the source of ts-cloud 0.7.114, `config/cloud.ts`,
> and `.github/workflows/deploy.yml`. Behaviour marked **unverified** has not yet
> been observed on a live box.

## Topology

One Hetzner server per environment, running everything:

| Piece | Detail |
|---|---|
| Server | `loghq-production-app`, type `cx23`, image `ubuntu-24.04`, location `fsn1` |
| Firewall | `loghq-production-app-fw`, inbound `80`, `443`, `22` only |
| Edge | **rpx**, a Bun gateway compiled on the box, holding `:80` and `:443` |
| TLS | Let's Encrypt via `@stacksjs/tlsx`, issued on demand, renewed by a timer at 03:30 |
| Database | PostgreSQL installed and supervised by **pantry**, on the same box |
| App | `bun ... buddy serve` on `127.0.0.1:3022` |
| API | `bun ... actions/serve/api.js` on `127.0.0.1:3023` |
| Layout | Capistrano style, `/var/www/loghq-main/{shared,releases,current}` |
| Units | systemd templates, `loghq-main@<sha>.service` and `loghq-loghq-api@<sha>.service` |

Ports 3022 and 3023 are deliberately closed at the firewall. rpx fronts 3022 on
the public domain, and 3023 is reachable only over loopback from the app.

Sites are declared in the `tsCloud` **named export** of `config/cloud.ts`. The
file's `export default` is a separate, intentionally empty `CloudConfig`, so
editing the default export changes nothing about a deploy.

| Site key | Domain | Port | Role |
|---|---|---|---|
| `main` | `loghq.org` | 3022 | The app, stx views plus ingest |
| `loghq-api` | none | 3023 | Loopback API, rpx skips it because it has no domain |
| `www` | `www.loghq.org` | none | Redirect to the apex |

`cloud.loghq.org` serves the ts-cloud management dashboard, set by
`TS_CLOUD_UI_DOMAIN` in the workflow.

## Branch to environment

| Branch | Environment | Flag passed to `buddy deploy` |
|---|---|---|
| `main` | production | `--prod` |
| `stage` | staging | `--staging` |
| `dev` | development | `--dev` |

`workflow_dispatch` can pick an environment manually. Concurrency is grouped per
branch and does not cancel in progress, so two pushes queue rather than race.

## Before the first deploy

### 1. Repository secrets

Set these per GitHub **environment** (`production`, `staging`, `development`):

| Secret | Used for |
|---|---|
| `DEPLOY_SSH_KEY` | Private key authorized on the box. The public half is derived with `ssh-keygen -y`, so one secret is enough |
| `DOTENV_PRIVATE_KEY_PRODUCTION` | Decrypting `.env.production` |
| `DOTENV_PRIVATE_KEY_STAGING` | Decrypting `.env.staging` |
| `DOTENV_PRIVATE_KEY_DEVELOPMENT` | Decrypting `.env.development` |
| `HCLOUD_TOKEN` | Hetzner Cloud API, provisioning and adoption |
| `PORKBUN_API_KEY` | Porkbun DNS |
| `PORKBUN_SECRET_KEY` | Porkbun DNS |

The Hetzner credentials in `config/services.ts` are **not** read on this path,
and the key name there (`apiKey`) does not match what the driver looks for
(`apiToken`). The token comes from `HCLOUD_TOKEN` and nowhere else.

### 2. A real `.env.production`

This is the single most important prerequisite, and its absence fails in a way
that looks like success. Create it, populate it, and encrypt it with dotenvx.

| Variable | Why it matters |
|---|---|
| `APP_KEY` | Generated automatically if missing, but generate it deliberately |
| `APP_SERVER_IP` | The post-deploy step resolves the box from this. Without it the step aborts and **migrations never run** |
| `STAGING_SERVER_IP` | Same, for the staging environment |
| `DB_PASSWORD` | Without it, `config/cloud.ts` falls back to the committed literal `loghq_prod_pw`, and that becomes the real production database password |
| `APP_DOMAIN` | Defaults to `loghq.org` |

The chain when `.env.production` is missing or empty: the pre-flight creates a
comment-only file, `APP_SERVER_IP` stays undefined, the post-deploy step trips
its own `could not resolve server IP` guard, `.env.keys` never lands on the box,
`buddy migrate` never executes, and the framework auth schema the login flow
needs is never created. The app deploys and cannot sign anyone in.

### 3. Fix the `config/dns.ts` fallback

Line 26 is currently:

```ts
const boxIp = String(env.APP_SERVER_IP || '91.98.39.176')
```

That fallback address is **bughq's live server**, not loghq's. It resolves on
every run from this tree. Today it is masked, because ts-cloud writes the real
box IP first and the additive `config/dns.ts` sync then matches on presence
only, ignoring content, so it plans "keep". It becomes a genuinely wrong write
whenever the earlier write failed or went unverified, or when a newly added site
domain has no A record yet. Set `APP_SERVER_IP` and drop the fallback.

## What a deploy actually does

### Runner

1. Checkout, `setup-bun`, `bun install --frozen-lockfile`.
2. Write `DEPLOY_SSH_KEY` to `~/.ssh/id_ed25519` and derive the `.pub`. ts-cloud
   requires `~/.ssh/id_ed25519.pub` at a hardcoded path with no override, which
   is the only reason this step exists.
3. Reconstruct `.env.keys` from the three dotenvx secrets. It is gitignored and
   never committed.
4. Run `bun node_modules/@stacksjs/buddy/dist/cli.js deploy --prod --yes`. The
   `./buddy` wrapper is bypassed on purpose: it resolves a project-local pantry
   Bun and `NODE_PATH`, which a `node_modules` app does not have.

### Pre-flight

`--dry-run` is refused outright, because provisioning, release shipping, and DNS
all mutate real infrastructure. There is no preview mode.

Three gates run: `.env` exists, `.env.<env>` exists and is fully encrypted, and
`APP_KEY` is set. Then `config/cloud.ts` is read, `provider: 'hetzner'` sends
control to `deployToHetzner()`, and that function **returns**. Everything after
that return is AWS-only, which is why `--yes` and `--domain` are no-ops here.

Three Hetzner gates follow: `HCLOUD_TOKEN` present, `~/.ssh/id_ed25519.pub`
present, and a probe that the installed ts-cloud can persist a database across
deploys.

### Provisioning

Server reuse is checked twice, first against a local state file under
`storage/cloud/state/` (untracked, so it always misses in CI), then against
`GET /servers` matching on labels or the exact name `loghq-production-app`.

**Reuse is a pure metadata rehydrate. Nothing on an existing box is
re-provisioned.** If you need a cloud-init change applied, you need a new box.

On a fresh create, cloud-init installs a 2 GB swap file, runs an apt upgrade,
installs and starts PostgreSQL through pantry and creates the `loghq` role and
database, applies nftables DDoS rules (SYN ceilings, per-source connection
meters, ban sets with a 600 second timeout), installs Bun, then builds and
starts rpx. There is no nginx, no Caddy, and no certbot.

No volume is ever requested, so `infrastructure.compute.disk` in `config/cloud.ts`
is dead config on this path. The box uses its built-in `cx23` disk.

### Shipping a release

Per site: a tarball is built on the runner excluding `node_modules`, `.git`,
`.env`, and `.env.keys`, `scp`'d to `/var/ts-cloud/staging`, and the remote half
runs as a single assembled bash script over one SSH session.

On the box: flock, extract to `releases/<sha>`, write `shared/.env`, link shared
paths, run the `preStart` hook (`bun install`), write the systemd template unit,
restart it, wait 5 seconds for `systemctl is-active`, then cut over with
`ln -sfn` and `mv -Tf`. Four releases are kept.

Two things worth internalising:

- **`shared/.env` is written by ts-cloud as the complete environment.** Nothing
  from the tarball is merged into it. If a variable is not in the encrypted
  `.env.<env>` or the site's `env` block, it does not exist at runtime.
- **The health gate is 5 seconds of `systemctl is-active`, not an HTTP probe.**
  Neither site sets `healthCheck.path`, so a process that starts and then fails
  its first request still counts as healthy and still gets the symlink.

Cutover is zero downtime because the app binds with `reusePort`, so both
releases serve on 3022 during the gate window.

A scheduler unit is also installed and started, because `app/Scheduler.ts`
declares a live hourly `Inspire` job.

Config-level hooks (`beforeDeploy`, `afterDeploy`) are never invoked on this
path. Only `site.build` and `site.preStart` run.

### DNS

Porkbun is detected by probing `POST /dns/retrieve/<root>` with the credentials,
falling back to nameserver suffix matching. A records are upserted for every
site domain crossed with `['', 'www']`, each verified by re-listing the zone,
after which `config/dns.ts` is applied **additively**: create or keep only,
never update, never delete.

Mail records follow: MX, SPF, DKIM, DMARC, and an A record for `mail.<domain>`.

### Migrations

The final workflow step SSHes to the box, installs `.env.keys` into `shared/`
with mode 600, symlinks it into `current/`, sources the already-decrypted
`shared/.env`, and runs migrate with `printf 'Y\nn\n'`. The `Y` runs migrations,
the `n` declines the destructive drops.

This step exists separately because `buddy migrate` is a `fastCommand` that
skips the preloader's keyed `autoLoadEnv`, so it never decrypts `.env.<env>` on
its own. It cannot go in `preStart`, which runs before decryption is possible.

The step is non-fatal. It emits a workflow warning on failure, so **a green
deploy does not mean migrations ran**. Read the step output.

## Known issues

**The first deploy to a brand new box will fail.** `HetznerDriver.waitForSshReady`
in ts-cloud 0.7.114 builds its ssh command with a broken shell quoter, opening
each argument with `'` and closing it with `"`. Every invocation dies with
`unexpected EOF while looking for matching '"'`. The retry loop swallows the
error, so the run burns its full 300 second budget and throws a misleading
`Timed out waiting for SSH`. **Re-run the workflow.** The second run succeeds,
because the server now exists and is adopted by name before that code is
reached. Do not go debugging SSH keys.

**`www.cloud.loghq.org` gets an A record on every deploy**, because the A-record
upsert crosses every site domain with `['', 'www']`. It has no route and no
certificate. Harmless, but it will confuse anyone auditing the zone.

**rpx restarts on every deploy.** Its unit runs `fuser -k` on 80 and 443 in
`ExecStartPre`, and the gateway is rebuilt and restarted each time. The app
cutover is genuinely zero downtime; the edge in front of it is not.

**`migrate` currently wants a destructive change to `subscriptions.type`.** The
workflow answers `n`, so it is declined every run. Resolve it deliberately
rather than leaving it to accumulate.

## Operating the box

```sh
ssh root@$APP_SERVER_IP

systemctl status 'loghq-main@*'          # app
systemctl status 'loghq-loghq-api@*'     # loopback API
journalctl -u 'loghq-main@*' -f          # live logs
ls -la /var/www/loghq-main/releases       # the 4 kept releases
readlink /var/www/loghq-main/current      # what is live now
```

Rollback is repointing `current` at a previous release and restarting that
release's unit. **Unverified**: ts-cloud ships no rollback command on this path,
so treat it as a manual operation and confirm the unit name matches the release
sha you are pointing at.

## Local development

```sh
pantry install postgres && pantry start postgres
./buddy migrate
bun run dev
```

The dev server serves stx views on `PORT` (3000) and the API on `PORT_API`
(3008), both from `config/ports.ts`. Trust the URLs `bun run dev` prints over
this paragraph.

> Provisioning creates billable Hetzner resources and live Porkbun DNS records.
> Run a deploy only when you mean it.
