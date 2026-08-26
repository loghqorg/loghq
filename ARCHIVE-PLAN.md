# Implementation plan: tiered log storage - Parquet archive on S3 + DuckDB historical queries

This document is the complete, approved implementation plan for LogHQ's cold-storage tier. It is
written to be executed by an agent (or human) with no prior context beyond this repo. Read the
"Status" section first: Phase 0 is already partially applied.

## Status (what is already done)

Done, in the working tree (2026-08-26):

1. **Pantry recipe** (`~/Code/pantry/packages/ts-pantry/src/recipes/duckdb.org.ts`, OUTSIDE this
   repo): added `-DBUILD_HTTPFS_EXTENSION=1` and `-DOPENSSL_ROOT_DIR={{deps.openssl.org.prefix}}`
   to `build.env.ARGS`; added `openssl.org ^1.1` to `dependencies` (new block) and
   `buildDependencies`; fixed a latent bug where the build script ran plain `cmake ..` so the
   `ARGS` env (and therefore every extension flag) was never applied - now `cmake .. $ARGS`.
   NOT yet done: rebuilding the package and the `LOAD httpfs` smoke test (Phase 0 verification).
2. **config/deps.ts**: added `'duckdb.org': '^1.5'` to the pantry dependencies.
3. **package.json**: mirrored `"duckdb": "^1.5"` in the `"system"` block.

Everything else below is not started. Phases 1-8 are ordered so each lands leaving the app working.

## Context

LogHQ stores every log entry in the hot DB forever. The pricing page (resources/views/pricing.stx)
already sells "30-day retention" (Free) vs "Full retention" (Pro) with zero enforcement, the hot DB
grows without bound, and there are no analytics features. This change introduces log-SaaS tiering:

1. **Hot window (30 days)** stays in the primary DB; stream/correlation behavior unchanged.
2. **A nightly scheduled job** exports aged (project, UTC day) partitions to Parquet on
   S3-compatible object storage via the DuckDB CLI, verifies row counts by re-reading the Parquet,
   then deletes the hot rows (flag-guarded). Free projects: pruned without archive (window plus a
   7-day grace), enforcing the pricing copy.
3. **DuckDB** (pantry system binary `duckdb.org`, driven via `Bun.spawn`, never an npm package)
   serves historical search and aggregations from `read_parquet('s3://...')`.
4. **Query surface**: `/api` archive and analytics endpoints, a dashboard analytics page, an
   Archive scope in the log stream, a Retention section in settings.

Decisions confirmed by the owner:
- S3-compatible object storage from day one (provider-agnostic env; Hetzner Object Storage
  recommended since production is Hetzner - R2/AWS work identically, only env values differ).
- Verify-then-delete (deletion disable-able via env flag).
- Enforce the pricing plan split (Pro archives, Free prunes).
- Full scope including the dashboard UI.

## Ground truth (verified against the codebase - do not re-litigate, but re-verify line numbers)

- `log_entries` schema = the `LogRow` interface in `app/Logs/normalize.ts` (~line 57): id,
  project_id, level, message, channel, context, environment, release, framework, host, sdk,
  user_context, timestamp, trace_id, request_id; plus created_at/updated_at from useTimestamps.
  Index `(project_id, timestamp)` exists (model: `app/Models/LogEntry.ts`).
- **`log_entries.timestamp` is varchar ISO-8601, not a timestamp column.** Day partitioning is
  lexicographic string bounds riding the index. `created_at` is `YYYY-MM-DD HH:MM:SS` (a different
  shape; never mix the two - `app/Support/time.ts` documents why).
- **Production DB is SQLite** on a Hetzner shared box (systemd, Capistrano layout, deploys from the
  `production` branch; DEPLOY.md is authoritative). `tests/unit/sql-dialect.test.ts` greps every
  .ts under app/ and routes/ for `NOW()`, `AT TIME ZONE`, `::interval` - a prior real outage. All
  hot-DB SQL must be dialect-free; compute cutoffs in JS and bind them.
