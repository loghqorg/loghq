import type { EnvConfig } from '@stacksjs/env'
import { schema } from '@stacksjs/validation'

/**
 * **Env Configuration & Validations**
 *
 * This configuration defines all of your Env validations. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  APP_NAME: {
    validation: schema.string(),
    default: 'Stacks',
  },

  APP_ENV: {
    validation: schema.enum(['local', 'dev', 'stage', 'prod']),
    default: 'local',
  },

  APP_KEY: {
    validation: schema.string(),
    default: 'base64:1234567890',
  },

  PORT: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_BACKEND: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_ADMIN: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_LIBRARY: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_DESKTOP: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_EMAIL: {
    validation: schema.number(),
    default: 3000,
  },
  PORT_DOCS: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_INSPECT: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_API: {
    validation: schema.number(),
    default: 3000,
  },

  PORT_SYSTEM_TRAY: {
    validation: schema.number(),
    default: 3000,
  },

  APP_MAINTENANCE: {
    validation: schema.boolean(),
    default: false,
  },

  APP_MAINTENANCE_SECRET: {
    validation: schema.string(),
    default: '',
  },

  APP_COMING_SOON: {
    validation: schema.boolean(),
    default: false,
  },

  APP_COMING_SOON_SECRET: {
    validation: schema.string(),
    default: '',
  },

  DEBUG: {
    validation: schema.boolean(),
    default: false,
  },

  API_PREFIX: {
    validation: schema.string(),
    default: '/api',
  },

  AI_DRIVER: {
    validation: schema.enum(['anthropic', 'openai', 'ollama']),
    default: 'openai',
  },

  AI_AUTOFIX_ENABLED: {
    validation: schema.boolean(),
    default: true,
  },

  AI_AUTOFIX_DRAFT: {
    validation: schema.boolean(),
    default: true,
  },

  AI_AUTOFIX_MAX_FILES: {
    validation: schema.number(),
    default: 5,
  },

  AI_AUTOFIX_MAX_SOURCE_BYTES: {
    validation: schema.number(),
    default: 524288,
  },

  AI_AUTOFIX_BRANCH_PREFIX: {
    validation: schema.string(),
    default: 'loghq/autofix',
  },

  GITHUB_TOKEN: {
    validation: schema.string(),
    default: '',
  },

  OPENAI_API_KEY: {
    validation: schema.string(),
    default: '',
  },

  OPENAI_MODEL: {
    validation: schema.string(),
    default: 'gpt-4o',
  },

  OPENAI_MAX_TOKENS: {
    validation: schema.number(),
    default: 8192,
  },

  OPENAI_BASE_URL: {
    validation: schema.string(),
    default: 'https://api.openai.com/v1',
  },

  ANTHROPIC_API_KEY: {
    validation: schema.string(),
    default: '',
  },

  ANTHROPIC_MODEL: {
    validation: schema.string(),
    default: 'claude-sonnet-4-20250514',
  },

  ANTHROPIC_MAX_TOKENS: {
    validation: schema.number(),
    default: 8192,
  },

  OLLAMA_HOST: {
    validation: schema.string(),
    default: 'http://localhost:11434',
  },

  OLLAMA_MODEL: {
    validation: schema.string(),
    default: 'llama3.2',
  },

  DOCS_PREFIX: {
    validation: schema.string(),
    default: '/docs',
  },

  DB_CONNECTION: {
    validation: schema.enum(['mysql', 'sqlite', 'postgres']),
    default: 'mysql',
  },

  DB_HOST: {
    validation: schema.string(),
    default: 'localhost',
  },

  DB_PORT: {
    validation: schema.number(),
    default: 3306,
  },

  AWS_ACCOUNT_ID: {
    validation: schema.string(),
    default: '',
  },

  AWS_ACCESS_KEY_ID: {
    validation: schema.string(),
    default: '',
  },

  AWS_SECRET_ACCESS_KEY: {
    validation: schema.string(),
    default: '',
  },

  AWS_DEFAULT_REGION: {
    validation: schema.string(),
    default: '',
  },

  AWS_DEFAULT_PASSWORD: {
    validation: schema.string(),
    default: '',
  },

  MAIL_MAILER: {
    validation: schema.enum(['ses', 'sendgrid', 'mailgun', 'mailtrap', 'smtp', 'postmark', 'sendmail', 'log']),
    default: 'ses',
  },

  MAIL_HOST: {
    validation: schema.string(),
    default: '',
  },

  MAIL_PORT: {
    validation: schema.number(),
    default: 465,
  },

  MAIL_USERNAME: {
    validation: schema.string(),
    default: '',
  },

  MAIL_PASSWORD: {
    validation: schema.string(),
    default: '',
  },

  MAIL_FROM_ADDRESS: {
    validation: schema.string(),
    default: '',
  },

  SEARCH_ENGINE_DRIVER: {
    validation: schema.enum(['meilisearch', 'algolia', 'typesense']),
    default: 'meilisearch',
  },

  STRIPE_SECRET_KEY: {
    validation: schema.string(),
    default: '',
  },

  STRIPE_PUBLISHABLE_KEY: {
    validation: schema.string(),
    default: '',
  },

  MEILISEARCH_HOST: {
    validation: schema.string(),
    default: '',
  },

  MEILISEARCH_KEY: {
    validation: schema.string(),
    default: '',
  },

  FRONTEND_APP_ENV: {
    validation: schema.enum(['development', 'staging', 'production']),
    default: 'development',
  },

  FRONTEND_APP_URL: {
    validation: schema.string(),
    default: '',
  },

  // ---------------------------------------------------------------------------
  // Log archive (cold tier)
  //
  // Aged log partitions are exported to Parquet on S3-compatible storage and
  // queried back with DuckDB. See app/Archive/ and ARCHIVE-PLAN.md.
  //
  // These deliberately do not reuse the AWS_* namespace: config/filesystems.ts
  // reads AWS_S3_BUCKET while .env.example declares AWS_BUCKET, and neither is
  // wired to anything, so that namespace cannot be trusted to mean one thing.
  // ---------------------------------------------------------------------------

  ARCHIVE_ENABLED: {
    validation: schema.boolean(),
    default: false,
  },

  /** Host[:port] with no scheme, e.g. `fsn1.your-objectstorage.com`. */
  ARCHIVE_S3_ENDPOINT: {
    validation: schema.string(),
    default: '',
  },

  ARCHIVE_S3_REGION: {
    validation: schema.string(),
    default: 'auto',
  },

  ARCHIVE_S3_BUCKET: {
    validation: schema.string(),
    default: '',
  },

  ARCHIVE_S3_ACCESS_KEY_ID: {
    validation: schema.string(),
    default: '',
  },

  ARCHIVE_S3_SECRET_ACCESS_KEY: {
    validation: schema.string(),
    default: '',
  },

  ARCHIVE_S3_USE_SSL: {
    validation: schema.boolean(),
    default: true,
  },

  /** `path` suits Hetzner Object Storage, MinIO, and R2; `vhost` suits classic AWS. */
  ARCHIVE_S3_URL_STYLE: {
    validation: schema.enum(['path', 'vhost']),
    default: 'path',
  },

  ARCHIVE_S3_PREFIX: {
    validation: schema.string(),
    default: 'logs',
  },

  /** Days of logs kept in the primary database. Older days age out to the archive. */
  ARCHIVE_HOT_WINDOW_DAYS: {
    validation: schema.number(),
    default: 30,
  },

  /** Trim exported rows from the hot database once the Parquet row count checks out. */
  ARCHIVE_DELETE_AFTER_VERIFY: {
    validation: schema.boolean(),
    default: true,
  },

  /** Extra days a free project's aged logs survive before pruning, so an upgrade still saves them. */
  ARCHIVE_FREE_PRUNE_GRACE_DAYS: {
    validation: schema.number(),
    default: 7,
  },

  /** Absolute path to the duckdb binary. Empty resolves `duckdb` from PATH. */
  ARCHIVE_DUCKDB_PATH: {
    validation: schema.string(),
    default: '',
  },

  ARCHIVE_EXPORT_TIMEOUT_MS: {
    validation: schema.number(),
    default: 300000,
  },

  ARCHIVE_QUERY_TIMEOUT_MS: {
    validation: schema.number(),
    default: 15000,
  },

  /** Parquet files one query may open. 62 is roughly two months of daily partitions. */
  ARCHIVE_MAX_FILES_PER_QUERY: {
    validation: schema.number(),
    default: 62,
  },
} satisfies EnvConfig
