---
title: Dashboard API
description: A categorized map of LogHQ's authenticated management and query endpoints.
---

# Dashboard API

Dashboard endpoints require account authentication and enforce project membership. The log stream endpoints also accept a project read key or a read token; see the [Read API](/reference/read).

## Logs and analytics

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/{projectId}/logs` | Hot log stream: page back with `before`, read forward with `after` |
| `GET` | `/api/projects/{projectId}/logs/tail` | Live tail as Server-Sent Events |
| `GET` | `/api/logs/{logId}` | One log entry |
| `GET` | `/api/projects/{projectId}/analytics/volume` | Volume over time |
| `GET` | `/api/projects/{projectId}/analytics/levels` | Severity totals |
| `GET` | `/api/projects/{projectId}/analytics/facets` | Filter facets |
| `GET` | `/api/projects/{projectId}/archive/search` | Bounded Pro archive search |
| `GET` | `/api/projects/{projectId}/archive/status` | Archive ledger summary |

## Read tokens

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/read-tokens` | List your read tokens |
| `POST` | `/api/read-tokens` | Issue a read token, shown once |
| `DELETE` | `/api/read-tokens/{tokenId}` | Revoke a read token |

Project routes support listing, creation, key rotation, archive state, deletion, members, invitations, alert channels, and repository connection. `GET /health` and `GET /api/health` expose service health.

The current implementation in `routes/` is the authority for fields and status codes.
