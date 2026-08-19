-- SQLITE DIALECT, ADJUSTED BY HAND. See stacksjs/stacks#2346; regenerate
-- and delete this note once the fix ships.
-- Correlation keys for the log stream.
--
-- A log line on its own rarely answers anything. The question is almost
-- always "what else happened around this?". trace_id groups every entry
-- emitted while handling one distributed operation (the W3C traceparent
-- trace-id, when the SDK has one). request_id groups a single inbound
-- request within one service. Both are optional, and entries without them
-- behave exactly as before.
--
-- These are join keys on a flat stream, deliberately NOT grouping columns.
-- No fingerprint, no issue_id. See app/Models/LogEntry.ts.
--
-- varchar(64) fits a 32-hex W3C trace-id with room for other id schemes.
-- The ingest truncates to that width rather than rejecting, since both
-- arrive over public ingest. See docs/ingest.md.
--
-- NOTE: keep semicolons out of these comments. The migration runner splits
-- this file on the statement terminator and re-emits each fragment on its
-- own line, which strips the leading dashes from any comment tail that
-- follows one, turning prose into invalid SQL.
ALTER TABLE "log_entries" ADD COLUMN "trace_id" varchar(64);
ALTER TABLE "log_entries" ADD COLUMN "request_id" varchar(64);
-- "Show me the rest of this trace", always scoped to one project, so the
-- project column leads. Partial indexes: the vast majority of rows carry no
-- correlation id, and indexing those nulls would roughly double the index
-- for no lookup benefit.
CREATE INDEX IF NOT EXISTS "log_entries_le_project_trace" ON "log_entries" ("project_id", "trace_id") WHERE "trace_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "log_entries_le_project_request" ON "log_entries" ("project_id", "request_id") WHERE "request_id" IS NOT NULL;
