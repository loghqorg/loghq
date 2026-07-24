# Deploying loghq

loghq deploys to AWS through **ts-cloud** (`stacks buddy deploy` → `@stacksjs/ts-cloud`).
DNS for **loghq.org** is managed at **Porkbun**.

## Prerequisites

Set in `.env` (already wired locally):

| Var | Purpose |
|-----|---------|
| `APP_DOMAIN=loghq.org` | Primary domain |
| `SSL_DOMAINS=loghq.org,www.loghq.org` | ACM certificate SANs |
| `PORKBUN_API_KEY` / `PORKBUN_SECRET_KEY` | Porkbun DNS API (ACM validation + records) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS credentials |
| `DB_CONNECTION=postgres` + `DB_*` | Postgres connection (RDS in cloud, Pantry locally) |

`config/cloud.ts` sets `project.name = loghq`, `dns.domain = loghq.org`, and ACM SSL.
ts-cloud **auto-detects Porkbun** as the DNS provider from the domain's nameservers.

## Database

- **Local dev:** `pantry install postgres && pantry start postgres`, then
  `./buddy migrate` (migrations live in `database/migrations/`).
- **Cloud:** ts-cloud provisions RDS Postgres; point `DB_*` at the RDS endpoint.

## Deploy

```sh
./buddy deploy            # provisions AWS infra + Porkbun DNS, ships the app
```

> Provisioning creates billable AWS resources and live DNS records. Run only when ready.
