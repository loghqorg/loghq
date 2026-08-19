-- SQLITE DIALECT, ADJUSTED BY HAND. The generated corpus is postgres
-- flavoured and `buddy migrate:regenerate sqlite` cannot yet emit a minimal
-- one (stacksjs/stacks#2346: it either keeps the postgres files or writes 80
-- migrations for 78 framework models). Fixed upstream, unreleased. Regenerate
-- and delete this note once it ships.
-- The two ALTER COLUMN statements here were no-ops: 0000000001 already declares
-- `"ingest_key" varchar(255)` with no default. sqlite cannot ALTER COLUMN at all,
-- so they are dropped rather than translated.
DROP INDEX IF EXISTS "users_idx_users_stripe_id";
