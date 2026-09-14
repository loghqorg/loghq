---
title: Search and filters
description: Find the relevant part of a LogHQ stream quickly.
---

# Search and filters

The project stream is newest-first and keyset paginated. Combine structured filters before reaching for message search.

## Useful dimensions

- `level`: one or more comma-separated severities
- `channel`: logger or subsystem name
- `environment`: deployment environment
- `release`: application version or commit
- `q`: message search
- `trace`: exact trace identifier
- `request`: exact request identifier
- `before`: cursor from the preceding page

## Investigation workflow

1. Select the affected environment and release.
2. Narrow to warning and error severities.
3. Search the visible symptom or subsystem channel.
4. Open a representative line.
5. Follow its trace or request identifier to rebuild the sequence.

Volume, level, and facet reports summarize hot and archived rows separately so a day moved to cold storage does not look like traffic disappeared.
