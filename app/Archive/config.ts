/**
 * Configuration for the log archive (cold tier).
 *
 * Aged log partitions leave the primary database as Parquet on S3-compatible
 * object storage, and come back through DuckDB. Everything that decides where
 * those files go, who may write them, and how long the hot window is reads from
 * here rather than touching `env` directly, so the whole surface can be faked in
 * a test by handing a plain object to the functions that take an `ArchiveConfig`.
 *
 * Provider-agnostic on purpose: endpoint, region, URL style, and TLS are all
 * separate knobs, which is what lets the same code write to Hetzner Object
 * Storage, Cloudflare R2, MinIO, or AWS with nothing but different env values.
 */
import { env } from '@stacksjs/env'

export interface ArchiveConfig {
  /** Master switch. False means the nightly job logs and returns, touching nothing. */
  enabled: boolean
  /** Host[:port] with no scheme, e.g. `fsn1.your-objectstorage.com`. */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  useSsl: boolean
  urlStyle: 'path' | 'vhost'
  /** Key prefix inside the bucket, e.g. `logs`. */
  prefix: string
  /** Days of logs kept in the primary database. */
  hotWindowDays: number
  /** Trim exported rows from the hot database once the Parquet row count checks out. */
  deleteAfterVerify: boolean
  /** Extra days a free project's aged logs survive before pruning. */
  freePruneGraceDays: number
  /** Absolute path to the duckdb binary; empty resolves from PATH. */
  duckdbPath: string
  /** Where duckdb looks for installed extensions; empty leaves its default. */
  duckdbExtensionDir: string
  exportTimeoutMs: number
  queryTimeoutMs: number
  maxFilesPerQuery: number
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback
}

/** Read the archive settings out of the environment. */
export function archiveConfig(): ArchiveConfig {
  return {
    enabled: env.ARCHIVE_ENABLED === true,
    endpoint: String(env.ARCHIVE_S3_ENDPOINT ?? ''),
    region: String(env.ARCHIVE_S3_REGION ?? 'auto'),
    bucket: String(env.ARCHIVE_S3_BUCKET ?? ''),
    accessKeyId: String(env.ARCHIVE_S3_ACCESS_KEY_ID ?? ''),
    secretAccessKey: String(env.ARCHIVE_S3_SECRET_ACCESS_KEY ?? ''),
    useSsl: env.ARCHIVE_S3_USE_SSL !== false,
    urlStyle: env.ARCHIVE_S3_URL_STYLE === 'vhost' ? 'vhost' : 'path',
    prefix: String(env.ARCHIVE_S3_PREFIX ?? 'logs').replace(/^\/+|\/+$/g, ''),
    hotWindowDays: num(env.ARCHIVE_HOT_WINDOW_DAYS, 30),
    deleteAfterVerify: env.ARCHIVE_DELETE_AFTER_VERIFY !== false,
    freePruneGraceDays: num(env.ARCHIVE_FREE_PRUNE_GRACE_DAYS, 7),
    duckdbPath: String(env.ARCHIVE_DUCKDB_PATH ?? ''),
    duckdbExtensionDir: String(env.ARCHIVE_DUCKDB_EXTENSION_DIR ?? ''),
    exportTimeoutMs: num(env.ARCHIVE_EXPORT_TIMEOUT_MS, 300000),
    queryTimeoutMs: num(env.ARCHIVE_QUERY_TIMEOUT_MS, 15000),
    maxFilesPerQuery: num(env.ARCHIVE_MAX_FILES_PER_QUERY, 62),
  }
}

/**
 * Null when the config can actually reach a bucket, else a message naming what
 * is missing.
 *
 * Returned rather than thrown: the job logs it and skips the run, because a
 * half-configured archive should not take the scheduler down with it, and an
 * operator reading the log needs the variable name, not a stack trace.
 */
export function archiveReady(cfg: ArchiveConfig): string | null {
  const missing: string[] = []
  if (!cfg.endpoint)
    missing.push('ARCHIVE_S3_ENDPOINT')
  if (!cfg.bucket)
    missing.push('ARCHIVE_S3_BUCKET')
  if (!cfg.accessKeyId)
    missing.push('ARCHIVE_S3_ACCESS_KEY_ID')
  if (!cfg.secretAccessKey)
    missing.push('ARCHIVE_S3_SECRET_ACCESS_KEY')

  if (missing.length)
    return `archive is enabled but not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} empty`

  return null
}
