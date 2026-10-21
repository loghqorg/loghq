-- SQLITE DIALECT, ADJUSTED BY HAND. The generated corpus is postgres
-- flavoured and `buddy migrate:regenerate sqlite` cannot yet emit a minimal
-- one (stacksjs/stacks#2346: it either keeps the postgres files or writes 80
-- migrations for 78 framework models). Fixed upstream, unreleased. Regenerate
-- and delete this note once it ships.
-- Compliance suppression list consulted by @stacksjs/email before every send
-- (bounces, complaints, unsubscribes, manual blocks). The mail layer fails
-- open when the table is missing on sqlite/mysql but not on postgres (its
-- missing-table matcher doesn't know postgres phrasing), so ship the table.
--
-- AUTOINCREMENT dropped, nothing else touched; see the fuller note in
-- 0000000004-create-users-table.sql. In short: one sqlite-only keyword makes
-- `buddy migrate` refuse the entire corpus, and bare `INTEGER PRIMARY KEY`
-- parses in both dialects while still auto-assigning in sqlite.
CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id" INTEGER PRIMARY KEY,
  "email" varchar(255) NOT NULL,
  "type" varchar(32) NOT NULL,
  "reason" varchar(255),
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_type_unique" ON "email_suppressions" ("email", "type");
