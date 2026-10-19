# Phase 7 — operational analytics

## Architecture and entry points

The existing modular monolith now exposes one consolidated, read-only
`GET /api/v1/businesses/:businessId/analytics` endpoint. React's
`/app/:businessId/analytics` route uses the staff Auth session and Express.
Only Express accesses PostgreSQL. No new analytics tables, workers, dependencies,
financial reports, provider integrations or deployment are introduced.

Query parameters (strictly validated): `range=TODAY|LAST_7_DAYS|LAST_30_DAYS`
(default TODAY), optional UUID `branchId`, optional UUID `serviceId`.
Unknown, repeated and malformed filters return 400. An inaccessible branch,
service, business or incompatible branch/service pair returns 404.

## Metrics and time semantics

All historical metrics refer to **tickets admitted in the selected business-date
cohort**, not all state changes that happened during those dates. Outcomes are the
current outcomes of those tickets at query time; later completion can therefore
change a previous cohort's result. Customers joined means tickets, not distinct
people: repeat visits are separate tickets. Unpaid join requests, failed payment
attempts and reconciliation without admission never enter analytics.

| Metric | Source and definition |
| --- | --- |
| Joined | One queue_tickets row per admitted ticket in selected queue_sessions.business_date |
| Completed / cancelled / no-show | Cohort tickets whose authoritative current status is COMPLETED / CANCELLED / NO_SHOW |
| Average wait | Original ticket joined_at to first TICKET_CALLED after the latest TICKET_REQUEUED, no later than SERVICE_STARTED if present |
| Average service | First SERVICE_STARTED after latest requeue to first following SERVICE_COMPLETED, only for currently COMPLETED tickets |
| Hourly volume | joined_at hour in the branch timezone, 00–23, across the selected cohort |
| Busiest hour | Maximum admitted count; ties choose the earliest numeric hour; null for no tickets |
| Live today | WAITING / CALLED / SERVING in today's OPEN or PAUSED sessions with active business, branch and service |

Last 7 / 30 Days include today and the preceding 6 / 29 calendar business dates.
Each branch uses its existing timezone and queue business_date. Multi-branch
results combine local dates and local hours, not one UTC day; the response and UI
show each branch's timezone and date window. Branch/service filters apply to both
history and Live today. Historical range never changes the live date. Inactive
entities remain available for historical reporting, but are excluded from live
counts. Closed sessions and yesterday's unresolved tickets are not live today.
Future admission/event timestamps are excluded using the transaction timestamp.

Lifecycle events are preferred. When no valid call event survives, called_at is an
authoritative fallback only for non-WAITING tickets, within admission/query time,
after the latest requeue and no later than service start. The engine clears this
field on requeue. serving_at is not used to reconstruct abandoned attempts. With no requeue, wait is admission to the
first call. With requeue, prior abandoned calls are ignored; wait still begins at
original admission and therefore includes the extra delay. A requeued WAITING
ticket with no new call has no wait sample. A skipped or no-show ticket with a
valid call does have a wait sample. Called-but-unserved tickets contribute wait
only. Missing, pre-admission, reversed or future event intervals are excluded.
Zero-minute valid intervals are included. No duration is inferred from completion
alone. Responses include valid sample counts and null for no samples; UI shows a
dash, not an invented zero. Outcomes can still count completed tickets with
incomplete duration history. Event types follow existing queue engine semantics.

## Authorization and consistency

Supabase verifies the bearer JWT. Anonymous users receive 403; STAFF receives 403.
Current membership and existing shared business lock protect authorization against
concurrent assignment changes. OWNER sees all branches in their business; MANAGER
sees only assigned branches. Both available filter metadata and metrics are scoped
server-side. Other tenants' IDs and customer identities are never returned.
Existing table RLS/grants remain unchanged. Responses have Cache-Control: no-store.

All metric aggregates use one PostgreSQL statement/snapshot. Authorization and
option lookups are a fixed number of queries, independent of ticket count.
No customer names, contact details, payment amounts or notifications are queried.

## SQL and indexes

CTEs select authorized services, admission cohorts and lifecycle events. Grouped
event stages find last requeue, first service start and matching call/completion;
SQL computes averages, counts, hourly volume, service/branch groups and live counts.
Only aggregated data reaches React. There are no per-ticket application queries.

New immutable migration: `20260922000200_analytics_indexes.sql`, adding
`queue_sessions_analytics_date_idx(business_id,business_date,branch_id,service_id)`.
Existing ticket(session,status,order) and event(ticket,occurred_at) indexes support
joins. No prior migration was changed. No summary cache is required at MVP scale.
Existing API pool timeouts bound the query.

