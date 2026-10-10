# Local E2E safety

These mutating HTTP suites are disabled by default. A reachable development server
does not opt a normal unit-test run into account creation or database cleanup.

An intentional run requires all three variables:

- `E2E_RUN=1`
- `E2E_BASE_URL`: an HTTP numeric-loopback origin with an explicit port, such as
  `http://127.0.0.1:3100`. Remote hosts, redirects and URL credentials are not allowed.
- `E2E_SQLITE_PATH`: an absolute path to an existing `database.sqlite` inside a
  freshly created `loghq-e2e-*` directory directly under the system temp directory.

Start a separate local application instance using that same disposable database.
Do not point the test instance at real data. Disable outbound mail, notifications,
webhooks and paid integrations in that instance before running these suites.
The URL guard cannot prove which database or integrations a local server uses;
the operator must configure the isolated server correctly.

Cleanup opens only the explicitly named disposable SQLite file and only removes
accounts whose exact email addresses were generated in this process. It never
uses the application's default database connection or a wildcard email match.

## Known coverage gap

The auth and routing suites still contain expectations for the previous page-action
login and readable `loghq_token` cookie. They need migration to the current JSON
auth endpoints and HttpOnly `auth-token` contract before they can serve as a current
auth release gate. This safety guard does not claim those legacy expectations pass.
