-- WRITTEN BY HAND. Valid on SQLite and PostgreSQL as written.
--
-- When each (project, error fingerprint) last alerted. The ingest alerts the
-- first time an error-level line with a given fingerprint is stored, then
-- keeps that fingerprint quiet for a day (app/Errors/log-alerts.ts). That
-- memory used to live in the process, so every restart and every deploy
-- re-sent an alert for each error that was still happening. This table is
-- what makes a restart silent.
--
-- No app/Models/*.ts, for the same reason as 0000000029: the key is the
-- composite one, which a model cannot declare. Read and written only through
-- app/Errors/alert-state.ts.
--
-- `alerted_at` is epoch milliseconds, a number rather than a timestamp, so
-- the quiet-window comparison is plain integer arithmetic on both databases.
-- `claim` is the token of whichever caller's write landed: two instances
-- seeing the same new error both upsert, and only the one that reads its own
-- token back sends. Same protocol as archive_partitions (0000000023).
--
-- Rows older than a week are swept by the store. Nothing else references them.
--
-- Numbered 30, continuing past 0000000029.
--
-- NOTE: keep semicolons out of these comments. See 0000000023.
CREATE TABLE IF NOT EXISTS "log_alert_states" (
  "project_id" varchar(255) NOT NULL,
  "fingerprint" varchar(64) NOT NULL,
  "alerted_at" bigint NOT NULL,
  "claim" varchar(64),
  PRIMARY KEY ("project_id", "fingerprint")
);
CREATE INDEX IF NOT EXISTS "log_alert_states_alerted_at" ON "log_alert_states" ("alerted_at");