- DB idiom: raw `db.unsafe(sql, params)` with `$n` placeholders (`import { db } from
  '@stacksjs/database'`); `db.insertInto(...).values(...).execute()` for inserts; IN-lists expanded
  to individual placeholders (a JS array binds as a malformed literal). **No transactions exist
  anywhere in the app** - idempotency must come from state rows + unique constraints.
- Scheduler runs in production (`loghq-main-scheduler.service`, health-gated in deploy.yml). API:
  `schedule.job(name)` fluent - intervals like `.daily()`, `.at(time)`, `.hourly()`, modifiers
  `.withoutOverlapping(min)`, `.setTimeZone(tz)`; `Schedule.runNow(name)` for manual triggering.
  Verify `.daily().at('03:10')` exists on the installed version; fallback `.cron('10 3 * * *')`.
  Job class template: `app/Jobs/SendWelcomeEmail.ts` (`new Job({ name, description, queue, tries,
  backoff, timeout, handle })`). QUEUE_DRIVER=sync, so the scheduler runs job bodies inline - that
  is the intended execution path here.
- Route/auth pattern to copy exactly (`routes/logs.ts:156`): absolute `/api/...` paths,
  `userFromRequest()` (bearer or `loghq_token` cookie -> `Auth.getUserFromToken`) -> 401 when
  unauthenticated; `ownsProject()` from `app/Support/access.ts` -> **404 (not 403)** when not a
  member. `/api/` is already covered by the proxy prefixes in `config/server.ts`.
- Plan is per-USER, not per-project: `Payment.hasActiveSubscription(user as any, 'default')` inside
  try/catch defaulting false - exact shape in `app/Actions/MeAction.ts:25-31`. Resolve a project's
  plan via projects.owner_id -> users row.
- Runtime env on the box comes ONLY from the encrypted `.env.production` or the `sites.*.env`
  blocks in `config/cloud.ts` (DEPLOY.md). Pantry does NOT run on the production box (node_modules
  deploy layout short-circuits it in `./buddy`), so the duckdb binary needs an explicit deploy step.
- The stream endpoint response shape to mirror for archive search: `{ logs, nextCursor }`
  (`routes/logs.ts:210-217`), columns `STREAM_COLS` (`routes/logs.ts:154`).

## Implementation phases

### Phase 0 - Pantry + dependency declarations (DONE except verification)

Remaining: rebuild the pantry duckdb package locally and smoke it:

```bash
duckdb -c "LOAD httpfs; SELECT 1"
```

Also confirm a local `COPY (SELECT 1 AS x) TO '/tmp/x.parquet' (FORMAT parquet)` works.

### Phase 1 - Env + config

