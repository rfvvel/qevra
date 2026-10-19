# Phase 4 — customer queue experience

Phase 4 connects the public branch catalog to the existing transactional queue engine for payment_mode NONE only. It retains React/Vite, Express, pg, Supabase Auth and the approved tenancy structure.

## Customer flow and identity

`/q/:branchSlug` → choose service → `/q/:branchSlug/services/:serviceId/join` → name and optional phone → `/ticket/:ticketId`.

Browsing does not create an anonymous user. Beginning a join silently ensures an anonymous Supabase identity. A dedicated, persistent customer Auth storage key keeps customer identity separate from staff login on the same browser. An existing anonymous foundation identity is reused when available. An in-flight promise and browser Web Lock prevent unnecessary simultaneous account creation across tabs.

No login, signup, password or authentication terminology is shown in the customer flow. Opening an existing ticket does not create a replacement identity when access is lost. Clearing browser storage or using another device cannot recover ownership in Phase 4.

Ticket references alone are stored in localStorage (maximum ten). Shortcuts are checked against Express before display, and terminal references are removed. References are never authorization; the exact URL still works without them if the same anonymous identity remains. Active-ticket lookup and join both return the customer's existing WAITING/CALLED/SERVING ticket for that service.

## APIs

| Method | Endpoint | Input / behavior |
|---|---|---|
| GET | /api/v1/public/branches/:slug | Active public catalog, payment mode and today's OPEN/PAUSED/CLOSED/NOT_OPENED status; no names, phones or queue numbers |
| POST | /api/v1/customer/join-requests | branchSlug, serviceId, customerName, optional phone; Idempotency-Key UUID header |
| GET | /api/v1/customer/active-ticket?serviceId=UUID | Own active ticket or null |
| GET | /api/v1/customer/tickets/:ticketId | Owner-only ticket, location/service labels, peopleAhead, ETA, handled numbers, revision and timestamps |
| POST | /api/v1/customer/tickets/:ticketId/cancel | expectedVersion and Idempotency-Key UUID header; own WAITING only |

All customer endpoints verify the Supabase JWT through the existing Express middleware and require an anonymous customer. Every ticket read/cancel filters by customer_auth_id; wrong owner and missing ticket share a 404 response. UUIDs and visible numbers are not credentials. Anonymous customers remain blocked from staff endpoints.

Join input is strict; price, payment mode, prefix and identity overrides are rejected. PostgreSQL supplies all authoritative configuration. Optional phone input removes familiar separators, normalizes Indonesian 08/62 prefixes to +62, and validates E.164 shape (8–15 digits). This is syntax normalization, not verification that a number exists. No WhatsApp opt-in or delivery is implied. Phones stay in join_requests and never enter snapshots, broadcasts or application logs.

## Atomic admission and cancellation

Customer join uses the existing business/service/session locks and actor-scoped idempotency infrastructure. In one transaction it checks eligibility, creates READY join_request, calls the Phase 3 admitJoinRequest service, stores the result and commits. It never opens sessions or duplicates ticket allocation logic.

Business/branch/service must be active, payment mode NONE, and today's branch-timezone session OPEN. Not opened, paused, closed and inactive states have clear customer messages. DEPOSIT/FULL services remain listed with the online-payment-unavailable message and cannot create tickets. Existing active tickets are returned even if new admission is now unavailable.

A retry with the same actor/key/body returns the original ticket. A new key from the same active customer/service returns the existing active ticket. Reusing a key with different input returns conflict. A failed join leaves no partial join request, number or event.

Cancellation requires UI confirmation, ownership, WAITING status and the expected version. It calls the existing transition engine, records cancelled_at and a CUSTOMER audit event, increments revision and commits atomically. CALLED and later cancellation stay staff-controlled. Uncertain network results retain their idempotency key for safe retry.

## peopleAhead and ETA

Express counts WAITING tickets in the same session with queue_order lower than the owner's current queue_order. CALLED/SERVING are excluded and shown separately as currently handled queue numbers. No full queue, other names, phones or staff records are downloaded to the customer.

