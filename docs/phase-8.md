# Phase 8 — final MVP verification

## Scope and outcome

Phase 8 adds business registration, usable profiles, email-based team assignment,
owner onboarding and deployment preparation. No hosting project was created and
nothing was deployed. Real payment and WhatsApp providers remain outside MVP.

Implementation is complete. Final sign-off remains pending a successful single
real-registration-to-completion browser run. The development Auth email quota
currently blocks that retry; no production-readiness sign-off is claimed.

## Product behavior

- Business users register at /register using Supabase Auth with name, normalized
  email, password and confirmation. Email confirmation follows project settings.
  Login, logout, loading, mismatch and invalid-credential states are supported.
  Duplicate-email guidance preserves Supabase's account-enumeration protection.
- Users without memberships see onboarding. Creating a business atomically grants
  OWNER; setup continues through branch, service, counter, queue and public link.
- Staff register and confirm their own account first. OWNER adds an exact email
  with MANAGER or STAFF role. Unknown/unconfirmed accounts get register-first
  guidance. There is no invitation delivery, autocomplete or public directory.
- Existing branch/service assignment and final-active-OWNER protections remain.
  Team cards show names, emails, roles and assignments instead of Auth UUIDs.
- Public queue links use the current frontend origin; copy/open controls are
  available. Changing a branch slug warns that existing public links will break.
- Existing navigation is role-aware. Empty/loading/error states, deactivation and
  role-change confirmations, mobile/tablet/desktop layout were reviewed.
- Customers retain separate anonymous sessions and never use business registration.

## Database and API

New migration: supabase/migrations/20260923000100_business_profiles.sql.
Applied to the configured development Supabase database; prior migrations were
not edited. It adds normalized profile email, an exact unique lookup index and
an Auth trigger/backfill for permanent-user profiles. Metadata cannot grant roles.
Anonymous accounts do not gain business profiles. Browser profile access remains
revoked. Re-running the migration helper reports already-applied migrations.

New endpoint: POST /api/v1/businesses/:businessId/members/by-email.
It requires a verified bearer token and current OWNER membership, validates a
strict email/role body, and resolves an exact normalized, confirmed permanent
account. The existing UUID endpoint remains for compatibility, outside normal UI.
No public user lookup endpoint was introduced.

## Production preparation and security review

Production startup validates required configuration, HTTPS origins and PostgreSQL
sslmode=verify-full. The verified TLS connection is retained. CORS permits the
configured WEB_ORIGIN; health endpoints disclose only connectivity/status.
Frontend configuration contains public Supabase configuration and VITE_API_URL;
DATABASE_URL and private credentials remain server-only. Mock payment and WhatsApp
endpoints are disabled in production even when development flags are set. The
production checkout has no mock controls, and the development verification route
is absent. API errors omit SQL, stack traces and credentials.

Authorization remains in Express: verified identity, current business membership,
branch scope and service scope. Parameterized SQL, composite tenant foreign keys,
transactional locks, idempotency and version checks remain in place. Regression
coverage explicitly checks cross-business/branch/service access, changed membership,
final-owner safety, customer/payment/notification ownership, scoped analytics and
production-only boundaries. The server database credential is privileged; this
phase does not claim a new least-privilege database role or RLS actor redesign.

## Verification results

- TypeScript, ESLint, contracts/API/frontend builds: passed.
- Offline suite: 32 passed; eight database suites intentionally skipped in this
  offline invocation and exercised separately against development PostgreSQL.
- Full database integration suite: 85 passed, zero failures/skips. Includes Auth,
  configuration, tenant isolation, queue concurrency, payments/reconciliation,
  notifications and analytics; new registration integration suite has eight tests.
- Configuration/team browser regression: 17 passing checks.
- Queue browser regression as STAFF: 20 passing checks, including anonymous
  persistence, ownership, cancellation and realtime queue operations.
- Production browser/server verification: 11 passing checks. Auth error/confirmation
  presentation is tested with controlled Auth responses; this is distinct from
  the real Supabase registration scenario below.
- Credential audit: both .env files ignored, neither tracked, no configured secret
  matches in candidate source files and no private credentials in built assets.
  There are no tracked files in the existing repository yet, so untracked,
  non-ignored source files were also audited. No commits were made.
- No application .log files existed to inspect; browser verification separately
  audits captured server output and reports no credentials in logs.
