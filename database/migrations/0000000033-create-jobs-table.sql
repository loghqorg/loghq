-- The job queue's tables (config/cloud.ts `queues`, app/Jobs, and the
-- framework's own jobs such as SendPasswordResetEmailJob).
--
-- NOTE ON STYLE: no semicolons in these comments. The migration runner splits
-- the file on semicolons without first stripping comment lines.
--
-- Why they were absent: in production the framework queues every dispatched
-- job to the database, and this app never had the tables or a worker. A
-- password reset answered "a link has been sent" while the dispatch failed
-- with `no such table: jobs`, so no email was ever sent.
--
-- These are the statements `buddy queue:table` writes for SQLite, copied
-- here because production applies committed files and generates none. The
-- file is named as that command names its own, so it recognises the tables as
-- already provided. `queue_workers` came with 0000000031.
-- The one addition is the index on jobs, which the worker's poll reads by.
--
-- `reserved_at` and `available_at` are seconds since the epoch.
--
-- Hand-written and additive, with no app/Models/*.ts behind it.
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue TEXT NOT NULL DEFAULT 'default',
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  reserved_at INTEGER,
  available_at INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE INDEX IF NOT EXISTS jobs_queue_available_at_index ON jobs (queue, available_at);

CREATE TABLE IF NOT EXISTS failed_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  connection TEXT NOT NULL,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  exception TEXT NOT NULL,
  attempts INTEGER,
  max_attempts INTEGER,
  duration_ms INTEGER,
  failed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME
);

CREATE TABLE IF NOT EXISTS job_batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  total_jobs INTEGER NOT NULL DEFAULT 0,
  pending_jobs INTEGER NOT NULL DEFAULT 0,
  failed_jobs INTEGER NOT NULL DEFAULT 0,
  failed_job_ids TEXT NOT NULL DEFAULT '[]',
  options TEXT,
  cancelled_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME,
  then_handler TEXT,
  catch_handler TEXT,
  finally_handler TEXT
);

CREATE TABLE IF NOT EXISTS dead_letter_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL,
  connection TEXT NOT NULL,
  queue TEXT NOT NULL,
  payload TEXT NOT NULL,
  exception TEXT NOT NULL,
  reason TEXT NOT NULL,
  total_failures INTEGER NOT NULL DEFAULT 1,
  first_failed_at DATETIME,
  last_failed_at DATETIME,
  dead_lettered_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS job_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  failure_count INTEGER NOT NULL DEFAULT 0,
  window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  quarantined_at DATETIME,
  UNIQUE(job_name, payload_hash)
);

CREATE TABLE IF NOT EXISTS queue_circuit_state (
  queue_name TEXT PRIMARY KEY,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  window_start DATETIME DEFAULT CURRENT_TIMESTAMP,
  paused_at DATETIME,
  resume_at DATETIME
);

CREATE TABLE IF NOT EXISTS job_idempotency (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  job_name TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT 'default',
  dispatched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
