ALTER TABLE "projects" ALTER COLUMN "ingest_key" DROP DEFAULT;
ALTER TABLE "projects" ALTER COLUMN "ingest_key" TYPE varchar(255) USING "ingest_key"::varchar(255);
DROP INDEX IF EXISTS "users_idx_users_stripe_id";
