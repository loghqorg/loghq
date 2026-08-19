-- SQLITE DIALECT, ADJUSTED BY HAND. The generated corpus is postgres
-- flavoured and `buddy migrate:regenerate sqlite` cannot yet emit a minimal
-- one (stacksjs/stacks#2346: it either keeps the postgres files or writes 80
-- migrations for 78 framework models). Fixed upstream, unreleased. Regenerate
-- and delete this note once it ships.
-- The framework's password-reset flow stamps an explicit expiry on each token
-- row (@stacksjs/auth passwordResets.createResetToken). Older installs created
-- the table without it and the insert hard-fails. Also enforce one outstanding
-- token per email at the DB layer (the code deletes-then-inserts already).
-- Self-contained guard: the framework's auth-table step normally creates this
-- table before the numbered migrations run, but a deploy invoked with --no-auth
-- skips it and the ALTER below would hard-fail. Mirror the framework schema
-- (storage/framework/core/database/src/auth-tables.ts) so this migration stands
-- alone, and is a no-op when the table already exists.
CREATE TABLE IF NOT EXISTS "password_resets" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "email" varchar(255) NOT NULL,
  "token" varchar(255) NOT NULL,
  "created_at" timestamp DEFAULT CURRENT_TIMESTAMP,
  -- folded into the CREATE: sqlite has no ADD COLUMN IF NOT EXISTS
  "expires_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "password_resets_email_unique" ON "password_resets" ("email");
