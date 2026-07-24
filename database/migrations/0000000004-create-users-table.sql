CREATE TABLE IF NOT EXISTS "users" (
  "id" BIGSERIAL PRIMARY KEY,
  "name" varchar(100) not null,
  "email" varchar(255) not null,
  "password" varchar(255) not null,
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_users_email_unique" ON "users" ("email");