CounterEtaCalculator implements the replaceable EtaCalculator interface:

1. Use only active counters for the service.
2. A free counter has availability 0 minutes.
3. CALLED reserves one estimated service duration.
4. SERVING uses estimated duration minus elapsed serving_at time; overdue service reserves a one-minute uncertainty buffer. A missing start time reserves a full duration.
5. Assign each waiting predecessor to the earliest available counter, adding one estimated duration.
6. The owner's estimate is the earliest resulting availability, rounded up to a whole minute.

Returns peopleAhead, estimatedWaitMinutes, etaStatus and calculatedAt. Without active capacity, an open current session, or active parent configuration, no numeric estimate is returned. Non-WAITING statuses also have no estimate. Previous-day sessions do not admit/call/requeue new work, consistent with Phase 3. The UI presents approximate wait language, never an appointment guarantee.

## Private Realtime

New migration: `supabase/migrations/20260920000100_customer_realtime.sql`. Previously applied migrations were not modified.

- Adds a customer/session lookup index.
- Adds a narrow SECURITY DEFINER ownership predicate with an empty search_path.
- Adds a SELECT-only policy on realtime.messages for private queue topics owned through a ticket; requires an anonymous JWT.
- Adds an after-revision-update trigger calling realtime.send with private=true.
- Invalidates revisions when business/branch/service/counter configuration changes.

The private topic is `queue:<sessionId>`. The payload contains only revision and generatedAt. Customers can receive a topic only if they own a ticket in that session; no client send policy is granted. Business tables remain inaccessible to browser roles. The SQL predicate is narrowly for Realtime authorization, not business-data querying.

Signal insertion shares the mutation transaction, so rollback emits no committed update. After commit, the browser receives queue_changed and refetches its owner-authorized Express snapshot. Other unresolved sessions of the same service are also signaled because counters can be occupied across dates. Terminal-ticket owners retain session topic permission, but signals carry no customer data.

This follows Supabase's [private channel authorization](https://supabase.com/docs/guides/realtime/authorization) and [database Broadcast](https://supabase.com/docs/guides/realtime/broadcast) mechanisms. No full-row Postgres Changes publication, service-role browser key, notification worker or customer PII broadcast is used.

## Recovery and stale responses

The ticket page fetches REST initially, on each broadcast, on subscription/reconnection, when the tab becomes visible and when the browser comes online. Background refresh is 20 seconds while disconnected and 60 seconds while connected (also refreshes time-dependent ETA); hidden tabs do not poll.

Refreshes are serialized/coalesced. Lower-revision or older generatedAt responses cannot overwrite current data. Component cleanup aborts requests and removes its channel. Authentication/ownership failure hides the snapshot and stops automatic polling rather than silently replacing the customer's identity.

## Manual demo

1. Run `npm run dev`.
2. Staff: log in, choose business → branch → Haircut. Ensure payment_mode NONE and an active counter. Open today's queue.
3. Customer A: open `/q/BRANCH_SLUG`, choose Haircut, enter a name, leave phone blank if desired, then Join queue. A fresh daily queue returns H001.
4. Customer B: use another browser/profile or a separate private browsing context, not just another tab sharing the same identity. Join the same service and receive H002.
5. Check B shows one waiting person ahead. Its estimate accounts for active counter capacity.
6. Staff: choose a counter and Call next. A automatically shows CALLED; B's waiting peopleAhead becomes zero.
7. Staff: Start service then Complete. A automatically shows SERVING then COMPLETED.
8. Refresh B or reopen its exact ticket URL. The same ticket remains accessible. Returning to Qevra also offers an owner-verified shortcut.
9. On a WAITING ticket choose Leave queue. Keep my place cancels the dialog; Yes, leave queue performs cancellation.
10. Test Pause, Close and no active counters; there must be no fabricated numeric ETA. DEPOSIT/FULL remain visible but unavailable for online joining.

No real QR generation is needed; the stable `/q/:branchSlug` URL can later be encoded. No additional Supabase dashboard setting was needed for the tested private Broadcast setup.

