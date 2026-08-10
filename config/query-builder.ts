import type { QueryBuilderConfig, SupportedDialect } from 'bun-query-builder'
import { env } from '@stacksjs/env'

const dialect = (env.DB_CONNECTION as SupportedDialect) || 'sqlite'

// For SQLite, use file path; for other databases, use connection params
const databaseConfig = dialect === 'sqlite'
  ? { database: env.DB_DATABASE_PATH || 'database/stacks.sqlite' }
  : {
      database: env.DB_DATABASE || 'stacks',
      username: env.DB_USERNAME || '',
      password: env.DB_PASSWORD || '',
      host: env.DB_HOST || 'localhost',
      port: env.DB_PORT || 5432,
    }

export default {
  verbose: true,

  // Required by QueryBuilderConfig (bun-query-builder types.d.ts:228) and was
  // missing — invisible until `config/` entered tsconfig's `include`. '.qb' is
  // the value the CLI already falls back to (`config.snapshotDir || '.qb'`), and
  // the directory exists in the working tree, so stating it changes nothing at
  // runtime and stops the config from being structurally invalid.
  snapshotDir: '.qb',

  // Same story as snapshotDir, one release later: bun-query-builder 0.2.25
  // declares `migrationDir: string` as REQUIRED (types.d.ts:233), where the
  // parallel @stacksjs/query-builder copy still has it optional
  // (index.d.ts:139). The stacks 0.70.352 upgrade pulled in the stricter one and
  // `tsc --noEmit` started failing on this object, which had been valid.
  //
  // 'database/migrations' is where this app's migrations already are, and the
  // framework resolves the value relative to cwd (relativeMigrationDirectory),
  // so naming it changes nothing at runtime.
  migrationDir: 'database/migrations',

  dialect,
  database: databaseConfig,
  timestamps: {
    createdAt: 'created_at',
    updatedAt: 'updated_at',
    defaultOrderColumn: 'created_at',
  },
  pagination: {
    defaultPerPage: 25,
    cursorColumn: 'id',
  },
  aliasing: {
    relationColumnAliasFormat: 'table_column',
  },
  relations: {
    foreignKeyFormat: 'singularParent_id',
    maxDepth: 10,
    maxEagerLoad: 50,
    detectCycles: true,
  },
  transactionDefaults: {
    retries: 2,
    isolation: 'read committed',
    sqlStates: ['40001', '40P01'],
    backoff: {
      baseMs: 50,
      factor: 2,
      maxMs: 2000,
      jitter: true,
    },
  },
  sql: {
    randomFunction: 'RANDOM()',
    sharedLockSyntax: 'FOR SHARE',
    jsonContainsMode: 'operator',
  },
  features: {
    distinctOn: true,
  },
  debug: {
    captureText: true,
  },
  hooks: {},
  softDeletes: {
    // Enabled so the ORM read path (find/where/all) excludes `deleted_at`
    // rows by default — matching what the auto-CRUD REST routes already do
    // manually. With this off, a soft-deleted (banned/GDPR-erased) row stayed
    // fully visible and authenticatable through every hand-written ORM query.
    // Per-model behavior is still gated by the `useSoftDeletes` trait; models
    // without a `deleted_at` column are unaffected. Use `withTrashed()` to
    // opt back in to deleted rows for a given query.
    enabled: true,
    column: 'deleted_at',
    defaultFilter: true,
  },
} satisfies QueryBuilderConfig
