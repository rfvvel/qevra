# Qevra

Qevra is a multi-tenant virtual queue platform with staff configuration, queue operations, anonymous customer tickets, private Realtime updates, development mock payments for NONE, DEPOSIT and FULL services, and customer queue updates with simulated WhatsApp.

## Architecture

- `apps/web`: React, Vite, TypeScript, Tailwind CSS and React Router.
- `apps/api`: Node.js, Express, TypeScript and `pg`; all business data passes here.
- `packages/contracts`: shared enums, DTOs and Zod schemas.
- `supabase`: Auth/Realtime configuration and SQL migrations, without an ORM.
- `docs`: architecture and deliberate future boundaries.
- `tests`: API/auth middleware and schema integrity verification.

This is a modular monolith in an npm workspace. PostgreSQL is hosted by Supabase.
Customers receive invisible anonymous Auth sessions; only business users
see a login UI. Business users can register, confirm their email, sign in and onboard a business.
Owners add registered team members by exact email.

## Requirements

Node.js 22.12+ (Node 24 LTS recommended), npm, and Git. Docker and the Supabase CLI
are optional until you want to run the database/Auth stack locally. No credentials
are needed to build or call the liveness endpoint. Dashboard and public catalog
data require the configured development Supabase project.

## Install and run

From the repository root:

```sh
npm install
npm run dev
```

Web: http://localhost:5173. API: http://localhost:3001/api/v1/health.
Vite proxies `/api` to port 3001. Run separately in two terminals if preferred:

```sh
npm run dev:web
npm run dev:api
```

The combined development script watches contracts too. When running individual
scripts, restart them after changing shared contracts to rebuild those contracts.

Open `/login` for staff authentication and `/app` for the protected dashboard.
Business creation starts at `/app/onboarding`. Branches, services, counters and
staff assignments live under `/app/:businessId`. The public `/q/:branchSlug` route
shows active services and starts anonymous customer joining or mock checkout.
The health endpoint is a liveness check, not a database or Auth readiness check:

```json
{"status":"ok","service":"qevra-api"}
```

## Environment

Copy `apps/web/.env.example` to `apps/web/.env` and `apps/api/.env.example` to
`apps/api/.env` when configuring Supabase. npm workspace scripts run from their
workspace, so the API reads its own `.env`. Real `.env` files are ignored by Git.

| Location | Variable | Purpose |
| --- | --- | --- |
| Web | `VITE_API_URL` | `/api/v1` by default; absolute API URL for separate hosting later |
| Web | `VITE_SUPABASE_URL` | Project URL, required only for Auth features |
| Web | `VITE_SUPABASE_PUBLISHABLE_KEY` | Public publishable key or legacy anon key |
| API | `NODE_ENV` | development/test/production; production disables mock payments |
| API | `MOCK_WHATSAPP_ENABLED` | true enables development-only simulated WhatsApp; false by default |
| API | `PAYMENT_PROVIDER` | MOCK for development simulation, DISABLED by default |
| API | `PORT` | Defaults to 3001 |
| API | `WEB_ORIGIN` | Allowed browser origin; defaults to http://localhost:5173 |
| API | `SUPABASE_URL` | Same Supabase project URL |
| API | `SUPABASE_PUBLISHABLE_KEY` | Public key used for server-side token verification |
| API | `DATABASE_URL` | Server-only PostgreSQL connection string |

Every `VITE_` variable is public. Never put a database password, service-role key
or provider secret there. No service-role API key is required. For a hosted
database use the project connection settings with certificate-verified TLS
(`sslmode=verify-full`); do not disable certificate validation. URL-encode passwords.
If you change API PORT, also update the Vite proxy target.

## Supabase setup

### Local (optional)

With Docker running and the Supabase CLI installed, execute from the root:

```sh
supabase start
supabase migration up
supabase status
```

