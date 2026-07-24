CREATE TABLE IF NOT EXISTS "alert_channels" (
  "id" varchar(255) PRIMARY KEY,
  "project_id" varchar(255) not null REFERENCES "projects"("id"),
  "type" varchar(20) not null,
  "label" varchar(255),
  "webhook_url" varchar(255) not null,
  "enabled" boolean,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE INDEX IF NOT EXISTS "alert_channels_alert_channels_project" ON "alert_channels" ("project_id");
