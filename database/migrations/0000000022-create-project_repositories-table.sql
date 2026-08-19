-- SQLITE DIALECT, WRITTEN BY HAND. See stacksjs/stacks#2346.
--
-- Numbered 22, not 18, deliberately. The production ledger has already applied
-- files numbered 17 through 21 that no longer exist in this repo, and it holds
-- TWO different files both numbered 0000000017 (an -auto-misc and an
-- alert_channels index). That is stacksjs/stacks#2203: regenerating renumbers
-- files without updating the ledger. Starting past the high-water mark keeps
-- this file unambiguous whatever happened before it.
--
-- The repository a project's code lives in, plus the credential used to reach
-- it. One row per project: a project is one application, and "which repo do I
-- open a pull request against" has exactly one answer.
--
-- Deliberately NOT backed by an app/Models/*.ts, for the same reason
-- log_fix_runs isn't (see 0000000016): adding a model makes the framework
-- regenerate and renumber every migration from models and wipe hand-written
-- ones. Managed through raw db.unsafe queries in app/Fix/repository.ts.
CREATE TABLE IF NOT EXISTS "project_repositories" (
  "project_id" varchar(255) PRIMARY KEY REFERENCES "projects" ("id"),
  -- 'github' today. Named rather than assumed so adding GitLab is a value, not
  -- a column.
  "provider" varchar(32) NOT NULL DEFAULT 'github',
  "owner" varchar(255) NOT NULL,
  "name" varchar(255) NOT NULL,
  -- Resolved from the API when the connection is verified, so opening a pull
  -- request does not have to guess between main and master.
  "default_branch" varchar(255),
  -- 'pat' today. A GitHub App installation stores an installation id here
  -- instead of a token, and this column is what lets that arrive without a
  -- migration on a table that by then holds live credentials.
  "token_kind" varchar(16) NOT NULL DEFAULT 'pat',
  -- Encrypted with APP_KEY via @stacksjs/security. Never stored in the clear,
  -- and never returned by any endpoint: the settings UI renders `token_hint`.
  "token_ciphertext" text NOT NULL,
  -- Last four characters, kept so the UI can say WHICH token is connected
  -- without decrypting one to render a page.
  "token_hint" varchar(8),
  "connected_by" integer,
  "connected_at" timestamp,
  -- Set every time the credential is proven against the API. A token that was
  -- valid at connect time can be revoked later, and this is how the UI can say
  -- when it was last known good.
  "last_verified_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamp
);
