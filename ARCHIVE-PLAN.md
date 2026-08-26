# Log archive: what shipped, and how it was proven

The tiered-storage plan is implemented and on `main`. This file is what remains
of it: the state of the feature, the places the built thing differs from the
plan, and what remains unproven.

For how the feature works, read the code. `app/Archive/` carries the reasoning
in its docblocks, and `DEPLOY.md` covers provisioning and environment.

## What the feature does

1. Entries stay in the primary database for `ARCHIVE_HOT_WINDOW_DAYS` (30).
2. A nightly job (`app/Jobs/ArchiveAgedLogs.ts`, 03:10 UTC) walks every
   (project, UTC day) that has aged out. Pro projects: the day is staged as
   NDJSON, written to Parquet on S3-compatible storage by the DuckDB CLI, read
   back to confirm the row count, and only then deleted. Free projects: pruned
   after a 7-day grace, which is the retention the pricing page sells.
3. `/api` archive search and analytics, an Archive scope in the dashboard
   stream, an `/analytics` page, and a Retention section in project settings.

Off by default. `ARCHIVE_ENABLED=false` makes the job log and return.

## Where the build differs from the plan

- **No `ArchivePartition` model.** The plan called for `defineModel` plus
  `buddy generate:migrations`. The repo's own precedent overrides that:
  migrations `0000000016` and `0000000022` both document that adding a model
  makes the framework regenerate and renumber every migration and wipe the
  hand-written ones. `archive_partitions` is therefore a hand-written migration
  (`0000000023`) managed through raw `db.unsafe` queries, exactly like
  `log_fix_runs` and `project_repositories`. This also settled the plan's open
  question about composite unique index support: it is hand-written, so the
  `UNIQUE (project_id, day)` claim lock is guaranteed.
- **`ARCHIVE_DUCKDB_EXTENSION_DIR` was added.** Not in the plan. Production uses
  the official DuckDB release binary, which loads httpfs from a cache directory
  that defaults to per-user `~/.duckdb`. The deploy step runs as root and the
  scheduler unit does not necessarily, so the directory is pinned explicitly.
- **`runArchiveIfEnabled` returns a reason, not null.** The original only
  logged, so `buddy archive:run` printed nothing and exited non-zero when the
  archive was off. Found by running it.
- **`pantry install` was misread as broken.** An earlier note here claimed the
  CLI reported success while writing no binary. It does write one: `pantry
  install duckdb.org`installs *project-locally*, into`./pantry/.bin/duckdb`
  and `./pantry/duckdb.org/<version>/bin/duckdb`, and the original check only
  looked in global locations. There is no pantry bug.
- **The pantry binary is a prebuilt, and cannot carry compiled-in extensions.**
  `duckdb.org` is not in pantry's `CUSTOM_BUILD_DOMAINS`, so its publish
  pipeline mirrors pkgx's official prebuilt rather than running the recipe's
  build script: every version logs `Mirrored duckdb.org@x from pkgx - no source
  build`. An attempt to add `-DBUILD_HTTPFS_EXTENSION=1` to the recipe was
  therefore reverted upstream, along with a runtime openssl dependency the
  mirrored binary does not link. Development and production both use the same
  cached-extension approach instead: `INSTALL httpfs; INSTALL json` once into
  an `extension_directory`, which is what the deploy step does.
- **Two pre-existing production bugs fixed in passing.** `dashboard.stx`
  filtered with `timestamp::timestamptz >= NOW() - INTERVAL '...'` and searched
  with `ILIKE`. Against SQLite those do not degrade, they throw
  (`unrecognized token: ":"`, `near "ILIKE": syntax error`), and the surrounding
  catch turned that into the permanent-spinner state. Every range except All
  time, and every text search, had been rendering empty in production.

## Verified

Against a running dev server and real SQLite:

- Ingest, then the dashboard rendering in all four scopes with data, including
  the 24h range that the dialect bug had been breaking.
- Both analytics endpoints returning correctly bucketed series; facets; the
  `/analytics` page in light and dark; the settings Retention section.
- 403 for archive search on a free plan, 401 unauthenticated, 404 for a foreign
  project.
- The unique-index claim lock rejecting a concurrent claimer, with the winner's
  token surviving.
- **The whole free-plan path end to end**: the planner selecting aged partitions
  and labelling them prune, a run removing exactly those rows and writing the
  ledger, a re-run being a no-op, and a partition marked `failed` being
  reclaimed with `attempts` incremented and `error` cleared.
- 185 unit tests, including 41 on the SQL builder's escaping and whitelisting.

## The Pro export path, verified

The DuckDB SQL has now been executed against a real binary (DuckDB 1.5.5 on
macOS arm64), with the `s3://` target swapped for a local path so no bucket was
needed. Everything the builders emit is accepted:

- `CREATE SECRET (TYPE s3, ...)` including the `URL_STYLE` and `USE_SSL` keys.
- `read_json(path, format='newline_delimited', columns={...'VARCHAR'})`, and the
  pinning works: a message of `12345` reads back as VARCHAR, not a number.
- `COPY (...) TO '...' (FORMAT parquet, COMPRESSION zstd)`.
- `parquet_metadata(...).total_compressed_size` as the size source, in the same
  single-row result as the count.
- The row-value cursor `("timestamp", "id") < (ts, id)`.
- `substr(timestamp, 1, 10)` and `(…, 1, 13)` bucketing, `coalesce("release", …)`,
  `ILIKE`, quote escaping (`it's` round-trips), and an embedded newline staying
  one row.
- `-batch -json` framing for one result set per invocation.

### One real bug, found by doing it

The preamble loaded `httpfs` and nothing else, so every export would have failed
on:

