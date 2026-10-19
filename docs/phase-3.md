# Phase 3 — staff queue engine

Qevra retains its modular monolith: React/Vite, Express, pg, Supabase Auth and the existing business → branch → service → session → ticket hierarchy.

## Architecture and concurrency

Express verifies the JWT, rejects anonymous staff actors, checks current membership/assignments, and executes every mutation in one PostgreSQL transaction. Queue authorization uses configuration read-scope checks so assigned STAFF can operate queues without gaining configuration-write permission.

Lock order: business (shared), actor/idempotency-key advisory lock where applicable, service (exclusive), session, request/ticket/counter. The service lock serializes one service across daily sessions. Other services can proceed independently. Configuration writes take an exclusive business lock, preventing changes to authorization/configuration during queue operations.

Number allocation increments queue_sessions.last_number and next_order under locks, never COUNT/MAX. Unique constraints protect service/date sessions, sequence/order, active customer/service tickets and active counter capacity. Ticket changes, join-request admission, event insertion, revision and idempotency response commit atomically.

Internal admission receives a transaction client and a trusted verified actor. It has no HTTP endpoint. STAFF admission checks assignments; CUSTOMER admission checks request ownership. SYSTEM actors are server-only and never accepted from request JSON.

## Migration

New applied migration: `supabase/migrations/20260919000200_queue_engine.sql`. The applied foundation migration was not edited.

- Adds READY for unpaid join requests, constrained to payment mode NONE.
- Adds session-level events and tenant/session/ticket foreign keys.
- Limits event metadata to 2 KB and indexes history.
- Adds queue_command_keys with RLS and no browser grants.
- Revokes event UPDATE/DELETE from browser roles and service_role.

`npm run db:migrate` applies only pending migrations and records their versions. Express only appends events; there is no event edit/delete API. The trusted PostgreSQL owner retains maintenance privileges for fixture cleanup. This is application-level append-only history, not a tamper-proof ledger against a database administrator.

## API

Base: `/api/v1/businesses/:businessId/branches/:branchId/services/:serviceId`.

| Method | Suffix | Body/query |
|---|---|---|
| GET | /queue | No body; never creates a session |
| POST | /queue/open | {} |
| POST | /queue/pause | sessionId, expectedRevision |
| POST | /queue/resume | sessionId, expectedRevision |
| POST | /queue/close | sessionId, expectedRevision |
| POST | /queue/call-next | counterId; optional sessionId |
| POST | /tickets/:ticketId/call | expectedVersion, counterId, optional reason |
| POST | /tickets/:ticketId/start | expectedVersion |
| POST | /tickets/:ticketId/complete | expectedVersion |
| POST | /tickets/:ticketId/skip | expectedVersion |
| POST | /tickets/:ticketId/no-show | expectedVersion |
| POST | /tickets/:ticketId/requeue | expectedVersion |
| POST | /tickets/:ticketId/cancel | expectedVersion |
| GET | /history | Optional businessDate, page (default 1), limit (default 30, max 100) |

All mutations require an `Idempotency-Key` UUID header. Keys are actor-scoped. A retry of the same parsed command returns its original result; changing service/action/ticket/body under that key returns 409. Authorization is rechecked before replay. Failed transactions do not retain keys.

Results contain outcome (APPLIED, UNCHANGED or EMPTY), sessionId, ticketId and revision. Empty call-next is successful with EMPTY and null ticketId. Invalid/inactive/busy counters still fail. Revision and queueOrder are decimal strings to preserve bigint precision; expectedVersion is an integer. Invalid/stale state returns 409, invalid input 400, inaccessible/mismatched scope generally 404.

Snapshots contain today's session/date/timezone, revision, generatedAt, waiting/called/serving/skipped, carryover, counters and counts. Staff sees names, not phones or customer Auth IDs. History exposes actor type, statuses, time and limited metadata; actor user IDs remain stored in the database.

## Lifecycle and numbering

Viewing never opens a queue. Open creates today's session using the branch timezone or returns the existing OPEN session. OPEN can pause/close; PAUSED can resume/close; CLOSED cannot reopen on that date.

New admission, call and requeue require active business/branch/service and today's OPEN session. During pause/closure, existing CALLED tickets may start/skip/no-show/cancel and SERVING may complete. WAITING may cancel. Previous-day active tickets are shown for finishing/cancelling; they cannot be newly called/requeued.

```text
WAITING -> CALLED or CANCELLED
CALLED  -> SERVING, SKIPPED, NO_SHOW or CANCELLED
SERVING -> COMPLETED
SKIPPED -> WAITING via requeue
```

Visible number = prefix_snapshot + sequence padded to at least 3 digits. Numbering resets per service/date. Configuration changes do not rename old tickets. Requeue keeps ID/sequence/number, assigns a new tail queue_order and records an event. Current-cycle call/skip timestamps reset; previous timestamps remain in event history.

Call-next picks earliest WAITING queue_order. Explicit counterId must be active, free and belong to the service. CALLED/SERVING occupy capacity; skip/no-show/cancel/complete release it. Manual calls record manual/outOfOrder flags and counter ID. Bypassing earlier waiting tickets requires a reason stored only in event metadata; avoid personal information in reasons.

Admission requires an eligible unexpired READY/NONE request. It checks current service payment mode too. All paid admissions fail closed in Phase 3; there is no client paid-state override. Repeating an admitted request returns the same ticket without another number/event.

