---
title: Alert channels
description: Configure and test LogHQ notification destinations.
---

# Alert channels

Projects can store email, Slack, and Discord channel configuration. Owners can create, update, delete, and test a channel through the project API.

## Current behavior

> [!WARNING]
> Automated alert triggering is not yet wired into log ingest. A successful channel test proves the destination, not that a future log entry will notify it.

Channel management and test delivery are implemented. The alert support layer can format new-issue and regression messages for the project owner, Slack, and Discord, but `POST /logs` does not currently call that dispatcher. Until the ingest path is connected, use LogHQ search with an external alerting system for production paging.

## Manage channels

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/{projectId}/channels` | List channels with masked webhook URLs |
| `POST` | `/api/projects/{projectId}/channels` | Add a Slack or Discord webhook |
| `PATCH` | `/api/projects/{projectId}/channels/{channelId}` | Enable or disable a channel |
| `DELETE` | `/api/projects/{projectId}/channels/{channelId}` | Remove a channel |
| `POST` | `/api/projects/{projectId}/channels/{channelId}/test` | Send a provider test message |

Every channel action is owner-only. The API validates the webhook provider and host before storage and never returns the complete stored URL to the browser.

## Safe setup

1. Create a dedicated operational channel rather than reusing a general chat room.
2. Use the provider's least-privilege incoming webhook.
3. Send a test after creation and after any credential rotation.
4. Disable or delete unused channels promptly.
5. Keep webhook URLs in server-side configuration and out of log context.
6. Test the complete automatic alert workflow only after the ingest dispatcher is connected.

The intended automatic policy limits alerts to new issues and regressions. Repeat occurrences should increment the issue without sending another message, and a per-project throttle should limit floods of unique failures.