Use the local URL, public key and database URL printed by the CLI in the two `.env`
files. `supabase/config.toml` enables anonymous sign-in for local development.
The local database defaults to port 54322. No sample users or secrets are seeded.
To run the integration test against a disposable local database on PowerShell:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
npm test
```

Database tests use isolated fixtures, either rolled back or explicitly cleaned up.
Apply migrations first. Do not use a production database for tests.

### Hosted development project

Create a Supabase project, then link and apply migrations using the CLI:

```sh
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

These commands modify the selected project; confirm that it is your development
project. In Auth settings enable anonymous sign-ins, configure the local site URL,
and retain email/password auth for staff. Enable abuse protection before exposing
anonymous sign-in publicly. Local config does not configure hosted Auth settings.

The migration creates profiles, businesses, business members, branches, services,
branch members, staff service assignments, counters, queue sessions, join requests,
tickets and events. Browser table access is denied and RLS is enabled. Express uses
server-only PostgreSQL credentials; application middleware is responsible for
membership and role checks. No actor-context RLS is implemented.

No automatic profile trigger is installed. Business creation and adding an existing
staff user create profiles explicitly and atomically. Anonymous customers do not
need a profile.
Private Supabase Realtime channels broadcast queue revisions; authorized customers
fetch their own ticket snapshots from Express. Apply all migrations for these policies.

## Quality commands

```sh
npm run typecheck
npm run lint
npm test
npm run build
# Or all four:
npm run check
```

Build output: `apps/web/dist`, `apps/api/dist`, `packages/contracts/dist`.
Run the built backend with `npm run start -w @qevra/api`.
`npm run preview -w @qevra/web` previews the static frontend; its API URL must point
to a running backend for dashboard and catalog requests. Database integration tests skip
explicitly if `TEST_DATABASE_URL` is absent; this does not validate a migration.

## Scope

No real payment gateways, refunds, notification worker,
real WhatsApp, QR generation, financial analytics, subscription billing or production deployment.
See [architecture](docs/architecture.md) for provider boundaries and future phases.

## Phase 1.5 runtime integration

The real development database migration has been applied and its history recorded.
For safe health endpoints, TLS configuration, real database tests and isolated
browser/Auth verification, see [runtime verification](docs/runtime-verification.md).
The development-only verification route is /__verify; it is absent from production.

Optional local staff test settings (API .env only): TEST_STAFF_EMAIL and
TEST_STAFF_PASSWORD. Never commit these values or prefix them with VITE_.

## Phase 2 business configuration

See [Phase 2 documentation](docs/phase-2.md) for the complete endpoint inventory,
authorization matrix, dashboard routes, testing procedures and manual demo.
Phase 2 reuses the foundation schema; no additional migration is required.

## Phase 3 staff queue operations

The core queue engine and staff dashboard are implemented. See [Phase 3 documentation](docs/phase-3.md) for lifecycle rules, endpoints, authorization, concurrency, migrations, tests and the manual demo.

Apply pending development migrations with `npm run db:migrate`. Run `npm run dev`; open a queue from the services list. After opening a service using payment mode NONE, populate demo tickets with `npm run seed:queue -- --development BUSINESS_ID BRANCH_ID SERVICE_ID 5`.

Run `npm run test:database` for live integration/concurrency checks and `npm run verify:phase3` for the staff browser flow. The Phase 4 customer experience is documented below.

## Phase 4 customer queues

The public branch catalog now supports customer joining for payment mode NONE, owner-only tickets, people ahead, counter-aware ETA, private Supabase Realtime and confirmed cancellation while WAITING. See [Phase 4 documentation](docs/phase-4.md) for APIs, security, migration, files and the two-customer demo.

Run `npm run db:migrate` for pending development migrations and `npm run verify:phase4` for real customer/staff browser verification. NONE joining and Realtime remain covered by regression tests.

## Phase 5 development mock payments

