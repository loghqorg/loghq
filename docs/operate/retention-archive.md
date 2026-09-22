---
title: Retention and archive
description: Operate LogHQ's PostgreSQL hot window and Parquet cold archive.
---

# Retention and archive

Recent logs remain in the primary database. A scheduled job processes older complete days.

## Plan behavior

Free projects prune aged rows after the configured grace period. Pro projects export eligible days to Parquet in S3-compatible object storage, verify the object, then delete hot rows when configured to do so.

## Required configuration

Set `ARCHIVE_ENABLED=true` and provide the S3 endpoint, bucket, access key, and secret key. Optional settings control region, URL style, prefix, TLS, hot-window days, deletion after verification, timeouts, and maximum files per query.

An incomplete archive configuration stops archive work and leaves database rows in place.

## Querying cold data

Archive search uses DuckDB for a bounded date range. Only completed ledger partitions count as archived ownership, preventing a staged copy from being counted with the same hot rows.

```bash
./buddy archive:run
```
