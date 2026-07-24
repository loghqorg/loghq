CREATE TABLE IF NOT EXISTS "log_entries" (
  "id" varchar(255) PRIMARY KEY,
  "project_id" varchar(255) not null REFERENCES "projects"("id"),
  "level" varchar(255),
  "message" text not null,
  "channel" varchar(255),
  "context" text,
  "environment" varchar(255),
  "release" varchar(255),
  "framework" varchar(255),
  "host" varchar(255),
  "sdk" text,
  "user_context" text,
  "timestamp" varchar(255) not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "log_entries_le_project_timestamp" ON "log_entries" ("project_id", "timestamp");
CREATE INDEX IF NOT EXISTS "log_entries_le_project_level" ON "log_entries" ("project_id", "level");