DEPOSIT and FULL now require a verified mock payment before admission. Checkout keeps price snapshots, payment attempt history and explicit reconciliation when a PAID request cannot receive a ticket. No real money moves.

Set `NODE_ENV=development` and `PAYMENT_PROVIDER=MOCK` in the API environment, apply pending migrations with `npm run db:migrate`, and run `npm run dev`. Run `npm run verify:phase5` for the real browser flow. See [Phase 5 documentation](docs/phase-5.md) for APIs, transaction guarantees, security, limitations and the manual demo. Production disables mock controls/endpoints.

## Phase 6 customer alerts

Ticket pages now show persisted in-app Updates. Queue events generate joined, near-turn, called, started, completed, cancelled, skipped and no-show messages with database-backed deduplication. Optional WhatsApp consent supports a masked development simulation only. Notification failures are isolated from queue operations.

Set `MOCK_WHATSAPP_ENABLED=true` in the development API environment, apply pending migrations, and run `npm run dev`. Run `npm run verify:phase6` for the five-customer browser demo. See [Phase 6 documentation](docs/phase-6.md) for architecture, APIs, failure isolation, consent, security, tests and limitations. No real WhatsApp or notification worker is implemented.

## Phase 7: operational analytics

Owners and assigned managers can open Analytics under their business workspace
(`/app/:businessId/analytics`). It derives queue metrics from PostgreSQL, supports
Today / Last 7 Days / Last 30 Days and branch/service filters, and separates live
queues from historical performance. See [Phase 7 documentation](docs/phase-7.md)
for definitions, authorization, requeue treatment and verification.
Run `npm run db:migrate` for the supporting index and `npm run verify:phase7`
for the isolated browser demo. No additional environment variables are required.

## Final MVP / Phase 8

Start at /register for business accounts, then /login and /app. Customers continue
using anonymous sessions through the public branch URL. Team management uses
registered email addresses, and branch pages include Copy Link/Open Public Page.

See [MVP guide](docs/mvp.md), [Phase 8 changes and verification](docs/phase-8.md),
and [manual deployment guide](docs/manual-deployment.md). No deployment is performed.
Real payment provider not integrated in MVP. Real WhatsApp is available as the optional post-MVP integration below.

Run `npm run verify:phase8` for the complete development browser scenario. It uses
aliases of the configured test inbox for two real Supabase registrations, simulates
email confirmation only inside the test fixture, and removes its test data.

## Post-MVP: Meta WhatsApp queue reminders

An optional Meta Cloud API provider now supports consented near-turn and called-ticket
templates through a durable PostgreSQL outbox and separate worker. IN_APP updates,
development mock WhatsApp and mock payments remain. The Phase 6 description above
records the original MVP scope; real sending requires explicit META configuration.

See [setup, templates, webhook, worker and smoke-test guide](docs/whatsapp-cloud-api.md).
New migration: `supabase/migrations/20261019000100_whatsapp_outbox.sql` (not applied
during implementation). Run `npm run test:whatsapp` for mocked transport tests and
`npm run test:whatsapp:database` only with a separate migrated TEST_DATABASE_URL.
The database suite and live Meta smoke remain pending; nothing has been deployed.

## Development/demo: Twilio WhatsApp Sandbox

Explicit `WHATSAPP_PROVIDER=TWILIO` adds Sandbox delivery through the same outbox.
Recipients must enroll and send an inbound WhatsApp message; QR scans/checkbox
consent do not open the 24-hour free-form window. Production requires the explicit TWILIO_HOSTED_DEMO_ENABLED exception. See [Twilio setup and one-recipient smoke test](docs/twilio-sandbox.md).
`npm run test:whatsapp` runs mocked Meta and Twilio tests with no database/live sends.
The additional migration is prepared only; no hosted migration or delivery was run.

Hosted Railway API/worker + Vercel instructions: [hosted demo guide](docs/hosted-demo.md). Public queues have no recipient allowlist or demo participant cap.