```
Catalog Error: Table Function with name "read_json" is not in the catalog,
but it exists in the json extension.
```

`buildExportSql` stages through `read_json`, which lives in the **json**
extension. The preamble now loads both, the deploy step caches both, and
`tests/unit/archive-duckdb.test.ts` asserts both, since the builders emit an
identical string either way and only a real binary could otherwise catch it.

### The s3:// round trip, verified against MinIO

MinIO is in pantry's catalog, so the whole path runs locally with no cloud
account:

```bash
mkdir -p /tmp/pt && cd /tmp/pt
pantry install min.io duckdb.org
MINIO_ROOT_USER=loghqtest MINIO_ROOT_PASSWORD=loghqtest123 \
  ./pantry/.bin/minio server /tmp/miniodata --address 127.0.0.1:9100 &
mkdir -p /tmp/miniodata/loghq-archive
./pantry/.bin/duckdb -c "SET extension_directory='/tmp/ext'; \
  INSTALL httpfs; INSTALL json; LOAD httpfs; LOAD json; SELECT 1"
```

Point `ARCHIVE_S3_ENDPOINT` at `127.0.0.1:9100` with `ARCHIVE_S3_USE_SSL=false`
and `ARCHIVE_S3_URL_STYLE=path`. Driving the real `exportPartition` against that
confirmed, end to end:

- A day staged, written to `s3://`, verified, and the hot rows deleted only
  after the count matched. The object is really in the bucket, checked with an
  independent S3 client.
- `parquet_metadata` reporting a real compressed size (923 bytes for 5 rows).
- The ledger reaching `deleted`, recording the object path, releasing the claim.
- Reading back through `s3://` with the real query builders: all rows, an
  escaped quote (`it's a quote`), an embedded newline, and unicode
  (`日本語 ✓`) all intact, plus the volume aggregation.
- Re-running an emptied day being a no-op.
- Wrong credentials failing loudly rather than returning an empty result.

### A second bug, found only by doing it

`CREATE SECRET` prints its own result set (`[{"Success":true}]`). Since the
preamble runs in the same invocation as the query, stdout was two concatenated
JSON arrays, which `JSON.parse` rejects. **Every archive query failed**, and the
export marked partitions failed while their Parquet had been written correctly
and completely. The local-file check in the previous round missed it because
that harness only inspected exit codes.

`parseResultSets` now scans bracket depth (tracking string literals, since log
messages contain brackets) and the runner takes the last set, which is the
caller's. Six unit tests cover it.

Also hardened while here: `exportPartition` and `prunePartition` refuse to run
without a claim row. They are exported, `markPartition` is an UPDATE, and
without that guard a caller skipping `claimPartition` would delete hot rows and
record nothing, leaving entries that exist only in a bucket nothing points at.

### TLS and both URL styles, verified against MinIO over HTTPS

Plain-HTTP MinIO leaves two things untested that every real provider uses: TLS,
and virtual-hosted URL style. Both now run, against a MinIO served over HTTPS
with a self-signed cert (`--certs-dir`, `MINIO_DOMAIN=localhost` so it answers
bucket-as-subdomain requests):

- `USE_SSL true` with `URL_STYLE 'path'` - what Hetzner Object Storage uses.
  Full export and read-back.
- `USE_SSL true` with `URL_STYLE 'vhost'` - what classic AWS uses. Same.
- An untrusted certificate is **refused** (`SSL peer certificate ... was not
  OK`), so TLS is really being verified rather than waved through.
- `USE_SSL false` against a TLS-only endpoint fails rather than hanging.

That leaves nothing provider-specific in the code untested. What differs between
MinIO and Hetzner from here is the endpoint hostname, the credentials, and
whether the certificate chains to a public root, all of which are env values.

**`ARCHIVE_S3_CA_CERT_FILE` was added** while doing this. Hetzner, R2 and AWS
present publicly trusted certificates and need no value, but self-hosted storage
behind an internal CA is otherwise unusable: duckdb refuses the connection, and
correctly so. Leaving it empty uses the system trust store; setting it does not
weaken verification, it only says which roots to believe.

### Not tested: Hetzner itself

No Hetzner Object Storage credentials exist on this machine. `HCLOUD_TOKEN` is
in `.env.production` but that is the Cloud API for servers, not Object Storage,
its value is encrypted and `.env.keys` is not here, and Hetzner's S3 keys are
issued per project from their console. Creating a bucket and keys is an account
action with a running cost, so it belongs to whoever owns the account.

When that happens, the values are:

```
ARCHIVE_S3_ENDPOINT=fsn1.your-objectstorage.com   # or nbg1./hel1.
ARCHIVE_S3_REGION=fsn1
ARCHIVE_S3_USE_SSL=true
ARCHIVE_S3_URL_STYLE=path
ARCHIVE_S3_CA_CERT_FILE=                          # leave empty
```

and `buddy archive:run --dry-run` on the box is the first thing to run.

## Rollout

1. Provision a bucket (Hetzner Object Storage, R2, MinIO, or AWS: only the env
   values differ) and add the `ARCHIVE_*` block to the encrypted
   `.env.production`. See DEPLOY.md.
2. Deploy. The workflow installs duckdb and caches httpfs; confirm the step's
   output and that the scheduler logs the "archive is disabled" line at 03:10.
3. `buddy archive:run --dry-run` on the box: prints what a run would touch,
   changes nothing.
4. Turn on `ARCHIVE_ENABLED=true` with `ARCHIVE_DELETE_AFTER_VERIFY=false` for
   the first night. Inspect the written Parquet and the `archive_partitions`
   rows.
5. Enable deletion.
