-- GENERATED FROM app/Models/HqConnectCode.ts, THEN ADJUSTED BY HAND.
--
-- `buddy generate:migrations` wrote this file in the dialect of the local
-- database, which is SQLite: every text column as TEXT and `expires_at` as
-- INTEGER. Production runs PostgreSQL (see DEPLOY.md and the note in
-- 0000000004), where INTEGER is 32 bits and `expires_at` holds epoch
-- milliseconds, which do not fit. Two things were changed and nothing else:
--
--   * `expires_at` INTEGER -> BIGINT. SQLite stores any integer type as a
--     64-bit integer, so it reads this the same way it read INTEGER.
--   * the timestamp columns TEXT -> timestamp, matching every other table.
--
-- The `qb:generated` marker was removed with them, so `buddy
-- migrate:regenerate` does not put the 32-bit column back.
--
-- One pending or approved `buddy hq:connect` attempt. Rows are written only by
-- `sqlConnectCodeStore` from `@stacksjs/hq/service` (app/Hq/service.ts). The
-- code itself is never stored: `code_hash` is its SHA-256, and `sealed_grant`
-- is the project's keys encrypted under a key derived from the code.
--
-- `code_hash` is the primary key and there is no surrogate id, because the
-- store's INSERT names no id and PostgreSQL would not invent one.
--
-- Numbered 28. The generator skipped 27.
--
-- NOTE: keep semicolons out of these comments. See 0000000023.
CREATE TABLE IF NOT EXISTS "hq_connect_codes" (
  "code_hash" TEXT PRIMARY KEY,
  "app" TEXT not null,
  "status" TEXT not null,
  "sealed_grant" TEXT,
  "claim" TEXT,
  "expires_at" BIGINT not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "hq_connect_codes_expires_at" ON "hq_connect_codes" ("expires_at");
