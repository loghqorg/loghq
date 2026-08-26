# Log archive

Aged log entries leave the primary database as Parquet on S3-compatible object
storage and are read back with DuckDB. This file covers how to operate it, what
has been proven, and what has not. For how it works, read `app/Archive/`: the
reasoning lives in the docblocks.

## What it does

1. Entries stay in the primary database for `ARCHIVE_HOT_WINDOW_DAYS` (30).
2. A nightly job (`app/Jobs/ArchiveAgedLogs.ts`, 03:10 UTC) walks every
   (project, UTC day) that has aged out:
   - **Pro projects.** The day is staged as NDJSON, written to Parquet by the
     DuckDB CLI, read back to confirm the row count, and only then deleted from
     the hot database.
   - **Free projects.** Pruned after a 7-day grace, which is the retention the
     pricing page sells. The grace means an upgrade within the week still gets
     those days archived rather than finding them gone.
3. Deleting a project purges its Parquet and its ledger rows, so logs do not
   outlive the project.
4. `/api` archive search and analytics, an Archive scope in the dashboard
   stream, an `/analytics` page, and a Retention section in project settings.

Off by default. With `ARCHIVE_ENABLED=false` the job logs and returns.

## Operating it

### Configuration

Every `ARCHIVE_*` variable is documented in `.env.example`, and production
values belong in the encrypted `.env.production` (see `DEPLOY.md`). For Hetzner
Object Storage:

```
ARCHIVE_S3_ENDPOINT=fsn1.your-objectstorage.com   # or nbg1. / hel1.
ARCHIVE_S3_REGION=fsn1                            # matches the endpoint
ARCHIVE_S3_USE_SSL=true
ARCHIVE_S3_URL_STYLE=path
ARCHIVE_S3_CA_CERT_FILE=                          # empty: public roots
ARCHIVE_DUCKDB_PATH=/usr/local/bin/duckdb         # systemd PATH is not yours
ARCHIVE_DUCKDB_EXTENSION_DIR=/usr/local/share/duckdb-extensions
```

`URL_STYLE=path` is not a preference. Hetzner's wildcard certificate covers a
single label, so virtual-hosted style breaks TLS verification for any bucket
name containing a dot; the framework's own `hetznerDisk` helper defaults to path
style for the same reason. R2 and AWS work with the same variables and their own
endpoint, region, and credentials.

`ARCHIVE_S3_CA_CERT_FILE` is only for self-hosted storage behind an internal CA.
Left empty, DuckDB uses the system trust store. Setting it does not weaken
verification, it says which roots to believe.

### Rollout

1. Provision a bucket and add the `ARCHIVE_*` block to `.env.production`.
2. Deploy. The workflow installs duckdb and caches its extensions. Confirm the
   step's output, and that the scheduler logs the "archive is disabled" line at
   03:10.
3. `buddy archive:run --dry-run` on the box: prints what a run would touch and
   which plan each project is on, and changes nothing.
4. Set `ARCHIVE_ENABLED=true` with `ARCHIVE_DELETE_AFTER_VERIFY=false` for the
   first night. Inspect the written Parquet and the `archive_partitions` rows.
5. Enable deletion.

### Local development

MinIO and DuckDB both come from pantry, so the whole path runs offline:

```bash
mkdir -p /tmp/pt && cd /tmp/pt
pantry install min.io duckdb.org
MINIO_ROOT_USER=loghqtest MINIO_ROOT_PASSWORD=loghqtest123 \
  ./pantry/.bin/minio server /tmp/miniodata --address 127.0.0.1:9100 &
mkdir -p /tmp/miniodata/loghq-archive
./pantry/.bin/duckdb -c "SET extension_directory='/tmp/ext'; \
  INSTALL httpfs; INSTALL json; LOAD httpfs; LOAD json; SELECT 1"
```

Then point `ARCHIVE_S3_ENDPOINT` at `127.0.0.1:9100` with
`ARCHIVE_S3_USE_SSL=false`. MinIO refuses writes when the disk is low on space
(`507 Insufficient Storage`); a RAM disk avoids that.

## What is proven

Against a running dev server and real SQLite:

- Ingest, then the dashboard in all four scopes, both analytics endpoints,
  facets, the `/analytics` page in light and dark, and the settings Retention
  section.
- 403 for archive search on a free plan, 401 unauthenticated, 404 for a foreign
  project.
- The unique-index claim lock rejecting a concurrent claimer, with the winner's
  token surviving.
- The whole free-plan path: partitions selected and labelled prune, a run
  removing exactly those rows and writing the ledger, a re-run being a no-op,
  and a `failed` partition reclaimed with `attempts` incremented.

Against a real S3 endpoint (MinIO), driving the actual exporter:

- A day staged, written to `s3://`, verified, and the hot rows deleted only
  after the count matched, with the object confirmed present by an independent
  client and `parquet_metadata` reporting a real compressed size.
- Read back through `s3://` with the real query builders: an escaped quote, an
  embedded newline, and unicode all intact, plus the volume aggregation.
- A re-run of an emptied day being a no-op, and wrong credentials failing
  loudly rather than returning an empty result.
- Project deletion purging both objects and clearing the ledger, with a second
  purge a harmless no-op.