- `config/env.ts`: add typed `ARCHIVE_*` entries (schema from `@stacksjs/validation`, matching the
  file's existing style). Fresh namespace on purpose: the existing `AWS_S3_BUCKET` vs `AWS_BUCKET`
  naming across `config/filesystems.ts` / `.env.example` is inconsistent and unused.

  | Var | Type | Default |
  |---|---|---|
  | ARCHIVE_ENABLED | boolean | false |
  | ARCHIVE_S3_ENDPOINT | string (host[:port], no scheme) | '' |
  | ARCHIVE_S3_REGION | string | 'auto' |
  | ARCHIVE_S3_BUCKET | string | '' |
  | ARCHIVE_S3_ACCESS_KEY_ID | string | '' |
  | ARCHIVE_S3_SECRET_ACCESS_KEY | string | '' |
  | ARCHIVE_S3_USE_SSL | boolean | true |
  | ARCHIVE_S3_URL_STYLE | enum path/vhost | 'path' |
  | ARCHIVE_S3_PREFIX | string | 'logs' |
  | ARCHIVE_HOT_WINDOW_DAYS | number | 30 |
  | ARCHIVE_DELETE_AFTER_VERIFY | boolean | true |
  | ARCHIVE_FREE_PRUNE_GRACE_DAYS | number | 7 |
  | ARCHIVE_DUCKDB_PATH | string ('' = PATH lookup) | '' |
  | ARCHIVE_EXPORT_TIMEOUT_MS | number | 300000 |
  | ARCHIVE_QUERY_TIMEOUT_MS | number | 15000 |
  | ARCHIVE_MAX_FILES_PER_QUERY | number | 62 |

- Document the block in `.env.example` with a note that production values go into the encrypted
  `.env.production` (see DEPLOY.md).
- New `app/Archive/config.ts`: `archiveConfig(): ArchiveConfig` (reads `@stacksjs/env`) and
  `archiveReady(c): string | null` (null = ok, else a human message naming what is missing).
- `app/Support/time.ts`: add `utcIsoHoursAgo(hours: number): string` returning the FULL
  `toISOString()` value. It matches the ISO shape of `log_entries.timestamp`; the existing
  `utcHoursAgo` matches `created_at`'s shape. The file's docblock explains why the two shapes must
  never be compared to the wrong column - extend it.

### Phase 2 - ArchivePartition bookkeeping model

- New `app/Models/ArchivePartition.ts` (`defineModel`, table `archive_partitions`, useTimestamps):
  - Attributes: `id` (string), `project_id` (string, required), `day` (string `YYYY-MM-DD`,
    required), `status` (string, one of `pending|exporting|exported|verified|deleted|pruned|failed`),
    `row_count` (number, optional), `byte_size` (number, optional), `object_path` (string,
    optional; key relative to the bucket), `error` (string, optional), `attempts` (number,
    optional), `claim_token` (string, optional).
  - Indexes: **unique `(project_id, day)`** - this is the claim lock, load-bearing, not cosmetic -
    plus `(status, day)`.
  - Document the state machine in the model docblock: `pending -> exporting -> exported ->
    verified -> deleted`; any step may go `-> failed`(with error);`failed -> exporting` on
    reclaim; the Free path writes terminal `pruned` rows (row_count = rows removed) so pruning is
    auditable.
- `buddy generate:migrations`, inspect the generated SQL - if the generator does not emit a UNIQUE
  composite index, hand-edit the migration (precedent: the hand-adjusted partial indexes in
  `database/migrations/0000000010*`). Then `buddy migrate` locally.

### Phase 3 - Core modules under app/Archive/

- **`app/Archive/duckdb.ts`** - the CLI runner:
  - `duckdbBinary()`: `ARCHIVE_DUCKDB_PATH` override, else `'duckdb'` from PATH (the buddy wrapper
    prepends `pantry/.bin` locally).
  - `runDuckDb(script, { timeoutMs }): Promise<{ ok, rows, stderr, code }>` via
    `Bun.spawn([bin, '-batch', '-json'], { stdin: 'pipe', ... })`: write script to stdin, close,
    race a kill timer (SIGTERM then SIGKILL), parse stdout as a JSON array. Convention: at most ONE
    result-producing statement per invocation (keeps `-json` framing trivial; verify once against
    the built binary).
  - **Credentials via a `CREATE SECRET (TYPE s3, KEY_ID ..., SECRET ..., ENDPOINT ..., REGION ...,
    URL_STYLE ..., USE_SSL ...)` preamble on stdin** (`s3Preamble(cfg)`), NOT child env vars: it is
    the only mechanism carrying endpoint/url_style/use_ssl uniformly across Hetzner/R2/MinIO/AWS,
    and stdin never appears in `ps`. Scripts start with `LOAD httpfs;` (statically built - never
    emit `INSTALL httpfs`).
  - `redactScript(script)`: strips CREATE SECRET bodies; the runner must never log a script
    unredacted. Unit-tested.
- **`app/Archive/sql.ts`** - pure, unit-tested SQL builder; THE injection boundary (the CLI has no
  parameter binding):
  - `sqlQuote(v)`: throw on any char < 0x20 or = 0x7f and on length > 4096; else double single
    quotes and wrap.
  - Validators: `ISO_DAY = /^\d{4}-\d{2}-\d{2}$/`, `ISO_TS` (ISO-8601 timestamp shape), `SAFE_ID =
    /^[A-Za-z0-9_-]{1,64}$/`, `SAFE_KEY = /^[A-Za-z0-9._/=-]{1,512}$/`(object keys; rejects`..`
    by construction since only single dots pass in path segments - still add an explicit `..` test).
  - Levels are whitelisted against `LEVELS` imported from `app/Logs/normalize.ts` (same whitelist
    as ingest). project_id reaches the builder only from the already-authorized route param.
  - Builders: `buildSearchSql(objectKeys, bucket, filters)` (read_parquet over a quoted key list;
    filters level/channel/environment/release/q (ILIKE is native DuckDB)/day range; keyset cursor
    as row-value `(timestamp, id) < (ts, id)`; ORDER BY timestamp DESC, id DESC; LIMIT clamped
    1..200), `buildVolumeSql(keys, bucket, unit day|hour, fromDay, toDay)` (`substr(timestamp,1,10)`
    or `,13` GROUP BY), `buildLevelsByReleaseSql(keys, bucket, fromDay, toDay)`
    (`coalesce("release",'(none)')`), `buildVerifyCountSql(bucket, key)`,
    `buildExportSql(ndjsonPath, bucket, key)`:

    ```sql
    COPY (SELECT id, project_id, level, message, channel, context, environment, "release",
                 framework, host, sdk, user_context, timestamp, trace_id, request_id, created_at
          FROM read_json('<path>', format='newline_delimited',
                          columns={... every field: 'VARCHAR' ...})
          ORDER BY timestamp, id)
    TO 's3://<bucket>/<key>' (FORMAT parquet, COMPRESSION zstd)
    ```

    Explicit `columns=` pins every field to VARCHAR so inference can never mangle a
    numeric-looking message. `"release"` stays quoted everywhere.
  - Emitted SQL must never contain `NOW()`, `AT TIME ZONE`, or `::interval` - these .ts files are
    inside the `tests/unit/sql-dialect.test.ts` scan surface. Use `current_timestamp` if ever
    needed; prefer JS-computed bounds.
- **`app/Archive/partitions.ts`** - pure planning: `cutoffDay(now, days)` (UTC day string; a row is
  aged when `timestamp < cutoffDay` lexicographically - `'2026-07-26T...' < '2026-07-27'` holds),
  `dayBounds(day)` (`{ from: day, to: nextDay }`; row predicate `timestamp >= from AND timestamp <
  to`, both bound), `objectKeyFor(prefix, projectId, day)` ->
  `prefix/project_id=<id>/date=<day>/part-000.parquet` (validate inputs first),
  `partitionsToExport(aged, existing)` (skip verified/deleted/pruned and live `exporting`; include
  `failed` for reclaim).
- **`app/Archive/plan.ts`** - `projectOwnerIsPro(projectId)`: `SELECT owner_id FROM projects WHERE
  id = $1`; load the user row; `Payment.hasActiveSubscription(user as any, 'default')` in try/catch
  -> false (MeAction shape). Verify the input shape against `@stacksjs/payments` first (open item 1).
- New **`app/Support/request-auth.ts`**: lift `userFromRequest` out of `routes/logs.ts:65-82`
  verbatim; make `routes/logs.ts` import it (behavioral no-op refactor).

### Phase 4 - Export pipeline, job, scheduler, command

- **`app/Archive/exporter.ts`**:
  - `listAgedPartitions(cutoff)`: `SELECT project_id, substr(timestamp,1,10) AS day, COUNT(*) AS n
    FROM log_entries WHERE timestamp < $1 GROUP BY project_id, substr(timestamp,1,10)` (substr is
    valid SQLite and Postgres).
  - `claimPartition(projectId, day, token)` - the no-transaction claim protocol:
    1. Try INSERT with status `exporting` + our claim_token; the unique `(project_id, day)` index
       makes the racing loser throw -> caught -> skip (someone owns it).
    2. Reclaim `failed` rows: `UPDATE ... SET status='exporting', claim_token=$token,
       attempts=attempts+1, error=NULL WHERE project_id=$ AND day=$ AND status='failed'`, then
       SELECT the claim_token back and proceed only if it equals ours (compare-after-write; the
       losing racer reads the winner's token and backs off).
    3. Same reclaim for stale `exporting` rows with `updated_at < utcHoursAgo(6)` (crashed run).
  - `exportPartition(cfg, projectId, day)`:
    1. Keyset-page rows out (`(timestamp > $a OR (timestamp = $a AND id > $b))` expanded OR form -
       dialect-universal - 5000/page), streaming each row as one `JSON.stringify(row)` line into
       `mkdtemp(tmpdir()/loghq-archive-)/part.ndjson`; count = localCount.
    2. `runDuckDb(preamble + buildExportSql(...), { timeoutMs: exportTimeoutMs })`.
    3. Verify: `runDuckDb(preamble + buildVerifyCountSql(...))`; count must equal localCount;
       mismatch -> status `failed` with error, hot rows kept, temp dir removed, return.
    4. Mark `verified` with row_count, object_path, byte_size (from
       `SELECT sum(total_compressed_size) FROM parquet_metadata('s3://...')` in the verify script;
       nullable on error).
    5. If `deleteAfterVerify`: loop `DELETE FROM log_entries WHERE id IN (SELECT id FROM
       log_entries WHERE project_id=$1 AND timestamp>=$2 AND timestamp<$3 LIMIT 2000)` until 0
       affected (IN-subquery-with-LIMIT works on both engines; `DELETE ... LIMIT` does not) ->
       status `deleted`. Flag off -> stop at `verified` (query layer accounts for it).
    6. Temp dir removed in `finally`.
  - `prunePartition(projectId, day)` (Free path): claim + batched delete, no S3, terminal `pruned`
    with row_count. Free prunes only when `day < cutoffDay(now, hotWindowDays +
    freePruneGraceDays)` - an owner upgrading within the grace week still gets those days archived
    on the next nightly instead of finding them gone.
- **`app/Jobs/ArchiveAgedLogs.ts`** (SendWelcomeEmail shape): `tries: 1`, `timeout: 3600`,
  `queue: 'maintenance'`. Handle: disabled or not-ready -> log.info/warn and return; compute
  cutoffs; list aged partitions; group by project; `projectOwnerIsPro` once per project;
  export/prune sequentially (bounds memory + S3 concurrency); one summary log line (projects,
  partitions exported/pruned/failed, rows, bytes). Retry granularity is the per-partition
  failed->reclaim path on the next nightly, hence tries: 1.
- **`app/Scheduler.ts`**: add
  `schedule.job('ArchiveAgedLogs').daily().at('03:10').setTimeZone('UTC').withoutOverlapping(120)`
  (verify `.at()` exists; fallback `.cron('10 3 * * *')`).
- **`app/Commands/ArchiveRun.ts`**: buddy command `archive:run` (model on `app/Commands/Inspire.ts`
  and register per `app/Commands.ts`), options `--dry-run` (print the partition plan), `--project
  <id>`, `--day <YYYY-MM-DD>`; calls the same exporter functions. This is the local end-to-end and
  on-box debugging entry point.

### Phase 5 - Query surface

- **`app/Archive/query.ts`** (shared by routes AND stx server blocks - no HTTP self-calls):
  `archivePartitionsFor(projectId, fromDay, toDay, statuses)`, `searchArchive(projectId, filters)`
  -> `{ logs, nextCursor }`, `volumeSeries(projectId, fromDay, toDay, unit)` ->
  `[{ bucket, hot, archive }]`, `levelsByRelease(projectId, fromDay, toDay)`.
  - Hot side: dialect-safe `db.unsafe` with bound cutoffs (`substr(timestamp,1,10)` GROUP BY).
  - Archive side: DuckDB over object keys resolved from `archive_partitions`.
  - **No-double-count rule: archive contributes a day iff the partition status is `deleted`; hot
    contributes everything it still holds.** (Covers ARCHIVE_DELETE_AFTER_VERIFY=false, where
    verified days still live in hot.) Merge in JS by bucket key.
  - DuckDB never touches the live DB (rejected sqlite_scanner: read-locks against ingest writes,
    extension not built, no Postgres future). Key list capped at `maxFilesPerQuery` (62 = two
    months); wider ranges paginate by date window.
- **`routes/analytics.ts`** (new; also add `analytics: { path: 'analytics', prefix: '' }` to
  `app/Routes.ts` for explicitness). All GET under `/api/`; every route: `userFromRequest` -> 401,
  `ownsProject` -> 404:
  - `GET /api/projects/{projectId}/archive/status` - plan (pro/free), hotWindowDays,
    archiveEnabled, partition summary (day, status, row_count, byte_size; newest 400), totals.
    Available on both plans (Free sees what pruning did plus the upgrade pitch).
  - `GET /api/projects/{projectId}/archive/search` - Pro only; Free -> 403
    `{ error: 'archive requires pro', code: 'plan' }`. Params: `level` (CSV, LEVELS-whitelisted),
    `channel`, `environment`, `release`, `q`, `from`/`to` (ISO days), `before` (cursor `ts~id`),
    `limit`. Response `{ logs, nextCursor }` shaped like the hot stream endpoint.
  - `GET /api/projects/{projectId}/analytics/volume?range=90d&interval=day` - range whitelist
    `7d|30d|90d|180d`, interval `day|hour` (hour only for <= 7d). `{ series: [{ bucket, hot,
    archive, total }], plan }`. Free: archive always zero, response says so.
  - `GET /api/projects/{projectId}/analytics/levels?range=90d` - per-release level distribution,
    hot+archive merged: `{ releases: [{ release, levels: { error: n, ... }, total }] }`.

### Phase 6 - Frontend (stx + Crosswind; signals only; NO em-dashes in any user-visible copy)

- **`resources/views/dashboard.stx`**: add an `archive` entry to the `RANGES` array; branch in
  `loadData()` for the archive scope calling `searchArchive`/`archivePartitionsFor` server-side
  (imported into the `<script server>` block the same way `__db` is used); add a keyset `cursor`
  to the `pageUrl` URL state (page numbers do not map onto keyset paging); non-Pro owners get an
  upgrade gate panel instead of results; counts panel sums `archive_partitions` (cheap) rather
  than scanning Parquet. ALSO fix the pre-existing dialect bug in this function: replace
  `timestamp::timestamptz >= NOW() - INTERVAL '...'` (~lines 228 and 262) with bound
  `utcIsoHoursAgo()` cutoffs - these silently degrade every non-"All time" range on production
  SQLite today.
- **`resources/views/analytics.stx`** (new, served at `/analytics` via file-based routing):
  follow dashboard.stx conventions exactly (server-block auth from the `loghq_token` cookie, URL
  state, `pageUrl` canonicalizer, 5s `Promise.race` on queries). Content: volume-over-time stacked
  bars (hot vs archive; server-built inline SVG), level-distribution-per-release stacked bars,
  archive partition table (day, status, rows, size). Add the nav link wherever the shared chrome
  links dashboard/settings.
- **`resources/views/settings.stx`**: seventh `<section id="retention">` plus its anchor nav pill,
  between `alerts` and `danger`: plan, hot window (30 days), archive status and totals, what
  happens to aged logs on this plan, link to /analytics.

### Phase 7 - Deploy

- **`.github/workflows/deploy.yml`**: new idempotent SSH step "Provision duckdb" right after the
  existing "Provision .env.keys + migrate" step (reuse its IP-resolution boilerplate):
  `command -v duckdb >/dev/null && duckdb --version || <install>`. Primary install path: pantry
  CLI (install if absent) + `pantry install duckdb.org@^1.5` landing the binary on
  `/usr/local/bin`. Documented fallback if pantry-on-box is not viable day one: fetch the official
  `duckdb_cli-linux-amd64` release into `/usr/local/bin` and run a one-time `INSTALL httpfs`
  (operationally identical once the extension is cached; note the deviation in the step comment).
  Extend the "Verify the deploy actually serves" step with `duckdb --version` and (when enabled)
  an archive/status probe.
- systemd PATH caveat: set `ARCHIVE_DUCKDB_PATH=/usr/local/bin/duckdb` in `.env.production`
  rather than relying on the unit's PATH.
- No `config/cloud.ts` sharedPaths change needed: the binary lives outside the release tree,
  NDJSON staging is in tmpdir and removed per partition, Parquet lives in object storage.
- Operator task (documented in DEPLOY.md): add the encrypted `ARCHIVE_*` block to
  `.env.production` with bucket + keys from Hetzner Object Storage (or R2/AWS).

### Phase 8 - Tests (mirror tests/unit/logs-normalize.test.ts style: pure modules, bun:test)

- `tests/unit/archive-sql.test.ts`: sqlQuote doubling + control-char/length rejection; injection
  payloads (e.g. `x'; DROP TABLE log_entries; --`) come out inert with balanced quotes; level
  whitelist drops unknowns; ISO regexes reject `2026-13-99` and `2026-07-27' OR 1=1`; SAFE_KEY
  rejects `..`, spaces, quotes; built SQL contains none of `NOW()`/`AT TIME ZONE`/`::interval`;
  cursor emission; limit clamping.
- `tests/unit/archive-partitions.test.ts`: cutoffDay across month/year boundaries; dayBounds;
  objectKeyFor; partitionsToExport skip/include matrix; the free-grace boundary day.
- `tests/unit/archive-ndjson.test.ts`: one row = one line with embedded newlines/quotes/unicode in
  message/context; line count = row count; `redactScript` removes secret material.
- `tests/unit/sql-dialect.test.ts` needs no change - the new app/ and routes/ files fall inside
  its scan surface automatically.
- Optional e2e (existing `skipIf` server-down convention in `tests/e2e/helpers.ts`):
  archive/status returns 401 without a token and 404 for a foreign project.

## Rollout / verification (each step leaves production working)

1. Pantry rebuild -> `duckdb -c "LOAD httpfs; SELECT 1"`.
2. Env + pure modules + unit tests (no behavior change; ARCHIVE_ENABLED=false default). Lint with
   `bunx --bun pickier .`; run `buddy test`.
3. Model + migration; inspect generated SQL for the UNIQUE composite index; `buddy migrate`.
4. Exporter + job + `archive:run`: first a local-file COPY smoke (point buildExportSql at a local
   path in a scratch test), then a real test bucket. Seed rows with timestamps 40 days back, run
   `archive:run --dry-run`, then a real run. Verify: Parquet exists; `read_parquet` count matches;
   hot rows deleted; partition row `deleted`; re-run is a no-op (idempotency); kill mid-export and
   confirm the stale-claim reclaim works.
5. Routes + frontend; verify the Archive tab and /analytics in the dev preview.
6. Ship with ARCHIVE_ENABLED=false; confirm `duckdb --version` on the box and the scheduler logging
   the "archive disabled" line at 03:10 UTC.
7. Flip ARCHIVE_ENABLED=true with ARCHIVE_DELETE_AFTER_VERIFY=false for the first nightly; inspect
   the exported Parquet and `archive_partitions`; then enable deletion.

Post-deploy checklist: scheduler unit active; job summary in logs; partitions progressing
pending -> verified -> deleted; hot counts for aged days at zero; archive/search returns rows for
Pro and 403 for Free; dashboard Archive tab renders; Free rows older than window+grace pruned with
`pruned` bookkeeping rows; deploy verify step green.

## Open items to resolve during implementation

1. `Payment.hasActiveSubscription` input shape for a user row fetched by id in job context
   (MeAction passes the Auth-resolved user behind `as any` + try/catch; check @stacksjs/payments).
2. Whether the migration generator honors composite UNIQUE indexes from `defineModel().indexes`
   (fallback: hand-edit the generated migration; precedent exists in migration 0000000010).
3. Scheduler `.daily().at()` availability on the installed stacks version (fallback `.cron()`).
4. Pantry-CLI-on-box recipe resolution: whether the modified duckdb recipe is published to the
   channel the CLI installs from (the official-binary fallback is specified in Phase 7).
5. DuckDB `-json` output framing with multi-statement scripts (the one-result-statement convention
   sidesteps it; verify once against the built binary).
6. Pre-existing production bugs found during exploration, worth separate fixes outside this
   feature: the dashboard.stx dialect SQL (fixed where Phase 6 touches it) and `ILIKE` at
   `routes/logs.ts:201` (not SQLite; plain LIKE is already case-insensitive for ASCII there).
