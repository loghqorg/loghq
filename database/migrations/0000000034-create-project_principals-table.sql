-- Project principals: the owner of the tokens that act for a project.
--
-- A Stacks personal access token records its owner's table and numeric id
-- (`tokenable_type`, `tokenable_id`). A project's id is text, so each project
-- gets one row here and the row's id is what its read keys belong to
-- (app/Models/ProjectPrincipal.ts, app/Support/project-tokens.ts).
CREATE TABLE IF NOT EXISTS "project_principals" (
  "id" integer PRIMARY KEY AUTOINCREMENT,
  "project_id" varchar(255) not null REFERENCES "projects"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "project_principals_project_unique" ON "project_principals" ("project_id");

-- A read key is now a project token, stored hashed in the framework's token
-- table, so the plain-text column goes. SQLite cannot compute the SHA-256 the
-- framework stores, so the one key issued before this ran was carried over
-- beforehand under its current value (see the commit that added this file).
-- A key still in the column when this runs is dropped with it and has to be
-- issued again from the project's settings.
DROP INDEX IF EXISTS "projects_read_key_unique";
ALTER TABLE "projects" DROP COLUMN "read_key";
ALTER TABLE "projects" DROP COLUMN "read_key_last_used_at";