- Over HTTPS, in both URL styles: `path` (Hetzner) and `vhost` (classic AWS).
  An untrusted certificate is refused, and `USE_SSL=false` against a TLS
  endpoint fails rather than hanging.

Plus 205 unit tests, including the SQL builder's escaping and whitelisting.

## What is not proven

**Hetzner itself.** No Object Storage credentials exist on this machine.
`HCLOUD_TOKEN` is the Cloud API for servers, not Object Storage; its value is
encrypted and `.env.keys` is not here; and Hetzner issues S3 keys per project
from its console. Creating a bucket and keys is an account action with a running
cost, so it belongs to whoever owns the account. What differs from the verified
MinIO runs is the hostname, the credentials, and a publicly trusted certificate,
all of which are configuration rather than code. Step 3 of the rollout is the
first thing to run once they exist.

## Bugs this work found

Three were only reachable by running the thing rather than testing its parts.

- **`read_json` needs the json extension.** The DuckDB preamble loaded `httpfs`
  and nothing else, so every export died on `Table Function with name
  "read_json" is not in the catalog`. The builders emit an identical string
  either way, so only a real binary could catch it.
- **`CREATE SECRET` prints its own result set.** Running in the same invocation
  as the query, it made stdout two concatenated JSON arrays, which `JSON.parse`
  rejects. Every archive query failed, and the export marked partitions failed
  while their Parquet had been written correctly. `parseResultSets` now scans
  bracket depth and the runner takes the last set.
- **Deleting a project left its Parquet in the bucket.** Hot rows went, objects
  and ledger rows stayed, indefinitely and at the customer's cost.

Two more came out of a logic review rather than a run, and would only have bitten
at scale:

- **Staging held the whole day in memory.** `stageDay` paged the database but
  collected every line into an array and joined it, so peak memory was roughly
  twice the day's data. With a 16KB message cap and a 96KB context cap, a busy
  day is gigabytes, and the projects with days that big are exactly the ones
  being archived. It now streams each page to the file; a 12,001-row export
  grows the heap by about 6 MB.
- **Deletion counted the range before every batch.** That made it quadratic in
  the batch count, so a million-row day would have spent five hundred full range
  scans deciding whether to continue. It now counts once, stops on a
  `SELECT 1 ... LIMIT 1`, and returns the counted total rather than
  batches x batch size, which matters because a free-plan prune stores that
  number as the partition's `row_count`.

Two more were pre-existing, in `dashboard.stx` and `routes/logs.ts`: SQL written
in Postgres dialect (`timestamp::timestamptz >= NOW() - INTERVAL`, `ILIKE`)
that SQLite does not degrade on but throws on. Every range except All time, and
every text search, had been rendering empty in production.
`tests/unit/sql-dialect.test.ts` now scans `.stx` as well as `.ts` and covers
`ILIKE`, which is what would have caught them.

## Where the build differs from the original plan

- **No `ArchivePartition` model.** Migrations `0000000016` and `0000000022`
  document that adding a model makes the framework renumber and wipe
  hand-written migrations. `archive_partitions` is a hand-written migration
  (`0000000023`) managed through raw `db.unsafe`, exactly like `log_fix_runs`
  and `project_repositories`. That also settles the plan's open question about
  composite unique indexes: hand-written, so the `UNIQUE (project_id, day)`
  claim lock is guaranteed.
- **`ARCHIVE_DUCKDB_EXTENSION_DIR` and `ARCHIVE_S3_CA_CERT_FILE` were added.**
  The first because the extension cache defaults to per-user `~/.duckdb` and
  the deploy step does not run as the scheduler's user. The second because
  self-hosted storage behind an internal CA is otherwise unusable, and because
  without it the TLS path cannot be exercised locally at all.
- **`runArchiveIfEnabled` returns a reason, not null.** The original only
  logged, so `buddy archive:run` printed nothing and exited non-zero when the
  archive was off.

## Notes on pantry

- `pantry install duckdb.org` installs **project-locally**, into
  `./pantry/.bin/duckdb`. An earlier claim here that it silently wrote no binary
  was wrong: the check had only looked in global locations.
- The published duckdb is a **prebuilt mirrored from pkgx**, not a source build:
  `duckdb.org` is not in pantry's `CUSTOM_BUILD_DOMAINS`. Extension flags added
  to the recipe therefore never reach the shipped binary, which is why an
  attempt to compile httpfs in was reverted upstream. Both development and
  production cache the extensions at runtime instead.

## Contributed upstream

- **stacks `18e68c77f3`** — `resolveS3ClientOptions` stripped the endpoint
  scheme, so a disk configured as `http://127.0.0.1:9100` reached ts-cloud as a
  bare host and was addressed over https. Every plain-http endpoint was
  unreachable, which rules out MinIO and any local verification of the S3
  adapter. `http://` is now preserved; `https://` is still stripped, since a
  bare host is served over TLS anyway. The existing test had asserted the
  stripping, so the bug was written down as intended behaviour.
- **stacks `b5782dda07`** — renamed the example bucket in the object-storage
  tests off an acronym that had no business being there.
- **Still worth doing:** `app/Archive/duckdb.ts` and `parseResultSets` are
  entirely app-agnostic and would suit a `@stacksjs/duckdb` package.
  `app/Archive/storage.ts` is the seam to move onto `@stacksjs/storage` once a
  release carries the endpoint fix.
