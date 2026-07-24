CREATE TABLE IF NOT EXISTS "log_entries" (
  "id" varchar(255) PRIMARY KEY,
  "project_id" varchar(255),
  "level" varchar(255),
  "message" text,
  "channel" varchar(255),
  "context" text,
  "environment" varchar(255),
  "release" varchar(255),
  "framework" varchar(255),
  "host" varchar(255),
  "sdk" text,
  "user_context" text,
  "timestamp" varchar(255),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
