---
title: Dashboard API
description: A categorized map of LogHQ's authenticated management and query endpoints.
---

# Dashboard API

Dashboard endpoints require account authentication and enforce project membership.

## Logs and analytics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/{projectId}/logs` | Paginated hot log stream |
| `GET` | `/api/logs/{logId}` | One log entry |
| `GET` | `/api/projects/{projectId}/analytics/volume` | Volume over time |
| `GET` | `/api/projects/{projectId}/analytics/levels` | Severity totals |
| `GET` | `/api/projects/{projectId}/analytics/facets` | Filter facets |
| `GET` | `/api/projects/{projectId}/archive/search` | Bounded Pro archive search |
| `GET` | `/api/projects/{projectId}/archive/status` | Archive ledger summary |

Project routes support listing, creation, key rotation, archive state, deletion, members, invitations, alert channels, and repository connection. `GET /health` and `GET /api/health` expose service health.

The current implementation in `routes/` is the authority for fields and status codes.
