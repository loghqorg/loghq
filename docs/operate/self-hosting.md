---
title: Self-hosting
description: Run LogHQ with Bun, Stacks, PostgreSQL, and optional object storage.
---

# Self-hosting

```bash
git clone https://github.com/stacksjs/loghq.git
cd loghq
bun install
cp .env.example .env
./buddy key:generate
./buddy migrate
bun run dev
```

Use SQLite for local development and PostgreSQL for production. Configure the application URL, database, mail, queue, and encryption key before exposing the service.

## Required services

| Service | Local development | Production guidance |
| --- | --- | --- |
| Bun | Required | Run a supported Bun release and lock dependencies |
| Database | SQLite | PostgreSQL with backups and capacity monitoring |
| Queue | Synchronous operation is convenient | Use a durable configured queue for background work |
| Mail | Log or local mail capture | Configure SMTP or another supported provider |
| Redis | Optional | Recommended for shared rate limits across multiple app instances |
| Object storage | Optional | Required for cold archive storage |

## Production processes

The stx application and API run separately behind one public origin. The API owns ingest and dashboard JSON routes. The app server renders pages and proxies requests internally.

Keep the API port private and expose only the HTTPS application origin through the reverse proxy. Configure trusted proxy behavior so client addresses and per-IP limits use the correct forwarding hop.

## Core configuration

Start with `.env.example` and review:

- `APP_ENV`, `APP_URL`, `APP_KEY`, and debug behavior
- PostgreSQL connection values and connection limits
- Mail delivery and sender identity
- Queue driver, concurrency, retry, and failure storage
- Redis URL or host, port, password, database, and TLS behavior
- Stripe values only when hosted billing is enabled
- Frontend values, which must never contain private credentials

Generate environment encryption keys with `./buddy key:generate`. Keep private keys and decrypted production values out of version control.

## Archive storage

Cold storage is optional. When enabled, configure the archive bucket, endpoint, region, access credentials, URL style, prefix, hot-window days, verification policy, and DuckDB runtime. Use credentials limited to the archive location.

Before automatic deletion from PostgreSQL:

1. Run the archive command against non-production data.
2. Confirm Parquet objects are written to the expected prefix.
3. Query the archived partition through the same search path operators will use.
4. Verify that object checks complete before hot rows are removed.
5. Test restoration or rehydration procedures.

See [retention and archive](/operate/retention-archive) for the data lifecycle.

## Health and deployment

Monitor `/health` or `/api/health`. Alert separately on database capacity, queue health, archive failures, and storage growth. Review `DEPLOY.md`, `config/cloud.ts`, and the workflow before adapting the repository's current deployment.

## Production checklist

- Apply migrations before the new release accepts writes.
- Confirm `/health`, authenticated dashboard access, and one ingest request.
- Verify payload and rate limits at the public edge.
- Test mail, invitations, project membership, and channel test delivery.
- Monitor PostgreSQL disk, connections, slow queries, and backups.
- Monitor queue depth, failed jobs, and scheduler execution.
- Verify archive storage and restore procedures when enabled.
- Keep application, API, and worker logs outside the LogHQ instance they diagnose, or maintain a separate failure path.
