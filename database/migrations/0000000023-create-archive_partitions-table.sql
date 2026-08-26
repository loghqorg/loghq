-- SQLITE DIALECT, WRITTEN BY HAND. See stacksjs/stacks#2346.
--
-- One row per (project, UTC day) of logs that has aged out of the hot window.
-- This is the ledger the archive runs against: what has been exported, what was
-- verified, what was deleted from the hot database, and what failed.
--
-- Deliberately NOT backed by an app/Models/*.ts, for the same reason
-- log_fix_runs and project_repositories are not (see 0000000016 and
-- 0000000022): adding a model makes the framework regenerate and renumber every
-- migration from models and wipe hand-written ones. Managed through raw
-- db.unsafe queries in app/Archive/exporter.ts.
--
-- Numbered 23, continuing past the high-water mark described in 0000000022.
--
-- The status column is a state machine, enforced in code:
--
--     exporting -> verified -> deleted        the archived path
--     exporting -> pruned                     the free-plan path, no Parquet
--     any        -> failed -> exporting       reclaimed on a later run
--
-- There is no `pending`: a row is only ever written by a run that is already
-- claiming the partition, so `exporting` is the first state it can hold.
--
-- Rows are kept after `deleted` and `pruned`. They are the only record that a
-- day ever existed once its entries have left log_entries, and the query layer
-- reads them to know which Parquet files to open for a historical search.
--
-- NOTE: keep semicolons out of these comments. The migration runner splits this
-- file on the statement terminator and re-emits each fragment on its own line,
-- which strips the leading dashes from any comment tail that follows one,
-- turning prose into invalid SQL.
CREATE TABLE IF NOT EXISTS "archive_partitions" (
  "id" varchar(255) PRIMARY KEY,
  "project_id" varchar(255) NOT NULL REFERENCES "projects" ("id"),
  -- The UTC day this partition covers, as YYYY-MM-DD. Matches the first ten
  -- characters of log_entries.timestamp, which is an ISO-8601 varchar rather
  -- than a timestamp column, so day membership is a string comparison.
  "day" varchar(10) NOT NULL,
  -- exporting | verified | deleted | pruned | failed
  "status" varchar(16) NOT NULL,
  -- Rows written to Parquet, or rows removed for a pruned free-plan day. Read
  -- back from the Parquet file itself during verification, so a mismatch
  -- against what was staged is what fails the partition.
  "row_count" integer,
  -- Compressed size on object storage, from parquet_metadata. Nullable: it is
  -- reporting detail, and losing it must not fail an otherwise good export.
  "byte_size" integer,
  -- Key relative to the bucket, e.g. logs/project_id=abc/date=2026-07-27/part-000.parquet
  "object_path" varchar(512),
  "error" text,
  "attempts" integer NOT NULL DEFAULT 0,
  -- Which run owns this partition right now. There are no transactions anywhere
  -- in this app, so the claim protocol is: insert (the unique index below makes
  -- the loser throw), or update-then-read-back and proceed only if the token
  -- that survived is ours. See claimPartition in app/Archive/exporter.ts.
  "claim_token" varchar(64),
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
-- Load-bearing, not cosmetic: this constraint IS the lock. Two concurrent runs
-- both try to insert the same (project_id, day) and exactly one succeeds.
CREATE UNIQUE INDEX IF NOT EXISTS "archive_partitions_project_day" ON "archive_partitions" ("project_id", "day");
-- Sweeping for work to reclaim: failed partitions, and exporting ones left
-- behind by a crashed run.
CREATE INDEX IF NOT EXISTS "archive_partitions_status_day" ON "archive_partitions" ("status", "day");
