# Deploying loghq

loghq is **attached to the statushq Hetzner server** and shipped by **ts-cloud**
(`buddy deploy` → `@stacksjs/ts-cloud`), with DNS at **Porkbun** and
push-to-deploy from **GitHub Actions**. It does not own a server of its own; see
[Topology](#topology).

There is no AWS in this path. `config/cloud.ts` still carries AWS-shaped keys
(`region`, `loadBalancer`, `ssl.provider: 'acm'`) because the config type is
shared across providers, but nothing reads them once `provider` is `hetzner`.
Ignore them.

> This document is written from the source of ts-cloud 0.7.114, `config/cloud.ts`,
> and `.github/workflows/deploy.yml`. Behaviour marked **unverified** has not yet
> been observed on a live box.

## Topology

**loghq does not have its own server.** `config/cloud.ts` sets
`cloud.attachTo: 'uptime-status'`, so it deploys onto the box that the statushq
project owns, as an additional set of sites.

Note the slug is **`uptime-status`**, not `statushq`. The server is *named*
`statushq-production-app` but its `ts-cloud/project` label reads
`uptime-status`, and `attachTo` matches the label. Getting this wrong fails with
"Attach target ... has no reachable box", which reads like the server is down
when it is running fine.

| Piece | Detail |
|---|---|
| Server | `statushq-production-app` (`167.233.116.134`), owned by statushq, **not** created by this repo |
| Firewall | statushq's; this deploy does not manage it |
| Edge | **rpx**, held by the host, fronting every attached site |
| TLS | Let's Encrypt via `@stacksjs/tlsx`, issued on demand |
| Database | statushq's PostgreSQL. `ensureAttachModeDatabase` creates loghq's role + database inside that existing cluster |
| App | `bun ... buddy serve` on `127.0.0.1:3042` |
| API | `bun ... actions/serve/api.js` on `127.0.0.1:3043` |
| Layout | Capistrano style, `/var/www/loghq-main/{shared,releases,current}` |
| Units | systemd templates, `loghq-main@<sha>.service` and `loghq-api@<sha>.service` |
| Dashboard | **skipped.** ts-cloud logs "attached to statushq; the server owner's dashboard monitors every attached project", so `cloud.loghq.org` is unused |

`attachTo` takes the **owner project's slug**, not a server name. ts-cloud finds
the host with `listServers()` and label matching. Confirm the slug rather than
guessing it from a server name:

```sh
curl -H "Authorization: Bearer $HCLOUD_TOKEN" \
  https://api.hetzner.cloud/v1/servers | jq '.servers[] | {name, labels}'
```

### Ports

Nothing allocates or validates ports across attached projects
([stacksjs/ts-cloud#168]), so a collision surfaces only as a service that will
not bind. Who holds what on this box, read from each project's `config/cloud.ts`
rather than assumed from the template:

| Project | app / api | Source |
|---|---|---|
| statushq (owner) | **3000 / 3008** | `port: 3000`; `const API_PORT = 3008` |
| loghq | 3042 / 3043 | this repo |
| analyticshq | 3024 / 3025 | if it attaches; currently on the `stacks` box |

statushq also names 3000-3010 by role in its `config/ports.ts` (frontend 3000
through database 3010). Only 3000 and 3008 bind, but treat the whole band as
spoken for rather than filling a gap inside it.

**bughq is not on this box** and never was — it owns a dedicated server
(`91.98.39.176`), and its `config/cloud.ts` says that isolation is deliberate.
It uses 3022/3023 *there*, which constrains nothing here.

> Earlier revisions of this file recorded statushq as `3022/3023` — the Stacks
> template default, inferred rather than checked. It is not: statushq contains
> no occurrence of `302x` at all. loghq's own 3042/3043 was never at risk, but
> the table was the thing a later attacher would consult, so it is corrected
> here rather than left as a plausible-looking guess.

**Confirm before the first deploy**, on the box: `ss -ltnp | grep 30`

### What attaching costs

The HCLOUD_TOKEN this repo's CI uses must live in the same Hetzner project as
statushq, and Hetzner tokens have no per-resource scoping. So loghq's CI can
reach every server in that project, including bughq, stacks and statushq
([stacksjs/ts-cloud#169]). That is inherent to attaching, not a misconfiguration.

[stacksjs/ts-cloud#168]: https://github.com/stacksjs/ts-cloud/issues/168
[stacksjs/ts-cloud#169]: https://github.com/stacksjs/ts-cloud/issues/169

Sites are declared in the `tsCloud` **named export** of `config/cloud.ts`. The
file's `export default` is a separate, intentionally empty `CloudConfig`, so
editing the default export changes nothing about a deploy.

| Site key | Domain | Port | Role |
|---|---|---|---|
| `main` | `loghq.org` | 3042 | The app, stx views plus ingest |
| `api` | none | 3043 | Loopback API, rpx skips it because it has no domain |
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

### 3. Confirm the ports are free  <!-- was: fix the config/dns.ts fallback -->

The `config/dns.ts` fallback to bughq's IP was removed in `6a5dcfb`; an unset
`APP_SERVER_IP` now emits no A record rather than someone else's address.

What replaces it as the pre-flight check is the port assumption. loghq claims
`3042/3043` on a box it does not own, and nothing validates that across
projects. Before the first deploy:

```sh
ssh root@167.233.116.134 'ss -ltnp | grep 30'
```

Expect statushq on `3000/3008` and nothing on `3042/3043`. If `3042` or `3043`
is taken, change them in `config/cloud.ts` before deploying rather than after.

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

### Provisioning (skipped in attach mode)

**`cloud.attachTo` is set, so none of this runs for loghq.** ts-cloud calls
`attachToComputeInfrastructure()` and resolves the existing statushq box by
label instead. The section below describes what happens for the project that
*owns* a box, and is kept because it is what statushq's own deploy does, and
what loghq would do again if it were ever detached.


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
releases serve on 3042 during the gate window.

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

### duckdb

The log archive shells out to a `duckdb` binary to write and read Parquet on
object storage (see `app/Archive/duckdb.ts`). Pantry declares it in
`config/deps.ts`, which covers local development, but **pantry does not run on
this box**: the deploy ships the node_modules layout, and `./buddy`
short-circuits to the plain `bun` on PATH in that case. So a workflow step
installs it after the migrate step.

That step is idempotent and does nothing once the binary exists, which is the
normal case. It fetches the official `duckdb_cli-linux-amd64` release into
`/usr/local/bin` rather than building from source: the pantry recipe compiles
httpfs in, but reproducing that on the box would mean cmake, OpenSSL headers,
and several minutes added to a deploy that otherwise takes seconds. The released
CLI installs httpfs as an extension instead, which the step caches once into
`/usr/local/share/duckdb-extensions`, so nothing reaches for the network at
query time.

That directory is shared rather than the per-user `~/.duckdb` default because
the step runs as root and the scheduler unit does not necessarily. It has to
match `ARCHIVE_DUCKDB_EXTENSION_DIR` in `.env.production`.

The step is `continue-on-error`, unlike migrate. A box without duckdb serves
every page correctly; the only thing that stops is the nightly archive job,
which logs why and skips. Failing the deploy over it would take the site down
for a feature that degrades quietly.

### Archive environment

The archive is off unless `.env.production` says otherwise. The full set lives
in `.env.example`; the ones with no safe default are:

```
ARCHIVE_ENABLED=true
ARCHIVE_S3_ENDPOINT=fsn1.your-objectstorage.com   # host[:port], no scheme
ARCHIVE_S3_BUCKET=...
ARCHIVE_S3_ACCESS_KEY_ID=...
ARCHIVE_S3_SECRET_ACCESS_KEY=...
ARCHIVE_S3_REGION=fsn1                             # matches the endpoint
ARCHIVE_S3_USE_SSL=true                            # verified against a TLS endpoint
ARCHIVE_S3_URL_STYLE=path                          # Hetzner serves path style
ARCHIVE_DUCKDB_PATH=/usr/local/bin/duckdb          # systemd PATH is not yours
ARCHIVE_DUCKDB_EXTENSION_DIR=/usr/local/share/duckdb-extensions
# ARCHIVE_S3_CA_CERT_FILE is only for self-hosted storage behind an internal CA.
# Hetzner, R2 and AWS chain to public roots, so leave it unset.
```

Any S3-compatible bucket works (Hetzner Object Storage, R2, MinIO, AWS); only
the values differ. Turn it on with `ARCHIVE_DELETE_AFTER_VERIFY=false` for the
first night, confirm the Parquet and the `archive_partitions` rows look right,
then enable deletion.

Note that a misconfigured bucket stops free-plan **pruning** too, even though
that path never touches object storage. That is deliberate: the alternative is
that a mistyped bucket name deletes free-plan data on the first run while
nothing is being archived, which is the one failure here that cannot be undone.

`buddy archive:run --dry-run` on the box prints exactly what a run would touch
and changes nothing.

## Known issues

**Not applicable while attached:** the "first deploy to a brand new box fails on
`waitForSshReady`" problem needs a server create, and attach mode never does
one. It is also absent from ts-cloud 0.7.114 on re-reading, so it may simply
have been fixed since this document was first written. Kept only as a pointer
for whoever provisions the next box.

**`www.<site>` A records get created for every site domain**, because the
A-record upsert crosses each one with `['', 'www']`. They have no route and no
certificate. Harmless, but confusing when auditing the zone. `cloud.loghq.org`
is no longer among them: attach mode skips the management dashboard entirely,
so that site is not deployed and `TS_CLOUD_UI_DOMAIN` in the workflow is inert.

**rpx restarts on every deploy, and it is shared.** Its unit runs `fuser -k` on
80 and 443 in `ExecStartPre`, and the gateway is rebuilt and restarted each
time. The app cutover is genuinely zero downtime; the edge in front of it is
not. On an attached box that edge belongs to **every** site, so a loghq deploy
briefly interrupts statushq too. Worth knowing before deploying loghq during a
statushq incident.

**`migrate` currently wants a destructive change to `subscriptions.type`.** The
workflow answers `n`, so it is declined every run. Resolve it deliberately
rather than leaving it to accumulate.

## Operating the box

The box is statushq's and runs its sites alongside loghq's. Scope commands to
loghq's units and paths; `systemctl status` with no filter shows both projects.

```sh
ssh root@167.233.116.134   # = APP_SERVER_IP

systemctl status 'loghq-main@*'          # app
systemctl status 'loghq-api@*'           # loopback API
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

> A deploy writes live Porkbun DNS records and restarts the shared rpx edge on a
> box that also serves statushq. In attach mode it creates no billable Hetzner
> resources of its own. Run it only when you mean it.
