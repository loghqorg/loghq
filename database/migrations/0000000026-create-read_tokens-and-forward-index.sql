-- SQLITE DIALECT, WRITTEN BY HAND. See stacksjs/stacks#2346.
--
-- Two things a desktop client needs to follow logs.
--
-- 1. `read_tokens`: a person's read token (app/Models/ReadToken.ts,
--    app/Support/read-token.ts). One credential that reads every project its
--    owner can see, so an app following several projects does not hold one
--    project read key each. Only the SHA-256 of a token is stored, which is
--    why the uniqueness is on `token_hash`: a request is authorised by looking
--    its hash up, and two rows answering one hash would make that ambiguous.
--    Deleting the row is revoking the token.
--
-- 2. An index for reading the stream forward. `GET /api/projects/{id}/logs`
--    with `after`, and the live tail, walk `(created_at, id)` in arrival order
--    (app/Logs/query.ts). The existing `(project_id, timestamp)` index orders
--    by the time the SDK reported, which is the wrong order for a reader that
--    must not miss a late batch. Without this one every poll of every open
--    tail would sort the project's whole stream.
--
-- Numbered 26, continuing past 0000000025.
CREATE TABLE IF NOT EXISTS "read_tokens" (
  "id" varchar(255) PRIMARY KEY,
  "user_id" integer not null REFERENCES "users"("id"),
  "name" varchar(80) not null,
  "token_hash" varchar(64) not null,
  "token_hint" varchar(8),
  "last_used_at" timestamp,
  "expires_at" timestamp,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "read_tokens_token_hash_unique" ON "read_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "read_tokens_user" ON "read_tokens" ("user_id");
CREATE INDEX IF NOT EXISTS "log_entries_le_project_created" ON "log_entries" ("project_id", "created_at", "id");
