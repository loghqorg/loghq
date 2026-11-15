-- Drop the read_tokens table.
--
-- A person's read token is now a Stacks personal access token carrying the
-- `logs:read` scope (app/Support/read-token.ts), stored hashed in
-- oauth_access_tokens by the framework. This table was a second copy of that:
-- its own id, prefix, SHA-256 and last-used stamp.
--
-- No token was ever issued here, so there is nothing to carry over.
DROP TABLE IF EXISTS "read_tokens";