## Verification commands

```sh
npm run check
npm run test:database
npm run test:database -- --customer
npm run verify:phase4
npm run audit:secrets
npm run db:migrate
```

The API environment supplies private development credentials. Browser verification uses TEST_STAFF_EMAIL/TEST_STAFF_PASSWORD, real Supabase anonymous users and real JWT checks. It commits UUID-scoped fixtures so Realtime delivery is genuine, then removes only its captured fixture records/anonymous identities. Existing staff identities remain. Ports 3104/5176 isolate it from the normal development server; installed Edge is used headlessly.

Database tests verify admission eligibility, paid rejection, strict input, duplicate submissions, phone privacy, customer and tenant boundaries, ETA/counters, cancellation, and Realtime ownership. Phase 3 concurrency and Phase 2 regression suites remain enabled. Browser checks cover two customers, hidden authentication, persistent identity, exact URLs, restored shortcuts, private channel denial, committed Realtime updates, polling/visibility recovery and confirmation. Sanitized reports/screenshots are written to ignored `.runtime/`.

## Files

Created:
- `packages/contracts/src/customer.ts`
- `apps/api/src/modules/customer/{eta,service,routes}.ts`
- `apps/web/src/lib/customer-api.ts`
- `apps/web/src/features/customer/{layout,shortcut,join-page,ticket-page}.tsx`
- `apps/web/src/features/customer/use-ticket.ts`
- `supabase/migrations/20260920000100_customer_realtime.sql`
- `tests/customer.test.ts` and `tests/customer.integration.test.ts`
- `scripts/verify-phase4-browser.mjs`
- `docs/phase-4.md`

Updated:
- `packages/contracts/src/index.ts` and `packages/contracts/src/configuration.ts`
- `apps/api/src/app.ts` and `apps/api/src/modules/configuration/routes.ts`
- `apps/web/src/app/router.tsx`
- `apps/web/src/lib/supabase.ts` and `apps/web/src/lib/auth.ts`
- `apps/web/src/features/public/branch-page.tsx`
- `apps/web/src/dev/runtime-verification.tsx`
- `scripts/test-database.mjs` and `package.json`
- `README.md` and `docs/architecture.md`

## Known limitations / scope

ETA uses configured averages and a simple overdue buffer; it does not predict actual appointment times. Closed/previous-day waiting tickets need staff handling or customer cancellation. Realtime authorization is checked on subscription; only minimal invalidations are sent and every REST refetch rechecks identity/ownership. Idempotency/history retention and production-scale fanout tuning remain future work.

No paid admission, checkout, Midtrans, WhatsApp, worker, web push, appointments, analytics, subscriptions, customer accounts, cross-device recovery or production deployment. Anonymous identity requires the original browser's persisted credentials. No Phase 5 work is included.

## Verified completion

Phase 4 is complete against the configured Supabase development project.

| Check | Result |
|---|---|
| TypeScript and ESLint | Passed |
| API/contracts/ETA tests | 24 passed; 4 live suites intentionally skipped by offline command |
| Full live database regression run | 36 passed, 0 failures, 0 skips |
| Latest customer suite, including the additional cross-business case | 11 passed, 0 failures, 0 skips |
| Frontend/backend/contracts builds | Passed |
| Real browser E2E | All 20 reported checks passed |
| Migration runner | All three migration versions recorded; no pending migration |
| Credential audit | Both .env files ignored/untracked; zero credential matches across 103 candidate files |

The browser run verified actual committed Broadcast frames and customer UI changes, not only polling. It also checked private-channel denial, fallback polling, visibility refetch, restored connections, persistence, cancellation, mobile overflow and absence of uncaught browser errors. Browser logs were checked in memory for credentials. Fixtures and newly created anonymous test identities were cleaned up.

Vite emitted two non-blocking annotation warnings from the existing Zod dependency. No build errors remain. No manual Supabase dashboard action is required. No Phase 5 or deployment work was performed.
