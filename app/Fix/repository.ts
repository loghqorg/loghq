/**
 * The repository a project's code lives in, and the credential to reach it.
 *
 * "Fix with AI" analyses a log entry and describes a fix. Turning that into a
 * pull request needs two things the analyser does not have: the actual source of
 * the files it suspects, and permission to push a branch. Both come from here.
 *
 * Reading source is not optional, and it is why this stores a credential at all
 * rather than only a repo name. ANALYSIS_SCHEMA in ./analyze.ts specifies
 * `patch` as "a concrete code snippet or unified diff when the evidence supports
 * one, else an empty string", produced by a model that has never seen the
 * repository. A pull request built from that would not apply. So the credential
 * is a read credential first and a write credential second.
 *
 * The token is encrypted at rest with APP_KEY (@stacksjs/security, AES-GCM) and
 * is never returned by any endpoint. The settings UI renders `token_hint`, the
 * last four characters, which is enough to answer "which token is this" without
 * a decrypt on a page render.
 *
 * Raw db.unsafe throughout, and no app/Models entry, matching log_fix_runs: a
 * model here would make the framework regenerate migrations from models and wipe
 * the hand-written ones (see database/migrations/0000000016).
 */
import { db } from '@stacksjs/database'
import { decrypt, encrypt } from '@stacksjs/security'
import { utcNow } from '../Support/time'

export interface RepositoryRow {
  project_id: string
  provider: string
  owner: string
  name: string
  default_branch: string | null
  token_kind: string
  token_hint: string | null
  connected_by: number | null
  connected_at: string | null
  last_verified_at: string | null
}

/** What the settings page shows. Deliberately has no token field at all. */
export interface RepositorySummary extends RepositoryRow {
  full_name: string
}

/**
 * Accepts what people actually paste: `owner/repo`, a browser URL, an SSH
 * remote, or any of those with a trailing `.git` or slash.
 *
 * Returns null rather than throwing so the caller decides the status code.
 */
export function parseRepositoryRef(input: string): { owner: string, name: string } | null {
  const raw = String(input ?? '').trim()
  if (!raw)
    return null

  let path = raw
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')

  // A URL may carry more than owner/name (/tree/main, /pull/3). Keep the first
  // two segments and drop the rest.
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2)
    return null
  path = `${parts[0]}/${parts[1]}`

  const [owner, name] = path.split('/')
  // GitHub's own rules: alphanumerics, hyphen, underscore, dot. Validated here
  // so a malformed value cannot be interpolated into an API path.
  //
  // The dot is why the second test exists. `.` and `..` pass a character-class
  // check and are path segments, so `../../etc/passwd` parsed cleanly to
  // { owner: '..', name: '..' } and would have been interpolated straight into
  // `/repos/../../...`. No GitHub owner or repository can be dots alone, so
  // rejecting them costs nothing and closes the traversal.
  const ok = /^[\w.-]+$/
  const dotsOnly = /^\.+$/
  if (!ok.test(owner) || !ok.test(name))
    return null
  if (dotsOnly.test(owner) || dotsOnly.test(name))
    return null
  return { owner, name }
}

/** The connection for a project, without the credential. Null when unconnected. */
export async function getRepository(projectId: string): Promise<RepositorySummary | null> {
  const rows = await db.unsafe(
    `SELECT project_id, provider, owner, name, default_branch, token_kind, token_hint,
            connected_by, connected_at, last_verified_at
     FROM project_repositories WHERE project_id = $1`,
    [projectId],
  )
  const row = rows?.[0] as RepositoryRow | undefined
  if (!row)
    return null
  return { ...row, full_name: `${row.owner}/${row.name}` }
}

/**
 * The decrypted token. Server-side callers only, and never put on a response.
 *
 * Returns null when there is no connection, and also when the stored ciphertext
 * cannot be read: rotating APP_KEY makes every stored token undecryptable, and
 * that has to surface as "reconnect the repository" rather than as a crash.
 */
export async function repositoryToken(projectId: string): Promise<string | null> {
  const rows = await db.unsafe(
    'SELECT token_ciphertext FROM project_repositories WHERE project_id = $1',
    [projectId],
  )
  const ciphertext = (rows?.[0] as { token_ciphertext?: string } | undefined)?.token_ciphertext
  if (!ciphertext)
    return null
  try {
    const value = await decrypt(ciphertext)
    return value ? String(value) : null
  }
  catch {
    return null
  }
}

export async function saveRepository(input: {
  projectId: string
  owner: string
  name: string
  token: string
  defaultBranch?: string | null
  connectedBy?: number | null
}): Promise<RepositorySummary> {
  const ciphertext = String(await encrypt(input.token))
  const hint = input.token.slice(-4)
  const now = utcNow()

  // Upsert on the primary key: reconnecting replaces the credential rather than
  // erroring, which is what "paste a new token" has to mean after a rotation.
  await db.unsafe(
    `INSERT INTO project_repositories
       (project_id, provider, owner, name, default_branch, token_kind, token_ciphertext,
        token_hint, connected_by, connected_at, last_verified_at, created_at, updated_at)
     VALUES ($1, 'github', $2, $3, $4, 'pat', $5, $6, $7, $8, $8, $8, $8)
     ON CONFLICT (project_id) DO UPDATE SET
       owner = excluded.owner,
       name = excluded.name,
       default_branch = excluded.default_branch,
       token_ciphertext = excluded.token_ciphertext,
       token_hint = excluded.token_hint,
       connected_by = excluded.connected_by,
       connected_at = excluded.connected_at,
       last_verified_at = excluded.last_verified_at,
       updated_at = excluded.updated_at`,
    [
      input.projectId,
      input.owner,
      input.name,
      input.defaultBranch ?? null,
      ciphertext,
      hint,
      input.connectedBy ?? null,
      now,
    ],
  )
  return (await getRepository(input.projectId))!
}

/** Record that the credential was just proven good, and what branch it targets. */
export async function markVerified(projectId: string, defaultBranch?: string | null): Promise<void> {
  const now = utcNow()
  await db.unsafe(
    `UPDATE project_repositories
     SET last_verified_at = $2, default_branch = COALESCE($3, default_branch), updated_at = $2
     WHERE project_id = $1`,
    [projectId, now, defaultBranch ?? null],
  )
}

export async function deleteRepository(projectId: string): Promise<void> {
  await db.unsafe('DELETE FROM project_repositories WHERE project_id = $1', [projectId])
}