- Two existing third-party Zod/Rollup annotation warnings are non-blocking.

### Complete browser scenario

Real Supabase OWNER and STAFF registration, login/logout, empty onboarding,
complete owner setup, email assignment, responsive UI and anonymous admission
passed together. That run timed out waiting 45 seconds for CALLED on the customer
screen despite a successful call API response. No definitive cause is established.
The existing connected-client recovery poll is 60 seconds, so the diagnostic test
now allows 80 seconds; the application polling behavior was not changed.

A separate complete run using --fixture-accounts passed: real password login for
disposable confirmed accounts, Salon Anna Wijaya / Sunter / Potong Rambut setup,
email assignment, anonymous admission, STAFF call/start/complete, realtime
notifications, owner analytics and FULL mock payment. Five committed broadcast
frames arrived; HTTP snapshots progressed WAITING revision 2 → CALLED 3 → SERVING
4 → COMPLETED 5. Call outcome was APPLIED and PostgreSQL also reported CALLED.
There were no uncaught browser errors; fixture cleanup and captured-log audit passed.
This mode seeds Auth accounts solely to avoid sending more confirmation emails;
it is not reported as a public-registration test.

The final real-registration retry returned HTTP 429 over_email_send_rate_limit.
Run npm run verify:phase8 after the development quota recovers, or after configuring
custom SMTP in Supabase Authentication email settings. Keep email confirmation
and anonymous sign-in settings enabled. This is the only remaining final sign-off
check; the fixture-mode pass does not replace it. No SMTP settings were changed.

For deterministic automation only, the test confirms its newly created disposable
Auth accounts in the development database after the real signup response. It does
not read the confirmation inbox or validate delivery/clicking the email link.
Ordinary users follow the Supabase confirmation email; no manual database work is
required for app onboarding. Disposable fixture accounts/businesses are cleaned.
The quota was allowed to recover once and real registrations succeeded again.
Subsequent retries exhausted it again; confirmation settings were not weakened.

## Phase 8 file inventory

Added:
- apps/api/src/config/production.ts
- apps/web/src/features/auth/register.tsx
- apps/web/src/components/public-queue-link.tsx
- packages/contracts/src/registration.ts
- supabase/migrations/20260923000100_business_profiles.sql
- tests/registration.test.ts
- tests/registration.integration.test.ts
- scripts/verify-phase8-browser.mjs
- scripts/verify-production-browser.mjs
- docs/manual-deployment.md
- docs/mvp.md
- docs/phase-8.md

Updated:
- apps/api/src/server.ts
- apps/api/src/modules/configuration/routes.ts
- apps/api/src/modules/configuration/repository.ts
- apps/web/src/app/router.tsx and apps/web/src/features/auth/login.tsx
- apps/web/src/features/configuration/business-pages.tsx
- apps/web/src/features/configuration/branch-pages.tsx
- apps/web/src/features/configuration/service-pages.tsx
- apps/web/src/features/configuration/staff-page.tsx
- apps/web/src/features/configuration/forms.tsx
- apps/web/src/features/customer/checkout-page.tsx
- packages/contracts/src/index.ts, schemas.ts and configuration.ts
- apps/api/.env.example and apps/web/.env.example
- supabase/config.toml
- scripts/migrate.mjs and scripts/test-database.mjs
- scripts/verify-phase2-browser.mjs and scripts/verify-phase4-browser.mjs
- package.json and README.md

The --fixture-accounts option is an explicit disposable development-test mode only;
it does not modify application Auth behavior or create permanent test accounts.

Runtime reports/screenshots are local ignored artifacts under .runtime, not source
or deployable credentials. Existing real .env values were not changed.

## Manual release and limitations

See [manual deployment](manual-deployment.md) for frontend Vercel, a Node backend
host, Supabase Auth redirects/email configuration, environment variables, build/
start commands, migration and health/public-queue smoke checks. See [MVP](mvp.md)
for architecture and future work. No deployment was performed.

Before public release, the developer must configure production URLs, reliable Auth
email delivery, host environment/TLS and execute the documented smoke checks.
Email inbox delivery is not verified by automated browser fixtures. Password reset,
account deletion and invitations have no MVP UI. Real payment provider not
integrated in MVP; use NONE services for production admissions until a provider is
implemented. WhatsApp remains a development mock. No QR generator, subscriptions,
appointments or notification worker were added. Phase 8 is the stopping point.
