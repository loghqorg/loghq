-- "Fix with AI": one row per analysis of a log entry.
--
-- Deliberately NOT backed by an app/Models/*.ts, for the same reason
-- project_members isn't (see 0000000006): adding a model makes the framework
-- regenerate and renumber every migration from models and wipe hand-written
-- ones. This table is managed through raw db.unsafe queries in app/Fix/.
--
-- `fingerprint` is what makes the feature affordable. loghq does not group
-- entries (see app/Models/LogEntry.ts), so one bug that fires 400 times is 400
-- rows and 400 buttons. Runs are looked up by (project_id, fingerprint), so the
-- 399 repeats read the first run's answer instead of billing 400 analyses.
CREATE TABLE IF NOT EXISTS "log_fix_runs" (
  "id" varchar(255) PRIMARY KEY,
  "project_id" varchar(255) NOT NULL REFERENCES "projects" ("id"),
  -- The entry the run was started from. Kept for provenance ("analyzed from
  -- this line"); lookups go through the fingerprint, not this column, so a run
  -- survives as the answer for entries that arrive later.
  "log_entry_id" varchar(255) NOT NULL REFERENCES "log_entries" ("id"),
  "fingerprint" varchar(64) NOT NULL,
  "created_by" integer,
  -- queued | running | completed | failed
  "status" varchar(32) NOT NULL DEFAULT 'queued',
  "provider" varchar(32),
  "model" varchar(255),
  -- Denormalized out of `analysis` because the stream list renders them without
  -- parsing the JSON blob.
  "summary" text,
  "root_cause" text,
  "confidence" varchar(16),
  -- The full structured answer: suspects, steps, patch, verification.
  "analysis" text,
  "error" text,
  "started_at" timestamp,
  "completed_at" timestamp,
  -- Reserved for the repository phase (read source, open a draft pull request).
  -- Present from the start so shipping that is code only, not a schema change
  -- on a table that by then holds live rows.
  "branch_name" varchar(255),
  "pr_url" text,
  "pr_number" integer,
  -- UTC, not CURRENT_TIMESTAMP. These columns are `timestamp without time
  -- zone` and this is the first table in loghq whose timestamps are actually
  -- RENDERED, so a server-local default is a visible wrong answer: on a
  -- UTC+8 host an analysis that ran seconds after a 13:53 UTC log line was
  -- labelled 21:53 UTC. Every write in app/Fix/analyze.ts matches this.
  "created_at" timestamp NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
  "updated_at" timestamp
);

-- The cache lookup: newest completed run for this error shape in this project.
CREATE INDEX IF NOT EXISTS "log_fix_runs_project_fingerprint" ON "log_fix_runs" ("project_id", "fingerprint", "created_at");
-- Provenance lookup from a single entry.
CREATE INDEX IF NOT EXISTS "log_fix_runs_entry" ON "log_fix_runs" ("log_entry_id");
-- Two people clicking the same error at the same time must not start two runs.
-- Partial, so it constrains only in-flight work and never the history.
CREATE UNIQUE INDEX IF NOT EXISTS "log_fix_runs_one_active_per_fingerprint" ON "log_fix_runs" ("project_id", "fingerprint")
WHERE "status" IN ('queued', 'running');