## Authorization

| Role | Queue scope | Configuration |
|---|---|---|
| OWNER | All queues in own business | Existing owner permissions |
| MANAGER | Assigned branches | Existing assigned-branch permissions |
| STAFF | Assigned services within assigned branches | Read-only; cannot edit service/branch or manage members |
| Anonymous/non-member | None | None |

Inactive memberships immediately lose access. Existing Phase 2 inactive-business behavior remains: only owners can access them.

## Manual demo

1. Run `npm run dev`, log in, open a business, branch and service such as Haircut.
2. Ensure payment mode NONE and an active counter such as Stylist 1.
3. Select **Open queue** in the services list, then press **Open queue** on the dashboard.
4. Read businessId, branchId and serviceId from `/app/BUSINESS_ID/branches/BRANCH_ID/services/SERVICE_ID/queue`.
5. In `apps/api/.env`, configure TEST_STAFF_EMAIL and TEST_STAFF_PASSWORD for a confirmed development staff user with access to that service. Never put credentials in commands or chat.
6. In a second terminal at the repository root run:

```sh
npm run seed:queue -- --development BUSINESS_ID BRANCH_ID SERVICE_ID 5
```

Replace the three placeholders with your IDs. Count defaults to 5, maximum 20. The script rejects production mode, authenticates staff, checks access and OPEN status, and admits all demo tickets atomically. It creates marked synthetic anonymous development identities with no usable password/customer session. Do not target production. Demo tickets persist intentionally; repeating the command adds more.

7. Refresh, select Stylist 1, then **Call next → Start service → Complete**.
8. **Call next → Skip → Requeue**. Confirm the number stays the same and position moves to the tail.
9. Call a later waiting ticket with a reason; try No show or Cancel.
10. Try Pause/Resume. Close only when done; closure is final for that date. Finish/cancel demo work through normal controls; historical records remain.

The dashboard polls every 5 seconds and reloads after commands. An uncertain network result offers a retry with the same idempotency key. Page refresh reloads server state. This is staff polling, not customer Realtime.

## Verification

```sh
npm run check
npm run test:database
npm run test:database -- --queue
npm run verify:phase3
npm run audit:secrets
```

Live concurrency tests commit UUID-scoped synthetic fixtures, use independent PostgreSQL connections/transactions, and remove only those fixtures afterwards. They verify distinct connections, concurrent admission/open/call-next, same-counter races, duplicate replay, authorization, lifecycle and numbering. Other integration tests use rollback fixtures.

Browser verification uses real Supabase login, Express JWT verification and PostgreSQL; its fixture transaction rolls back. It uses ports 3103/5175 and installed Edge, leaving ordinary development servers alone. Checks cover open, call/start/complete, skip/requeue, manual reason/no-show, pause/resume, reload, cancel/close, mobile overflow, browser errors and credential-free logs. Sanitized reports/screenshots are in ignored `.runtime/`.

`npm test` explicitly skips live DB suites without TEST_DATABASE_URL. `npm run test:database` loads that setting privately from the API environment file.

## Files

Created:
- `packages/contracts/src/queue.ts`
- `apps/api/src/modules/queues/{context,idempotency,engine,admission,queries,routes}.ts`
- `apps/web/src/features/queues/queue-page.tsx`
- `supabase/migrations/20260919000200_queue_engine.sql`
- `scripts/{migrate,seed-queue,verify-phase3-browser}.mjs`
- `tests/queue.integration.test.ts`
- `docs/phase-3.md`

Updated:
- `packages/contracts/src/index.ts`
- `apps/api/src/app.ts`
- `apps/web/src/app/router.tsx`
- `apps/web/src/lib/configuration-api.ts`
- `apps/web/src/features/configuration/service-pages.tsx`
- `scripts/test-database.mjs`
- `package.json`
- `README.md`

## Limits

No customer join/dashboard, ETA, customer Realtime, payment/checkout, WhatsApp, worker, analytics, subscription, appointment or deployment. Paid admission is deliberately stricter than the future verified-payment API: always denied here. No automatic rollover, idempotency retention job or history retention job. History uses offset pagination; the dashboard shows the latest 20 events. The service mutex favors correctness over maximum same-service throughput.

No additional Supabase dashboard setting is required. Phase 4 must be requested separately.

## Verified result

Phase 3 is complete and verified against the configured Supabase development environment.

- TypeScript: passed for all workspaces.
- ESLint: passed.
- API/contracts: 20 passed; the three live suites intentionally skip in the offline command.
- Live PostgreSQL integration: 26 passed, 0 failed, 0 skipped, including Phase 2 regression and Phase 3 concurrency checks.
- Frontend/backend/contracts builds: passed. Vite reports two non-blocking annotation warnings from the Zod dependency.
- Browser: all 12 reported checks passed, including real staff Auth, queue lifecycle, reload persistence, mobile overflow, rollback cleanup and credential-free logs.
- Migration runner: foundation and queue-engine migrations both recorded as already applied; no pending migrations.
- Secret audit: both environment files ignored, neither tracked, zero credential matches in candidate project files. Browser logs independently checked in memory.

Database concurrency fixtures were cleaned up; browser fixtures rolled back. No production deployment or Phase 4 work was performed. No Supabase dashboard action remains for Phase 3.
