# Log archive: what shipped, and what is still unproven

The tiered-storage plan is implemented and on `main`. This file is what remains
of it: the state of the feature, the places the built thing differs from the
plan, and the one path that has never run against a real DuckDB binary.

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

## Not verified: the Pro export path

**No DuckDB binary was ever available on the development machine**, so nothing
that actually invokes `duckdb` has run. `pantry install duckdb.org` reports
success and `pantry list` shows the package, but no binary is written to disk
anywhere (a pantry CLI bug, tracked separately). There is no Homebrew on the
machine either.

What that leaves unproven is the DuckDB SQL *dialect*, not its construction. The
builders are unit-tested for escaping, whitelisting, shape, and the dialect-token
ban; what has not happened is DuckDB accepting them. Specifically:

- `CREATE SECRET (TYPE s3, ...)` syntax and the `URL_STYLE`/`USE_SSL` keys.
- `read_json(path, format='newline_delimited', columns={...})` with every column
  pinned to `'VARCHAR'`.
- `COPY (...) TO 's3://...' (FORMAT parquet, COMPRESSION zstd)`.
- `parquet_metadata(...)` and `total_compressed_size` as the size source.
- The row-value cursor `("timestamp", "id") < (ts, id)`.
- `-batch -json` framing for one result set per invocation.

Everything above is standard DuckDB and taken from its documented surface, but
none of it has been executed.

### How to close it

On any machine with the binary (or on the box after a deploy):

```bash
duckdb -c "LOAD httpfs; SELECT 1"
```

Then a local round trip that exercises the real builders without needing a
bucket, by pointing the export at a file path instead of `s3://`:

```bash
bun -e "
const { buildExportSql, buildVerifySql } = await import('./app/Archive/sql.ts')
console.log(buildExportSql('bucket', 'k.parquet', '/tmp/part.ndjson'))
"
```

Run that SQL against a staged NDJSON file with the `s3://` target swapped for a
local path and confirm the file is written and reads back at the right count.
After that, the real sequence is the rollout below.

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

## Left alone deliberately

`routes/logs.ts:201` still uses `ILIKE` in the stream API, which is not SQLite.
It is the same class of bug as the dashboard one fixed here, but it sits on a
path this change does not touch, and it deserves its own fix and its own test
rather than being folded into a feature commit.
