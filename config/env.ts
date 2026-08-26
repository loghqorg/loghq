import type { InferEnv } from '@stacksjs/env'
import { defineEnv } from '@stacksjs/env'
import { schema } from '@stacksjs/validation'

/**
 * **Env Configuration & Validations**
 *
 * This configuration defines all of your Env validations. Because Stacks is fully-typed, you
 * may hover any of the options below and the definitions will be provided. In case you
 * have any questions, feel free to reach out via Discord or GitHub Discussions.
 *
 * This file is also where `env` gets its types. Declare a variable here and
 * `env.YOUR_VARIABLE` is typed everywhere, from its validator. Nothing is
 * generated, so a variable that only ever exists in the deploy secrets is
 * typed exactly like one in the local `.env`.
 */
const envSchema = defineEnv({
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
  // queried back with DuckDB. See app/Archive/ and ARCHIVE.md.
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

  /**
   * PEM bundle duckdb should trust for the endpoint's TLS certificate.
   *
   * Empty uses the system trust store, which is right for Hetzner, R2, and AWS.
   * Set it only for self-hosted object storage behind an internal CA: without
   * it duckdb refuses the connection outright, which is the correct default.
   */
  ARCHIVE_S3_CA_CERT_FILE: {
    validation: schema.string(),
    default: '',
  },

  /** Absolute path to the duckdb binary. Empty resolves `duckdb` from PATH. */
  ARCHIVE_DUCKDB_PATH: {
    validation: schema.string(),
    default: '',
  },

  /**
   * Where duckdb looks for installed extensions.
   *
   * Set this in production. The default is per-user (`~/.duckdb`), and the
   * deploy step that caches httpfs does not necessarily run as the user the
   * scheduler runs as. Empty leaves duckdb's own default, which is right in
   * development, where the pantry build has httpfs compiled in.
   */
  ARCHIVE_DUCKDB_EXTENSION_DIR: {
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

  /**
   * Variables the app reads but only ever sets in deploy secrets.
   *
   * Declared here so they are typed. Nothing generates these: the generator
   * only ever saw the variables present in a local `.env`, which none of these
   * are, so they were untyped everywhere they were read.
   */
  LOGHQ_INGEST_URL: {
    validation: schema.string(),
    default: '',
  },

  AUTH_PASSWORD_RESET_URL: {
    validation: schema.string(),
    default: '',
  },

  APP_SERVER_IP: {
    validation: schema.string(),
    default: '',
  },

  STRIPE_WEBHOOK_SECRET: {
    validation: schema.string(),
    default: '',
  },

  AI_FIX_ENABLED: {
    validation: schema.boolean(),
    default: true,
  },

  AI_FIX_MAX_CONTEXT_BYTES: {
    validation: schema.number(),
    default: 48 * 1024,
  },

  AI_FIX_CORRELATED_ENTRIES: {
    validation: schema.number(),
    default: 12,
  },

  AI_FIX_CACHE_HOURS: {
    validation: schema.number(),
    default: 168,
  },

  AI_FIX_TIMEOUT_MS: {
    validation: schema.number(),
    default: 90_000,
  },
})

/**
 * Teach `env` about the variables declared above.
 *
 * Interface declaration merging: this adds the schema's keys to `StacksEnv`,
 * which is the type of the `env` that every `config/` file and action reads.
 */
declare module '@stacksjs/env' {
  interface StacksEnv extends InferEnv<typeof envSchema> {}
}

export default envSchema
