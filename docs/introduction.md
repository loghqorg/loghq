---
title: What is LogHQ
description: Understand LogHQ's flat structured stream and project model.
---

# What is LogHQ

LogHQ is open-source structured log management. Applications send entries to a project through a public ingest key, and operators search the resulting stream by message, severity, channel, environment, release, host, trace, and request.

## A flat stream

Every accepted entry remains an entry. LogHQ does not group, deduplicate, or collapse records. That preserves the line before the failure, which is often the one that explains it.

If you need error fingerprinting and issue lifecycle, use BugHQ. LogHQ focuses on chronological application behavior.

## Project boundaries

An ingest key identifies one project and grants write access only. Dashboard reads require an authenticated account with project membership. Project owners can rotate the key, archive the project, manage members, configure channels, and delete the project.

## Correlation

`trace_id` joins work across services. `request_id` joins lines from one inbound request. They are search keys, not grouping keys, so the underlying records remain intact.
