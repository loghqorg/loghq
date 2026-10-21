-- SQLITE DIALECT, ADJUSTED BY HAND. The generated corpus is postgres
-- flavoured and `buddy migrate:regenerate sqlite` cannot yet emit a minimal
-- one (stacksjs/stacks#2346: it either keeps the postgres files or writes 80
-- migrations for 78 framework models). Fixed upstream, unreleased. Regenerate
-- and delete this note once it ships.
--
-- AUTOINCREMENT dropped, nothing else touched. This app now runs postgres, and
-- `buddy migrate` refuses the ENTIRE corpus when any file is sqlite-only -- so
-- that one keyword left loghq unable to apply any new migration at all. Bare
-- `INTEGER PRIMARY KEY` parses in both dialects and is still a rowid alias in
-- sqlite, so it still auto-assigns; the only thing given up is AUTOINCREMENT's
-- guarantee never to reuse a deleted id.
--
-- Nothing here is rewritten into postgres DDL, because these files did not
-- build the live postgres schema: users.id there is backed by users_id_seq, a
-- sequence this DDL never creates, and 80 migrations are recorded as applied
-- against 20 files on disk.
CREATE TABLE IF NOT EXISTS "users" (
  "id" INTEGER PRIMARY KEY,
  "name" varchar(100) not null,
  "email" varchar(255) not null,
  "password" varchar(255) not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_users_email_unique" ON "users" ("email");
