/**
 * Object lifecycle for the archive.
 *
 * DuckDB reads and writes the Parquet itself, through its own S3 secret (see
 * app/Archive/duckdb.ts): it has to, because the whole point is that the query
 * engine talks to object storage directly. But deleting those files is ordinary
 * object management, and needs an S3 client, because httpfs can read and write
 * an object but not remove one.
 *
 * `@stacksjs/storage` is the natural home for that and is deliberately NOT used
 * yet, for one defect in its S3 adapter that only showed up against a live
 * MinIO: `resolveS3ClientOptions` stripped the scheme from the endpoint, so a
 * disk configured as `http://127.0.0.1:9100` reached ts-cloud as a bare host,
 * which it then addressed over https. Plain-http endpoints were unreachable,
 * which rules out MinIO and with it any local or CI verification.
 *
 * Fixed upstream (stacks, storage adapter: http:// is now preserved, https://
 * is still stripped since a bare host is served over TLS). Switch this module
 * to `Storage.configure` + `disk.deleteFile` once a release carries it; that is
 * the only change needed, and it is why the seam exists.
 *
 * Bun's own S3 client is the stand-in until then: built into the runtime, no
 * dependency, and it handles http and https and both URL styles, all verified
 * against MinIO.
 */
import type { ArchiveConfig } from './config'
import { log } from '@stacksjs/logging'
import { safeId } from './sql'

/** Disk identity, kept for log lines and for the swap to Storage later. */
export const ARCHIVE_DISK = 'loghq-archive'

/**
 * An S3 client for the archive bucket.
 *
 * `useSsl` and `urlStyle` are the same two values DuckDB is given, so the
 * client and the query engine can never disagree about how to address the
 * bucket. Path style is the default: Hetzner's wildcard certificate covers a
 * single label, so virtual-hosted style breaks TLS verification for any bucket
 * name containing a dot, which is the same reason the framework's own
 * hetznerDisk helper defaults to it.
 */
export function archiveClient(cfg: ArchiveConfig): Bun.S3Client {
  return new Bun.S3Client({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    bucket: cfg.bucket,
    region: cfg.region,
    // ArchiveConfig holds a bare host so DuckDB's ENDPOINT can take it
    // verbatim; the scheme is added here from the same useSsl flag.
    endpoint: `${cfg.useSsl ? 'https' : 'http'}://${cfg.endpoint}`,
    virtualHostedStyle: cfg.urlStyle === 'vhost',
  })
}

/** Everything under one project's archive prefix. */
export function projectPrefix(cfg: ArchiveConfig, projectId: string): string {
  const prefix = cfg.prefix ? `${cfg.prefix}/` : ''
  return `${prefix}project_id=${safeId(projectId)}/`
}

export interface PurgeResult {
  deleted: number
  failed: number
}

/**
 * Delete every archived object belonging to one project.
 *
 * Called when a project is deleted. Without it the hot rows go and the Parquet
 * stays, so a customer who deletes a project keeps paying for storage of logs
 * they believe are gone, and the data outlives the consent to hold it.
 *
 * Listing and deleting rather than a single prefix delete because S3 has no
 * recursive delete: `deleteDirectory` is emulated by the adapter for the
 * drivers that need it, and doing it explicitly means a partial failure can be
 * reported per object instead of disappearing into one rejected promise.
 *
 * Failures are counted, not thrown. Project deletion must not be blocked by an
 * object store being briefly unreachable; the ledger rows are what let a later
 * sweep find anything left behind.
 */
export async function purgeProjectArchive(cfg: ArchiveConfig, projectId: string, keys: string[]): Promise<PurgeResult> {
  if (!keys.length)
    return { deleted: 0, failed: 0 }

  const client = archiveClient(cfg)
  let deleted = 0
  let failed = 0

  for (const key of keys) {
    try {
      await client.delete(key)
      deleted++
    }
    catch (error) {
      // An object already gone is a success for our purposes: what matters is
      // that it is not there afterwards.
      const message = String((error as any)?.message ?? error)
      if (/not.?found|no such key|404/i.test(message)) {
        deleted++
        continue
      }
      failed++
      log.warn(`[archive] could not delete ${key} for project ${projectId}: ${message}`)
    }
  }

  return { deleted, failed }
}