## Dashboard and demo

Run `npm run dev`, sign in as OWNER (or assigned MANAGER), choose a business,
then select **Analytics**. Change Today / Last 7 Days / Last 30 Days, branch and
service. Summary cards show admission/outcome counts and duration samples. The
24-hour CSS bar chart includes readable numeric values and accessible labels.
Service and branch tables share the same filters. Live today is a separate section.
Refresh explicitly updates results; this page does not subscribe to Realtime.

Loading hides previous metrics; errors show a retry action; STAFF sees an access
notice; empty selections have an explanation and no fabricated chart. Tables
scroll within their panel on small screens. Browser verification uses temporary
real PostgreSQL history across two branches and multiple services, with real
Supabase staff login. It removes its fixtures afterwards; no fake numbers are
embedded in the dashboard and no permanent demo data is added.

## Verification commands

- `npm run db:migrate`
- `npm run check`
- `npm run test:database` (includes all Phase 2–7 integration suites)
- `npm run test:database -- --analytics` (focused analytics suite)
- `npm run verify:phase7`
- `npm run audit:secrets`

Integration cases cover cohort metrics, exact duration samples, invalid lifecycle,
requeue, skip, waiting/called, date windows, filters, empty data, live separation,
manager scope, staff/anonymous denial, cross-tenant denial and malformed queries.
The isolated fixture deliberately includes an invalid service chronology to verify
exclusion. Browser checks compare stored fixture values with summary cards,
hour buckets, service/branch tables, date and branch filters, empty/error states,
role revocation, and tablet/mobile overflow. Existing regression suites remain
part of the release checks.

## Limitations and scaling

No custom dates, distinct-person counts, export, percentages, financial analytics,
notification analytics, forecasts or background refresh. Large businesses may
eventually require profiling with EXPLAIN ANALYZE, narrower event indexes or
partitioning, and only then a consciously designed aggregate cache. Current
maximum historical window is 30 days; configured SQL timeouts still apply.
Timezone edits apply current branch timezone to existing admission timestamps;
historical timezone versions are not stored. Damaged/missing events reduce samples
rather than silently inventing durations. No Phase 8 or production deployment.

## Phase 7 file inventory

New files:
- packages/contracts/src/analytics.ts
- apps/api/src/modules/analytics/routes.ts
- apps/api/src/modules/analytics/service.ts
- apps/web/src/features/analytics/analytics-page.tsx
- supabase/migrations/20260922000200_analytics_indexes.sql
- tests/analytics.integration.test.ts
- tests/helpers/analytics-fixture.ts
- scripts/verify-phase7-browser.mjs
- docs/phase-7.md

Updated files:
- packages/contracts/src/index.ts (exports)
- apps/api/src/app.ts (router registration)
- apps/web/src/app/router.tsx (dashboard route)
- apps/web/src/components/layouts.tsx (role-scoped navigation)
- package.json (verification command)
- scripts/test-database.mjs (analytics suite)
- scripts/verify-phase4-browser.mjs (sanitized failure diagnostics)
- scripts/verify-phase6-browser.mjs (background timer settings and safe Auth diagnostics)
- README.md (scope and usage)

## Verification record — 22–23 September 2026

The analytics index migration was applied successfully to the configured Supabase
development database; all earlier migrations were already applied and unchanged.
TypeScript, ESLint, 29 offline tests and both production builds passed.
The complete database regression run passed 74 tests with no skips/failures.
After adding the remaining analytics edge cases and authoritative timestamp
fallback, the focused analytics suite passed all 13 tests. The full run's count
therefore predates these three additional checks; it is not presented as 77 tests
in one run.

The Phase 4 browser regression passed all 20 checks; Phase 5 passed all 14.
The final isolated Phase 6 browser run passed all 14 boolean checks, with no Auth
errors. Its three NOT_FOUND diagnostics are expected cross-customer denials, not
database failures. Earlier interrupted/timed-out browser attempts were rerun;
only the final successful results are used for completion.
The final Phase 7 browser dashboard passed all 13 checks after the timestamp
fallback and UI adjustment. Fixtures are scoped to random UUIDs and removed;
real development staff identity is retained.

The credential audit found both .env files ignored, no environment files tracked,
no credential matches in 131 candidate source files, no credentials in application
logs, and no private credentials in four frontend assets. Existing Zod/Rollup
annotation warnings are non-blocking. No deployment or Phase 8 work was performed.

Phase 7 is complete. Work stops here; no Phase 8 or deployment was started.
