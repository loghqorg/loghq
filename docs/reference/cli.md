---
title: CLI reference
description: Common development, archive, validation, and documentation commands.
---

# CLI reference

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the local application and API |
| `./buddy migrate` | Apply database migrations |
| `./buddy generate:migrations` | Generate model-driven changes |
| `./buddy archive:run` | Process eligible archive partitions |
| `./buddy test` | Run tests |
| `bun run typecheck` | Run TypeScript checks |
| `./buddy lint` | Run the configured linter |
| `./buddy build docs` | Build the BunPress site |

The documentation build is written to `dist/docs/.bunpress`.

## Initial setup

```bash
bun install
cp .env.example .env
./buddy key:generate
./buddy migrate
```

Use `migrate` for an existing database. Use `migrate:fresh --seed` only for disposable local development data because it recreates the schema.

## Schema changes

Models are the source of truth for generated migrations:

```bash
./buddy generate:migrations
./buddy migrate
```

Inspect generated changes before applying them. Do not edit a deployed migration to change history; add a new model change and generate the next migration.

## Archive operations

```bash
./buddy archive:run
```

The archive command processes eligible time partitions according to the configured hot window, storage destination, verification, and deletion policy. Run it from the scheduler or an operator-controlled job only after object storage and DuckDB access have been verified.

## Quality checks

```bash
./buddy lint
bun run typecheck
./buddy test
./buddy build docs
```

Run focused tests while developing, then the repository's complete required checks before release. `git diff --check` is also useful for detecting whitespace errors that linters may not report.

## Deployment commands

The repository deploys through Buddy and `config/cloud.ts`. Before a production deployment, validate encrypted environment configuration, inspect the cloud diff, and use the deployment dry run supported by the installed Buddy version. Review `./buddy --help` for the exact flags available in your checkout.
