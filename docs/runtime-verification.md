# Phase 1.5 runtime verification

This phase verifies the existing foundation against a development Supabase
project. It adds no business CRUD, queue operations, payment or notification work.

## Configuration corrections

The local Supabase URLs had a REST API suffix. Both were corrected to the project
origin; Supabase SDKs append their own Auth and other service paths. No key or
password value was printed. The local DATABASE_URL now uses sslmode=verify-full
and sslrootcert referencing the public certificate under supabase/certs.

The public CA was downloaded over HTTPS from:
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

This is a public CA certificate, not a private key or credential. Another developer
should download their project's CA from Supabase Database settings, confirm it is
appropriate, and configure their own local path. Do not disable verification.

## Migration

Run from the repository root:

```sh
npm run db:migrate:foundation
```

The runner applies the existing foundation SQL without modifying the migration
file. It puts the schema and the standard Supabase migration history record in a
single transaction. Existing matching history is skipped; existing untracked
foundation tables cause it to stop instead of overwriting them. This runner is
limited to the foundation migration; use the Supabase CLI for subsequent phases.

## Safe health and identity endpoints

- GET /api/v1/health: unchanged liveness response.
- GET /api/v1/health/database: SELECT 1 through the Express pg pool; returns only
  connectivity status (200 connected or 503 unavailable). Driver error messages,
  database versions, connection strings and credentials are never returned.
- GET /api/v1/auth/session: validates the bearer token using Supabase Auth and
  returns only authenticated/isAnonymous booleans.
- GET /api/v1/auth/staff: also rejects anonymous identities. This is identity
  verification, not business membership authorization or role assignment.

Database and identity responses use Cache-Control: no-store. Database operations
have connection and query timeouts. Business authorization remains unchanged.

## Browser verification

```sh
npm run verify:browser
```

The runner uses an isolated headless Microsoft Edge context through Playwright.
Edge must be installed. It starts local Express/Vite processes when necessary,
captures their logs only in memory, and stops processes it started. It never saves
browser traces, cookies, access tokens, refresh tokens or passwords.

The development-only /__verify page actually calls the frontend helpers:

1. React requests the API health and database health endpoints.
2. The customer helper silently creates one anonymous Auth session.
3. Express verifies the real token against Supabase.
4. Reloading the page restores the same user without another signup request.
5. Anonymous credentials are rejected by the staff-only identity check.
6. A separate browser context tests staff email/password login when configured.

The page is excluded from production routes and its code is not bundled in the
production JavaScript. Customer verification contains no login/register fields.
The optional /__verify?staff=1 form is a development test harness, not the /login
product UI. The original customer and business routes remain placeholders.

For staff testing, add TEST_STAFF_EMAIL and TEST_STAFF_PASSWORD for an existing,
confirmed development Auth user to apps/api/.env. These variables are read only
by the local verification script; they are not returned by Express or passed to
Vite. Never put staff credentials in a VITE_ variable. No business membership is
required for this Phase 1.5 identity test.

The runner signs out only its own staff test session (local scope), not other
sessions belonging to that user. One anonymous Auth record is created per full
browser test run; no operational records are created. Status-only reports are
written under ignored .runtime/. To rerun just staff verification:

```sh
node scripts/verify-browser.mjs --staff-only
```

## Repeatable checks

```sh
npm run verify:environment
npm run check
npm run test:database
npm run audit:secrets
```

The normal test suite intentionally skips remote database testing unless a test
database is configured. test:database explicitly loads the development database
configuration, runs the real SQL integration test, and rolls back all fixtures.
That test verifies RLS, denied browser grants, tenant integrity and deposit checks.

The secret audit checks .env Git exclusions, tracked and untracked Git candidates,
and local application log files against configured credential values. Browser
verification separately checks captured process/browser logs, including JWT-shaped
tokens. Neither check prints matching values. No Git commit is made by these tools.

Anonymous sign-in must be enabled in Supabase Authentication → Sign In / Providers.
The development project setting was enabled during this verification. Never enable
it by changing unrelated project settings.

## Verified results

- Existing foundation migration applied successfully and recorded as 20260919000100;
  a second run safely reported already-applied. The migration file was unchanged.
- All 12 required tables exist and have RLS enabled.
- Express and the verification scripts connect using certificate-verified TLS.
- Real database integration test passed, with all fixtures rolled back.
- Browser → React → Express → PostgreSQL passed.
- Browser → Supabase anonymous Auth and Express token validation passed.
- Exactly one anonymous signup occurred; page refresh restored the same identity
  without another signup. The customer verification view had no login form.
- Anonymous access to the staff identity endpoint was rejected.
- Staff password login and Express token validation passed after the local test
  credentials were corrected. The test staff account was confirmed in Supabase.
- TypeScript, ESLint and all three workspace builds passed.
- API tests: 14 passed; the database test skips in the offline suite and passed
  separately through test:database (1 passed, 0 skipped).
- .env files are ignored; no configured credential values were found in tracked or
  untracked Git candidates. Captured runtime logs contained no credentials.
- No application log files existed on disk during the audit.
- No further dashboard action is required for Phase 1.5. Phase 1 is runtime-verified.

The Git repository has no tracked files/commits yet; the audit also scanned every
non-ignored candidate file. No secrets, .env files or test-session state were
staged or committed.
