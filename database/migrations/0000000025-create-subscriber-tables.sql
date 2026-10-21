-- SQLITE DIALECT, WRITTEN BY HAND. See stacksjs/stacks#2346.
--
-- The two tables behind POST /api/email/subscribe. Without them the newsletter
-- form on the homepage answered 500 in production: the route is registered
-- (routes/api.ts) and points at the framework's SubscriberEmailAction, which
-- opens with `Subscriber.where('email', email).first()` against a table this
-- app had never created.
--
-- They were missing because `buddy generate:migrations` deliberately does not
-- emit them. Framework-owned models stopped being generated once app/Models
-- defines the schema (stacksjs/stacks#2220), and this app does not set
-- `database.models.includeFrameworkDefaults`. So the generator leaves these 64
-- framework tables alone by design, and an app that USES one of their actions
-- has to bring the table itself. Hand-written rather than generated for that
-- reason: running the generator here emits Postgres syntax and a duplicate of
-- the read_key migration beside it.
--
-- Shapes follow storage/framework/defaults/app/Models/{Subscriber,SubscriberEmail}.ts
-- exactly, because the framework action writes through those models.
--
-- The unique index on email is load-bearing, not decoration. The action's fast
-- path checks for an existing subscriber and then creates one, so two requests
-- for the same address can both pass the check; it catches the loser's unique
-- violation and reports "already subscribed" (stacksjs/stx#1957). With no
-- index there is no violation to catch and the address is stored twice.
--
-- `uuid` is what the footer's unsubscribe link carries
-- (/api/email/unsubscribe?token=<uuid>), so it is unique here too.

CREATE TABLE IF NOT EXISTS "subscribers" (
  "id" INTEGER PRIMARY KEY,
  "uuid" varchar(255),
  "email" varchar(255) not null,
  "status" varchar(255) not null default 'subscribed',
  "source" varchar(100) default 'homepage',
  "unsubscribed_at" timestamp,
  "user_id" bigint REFERENCES "users"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_subscribers_email_unique" ON "subscribers" ("email");
CREATE UNIQUE INDEX IF NOT EXISTS "subscribers_subscribers_uuid_unique" ON "subscribers" ("uuid");

-- One row per signup event, kept even after the subscriber unsubscribes, which
-- is why it is a separate table rather than a column on `subscribers`.
CREATE TABLE IF NOT EXISTS "subscriber_emails" (
  "id" INTEGER PRIMARY KEY,
  "uuid" varchar(255),
  "email" varchar(255) not null,
  "source" varchar(100) default 'homepage',
  "subscriber_id" bigint REFERENCES "subscribers"("id"),
  "created_at" timestamp not null default CURRENT_TIMESTAMP,
  "updated_at" timestamp
);

CREATE UNIQUE INDEX IF NOT EXISTS "subscriber_emails_subscriber_emails_uuid_unique" ON "subscriber_emails" ("uuid");
CREATE INDEX IF NOT EXISTS "subscriber_emails_email" ON "subscriber_emails" ("email");
