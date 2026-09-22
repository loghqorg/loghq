---
title: Projects and teams
description: Organize streams, members, ingest keys, repositories, and lifecycle per project.
---

# Projects and teams

Use a project as the security and retention boundary for one application or closely related service group. Each project has its own ingest key, members, channels, repository connection, active state, and log stream.

## Ingest key rotation

Rotating a key immediately changes the credential accepted by `POST /logs`. Update every sender. The key grants no dashboard access.

## Members

Owners invite members by email. Every dashboard API checks project membership server-side. Removing a member revokes read access without changing ingest.

## Archive versus delete

Archiving makes the project inactive and refuses new ingest while preserving its data. Deleting removes the project, hot rows, archive ledger, and reachable archive objects. Treat deletion as irreversible.
