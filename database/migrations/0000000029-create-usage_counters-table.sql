-- WRITTEN BY HAND, from `usageCountersMigrationSql()` in `@stacksjs/hq/meter`.
--
-- One row per (owner, meter, period): how many log lines an account stored in
-- a UTC month. Written only by `sqlCounterStore` (app/Billing/meter.ts), whose
-- upsert is `ON CONFLICT (owner, meter, period) DO UPDATE SET used = used +
-- excluded.used`, so any number of app instances converge on one total.
--
-- Deliberately NOT backed by an app/Models/*.ts. A model was tried first and
-- `buddy generate:migrations` gave the table a surrogate `id INTEGER PRIMARY
-- KEY AUTOINCREMENT`. That cannot ship: AUTOINCREMENT is SQLite-only and makes
-- `buddy migrate` refuse the whole corpus on PostgreSQL (see 0000000004), and
-- without it PostgreSQL has no default for an id the store never supplies.
-- The table's real key is the composite one below, which a model cannot
-- declare. This is the same call 0000000023 made for archive_partitions.
--
-- Valid on SQLite and PostgreSQL as written. `owner` is a user id as text.
-- `meter` is `log_lines`, or `log_lines.dropped` for lines sampled out past
-- 120% of the allowance. `period` is YYYY-MM.
--
-- Numbered 29, continuing past 0000000028.
--
-- NOTE: keep semicolons out of these comments. See 0000000023.
CREATE TABLE IF NOT EXISTS "usage_counters" (
  "owner" varchar(191) NOT NULL,
  "meter" varchar(64) NOT NULL,
  "period" char(7) NOT NULL,
  "used" bigint NOT NULL DEFAULT 0,
  "updated_at" timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("owner", "meter", "period")
);
