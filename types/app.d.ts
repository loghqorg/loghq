/**
 * loghq domain shapes.
 *
 * Declared GLOBAL rather than exported, and that is deliberate. Two consumers
 * cannot use a normal module import:
 *
 *   - Store files (resources/stores/*.ts) have every single-line `import`
 *     deleted before transpile, so a value import breaks and a type import is
 *     pointless indirection.
 *   - .stx server blocks sit at varying depths (resources/views/projects/…), so
 *     a relative `import type` path differs per file and is easy to get wrong
 *     for no benefit — annotations are erased either way.
 *
 * These ARE typechecked: types/ is in tsconfig's include, so a shape that
 * disagrees with itself fails `tsc --noEmit`. What is NOT checked is the .stx
 * files that annotate against them — tsc cannot parse .stx. The annotations
 * there document intent and are erased by the transpiler; this file is the one
 * place the shapes are actually verified, which is why they belong here rather
 * than inline.
 *
 * Every shape below is transcribed from the query or handler that produces it,
 * not invented. The `db.unsafe` rows are Postgres output, so anything nullable
 * in the schema is nullable here.
 */

declare global {
  // --- Auth ----------------------------------------------------------------

  /**
   * What Auth.getUserFromToken resolves to in a server block. Deliberately
   * narrow: only the three fields the views actually read. The framework's user
   * object carries more (including the password hash), and widening this type
   * would invite bridging it to the client.
   */
  interface AuthUser {
    id: string | number
    name: string
    email: string
  }

  /** The `user` half of GET /api/me (app/Actions/MeAction.ts). */
  interface MeUser {
    id: string | number
    name: string
    email: string
    avatar: string | null
    provider: string | null
    created_at: string | null
  }

  /** Full GET /api/me body. `plan` is derived from `pro`, not stored. */
  interface MeResponse {
    user: MeUser
    pro: boolean
    plan: 'pro' | 'free'
  }

  // --- Projects ------------------------------------------------------------

  /** A row of `projects` as the dashboard and settings pages select it. */
  interface ProjectRow {
    id: string
    name: string
    platform: string | null
    ingest_key: string
    is_active?: boolean
    created_at?: string | null
  }

  /** An invitation the viewer has been sent, joined to its project name. */
  interface PendingInvite {
    token: string
    project_name: string
  }

  // --- Log stream ----------------------------------------------------------

  /** RFC 5424 / PSR-3 severities, lowest to highest. */
  type LogLevel =
    | 'debug' | 'info' | 'notice' | 'warning'
    | 'error' | 'critical' | 'alert' | 'emergency'

  /** A row of `log_entries` as the dashboard selects it. */
  interface LogRow {
    id: string
    level: LogLevel
    message: string
    channel: string | null
    environment: string | null
    release: string | null
    framework: string | null
    host: string | null
    /** Arbitrary structured context, stored as JSON. */
    context: unknown
    timestamp: string
  }

  // --- Settings ------------------------------------------------------------

  /** Where alerts are delivered for a project. */
  interface AlertChannelRow {
    id: string
    type: 'slack' | 'discord'
    label: string | null
    webhook_url: string
    enabled: boolean
    created_at?: string | null
  }

  /** A project member. */
  interface MemberRow {
    id: string
    email: string
    role: string
  }

  /**
   * An outstanding invitation. `registered` is computed by the query (a LEFT
   * JOIN against users), not a column.
   */
  interface InviteRow {
    id: string
    email: string
    token: string
    registered: boolean
  }
}

export {}
