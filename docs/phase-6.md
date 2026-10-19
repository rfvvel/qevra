# Phase 6 — customer queue alerts

Phase 6 adds persisted in-app updates and development-only simulated WhatsApp.
It preserves the Phase 1–5 architecture, queue engine, anonymous customer sessions,
payment-before-admission guarantee, reconciliation and private Realtime.

## Architecture

The existing queue engine records a queue domain event, invokes NotificationService
with that event and its locked service/session context, then increments the queue
revision. NotificationService selects recipients, creates deduplicated notification
intents, invokes NotificationProvider, and records delivery results and audit events.

Providers:
- InAppNotificationProvider makes a persisted update available to its customer.
- MockWhatsAppProvider simulates delivery locally with a masked recipient.
- A future WhatsAppProvider can implement the provider contract; none is included.

Neither current provider makes a network request. Queue transition/numbering logic
remains in the queue engine. Channel selection, consent, message composition and
the near-turn rule belong to NotificationService.

## Migration and persistence

New migration: `supabase/migrations/20260922000100_notifications.sql`.
No previously applied migration was modified.

- notifications: tenant, ticket owner, source queue event, channel, type, status,
  title/message, dedupe key, masked recipient, failure code, sent/read timestamps.
- notification_events: delivery status or generation failure with the source queue
  event and optional notification reference. No raw provider payloads or phone numbers.
- Enums: notification_channel, notification_status, notification_type.
- Added composite identities to queue_tickets/queue_events for foreign keys.
- Reuses the existing join_requests.whatsapp_opt_in_at consent timestamp and its
  existing constraint that consent requires a phone; no duplicate consent column.

Composite foreign keys enforce tenant and ticket ownership integrity. Channels are
IN_APP and MOCK_WHATSAPP; statuses are PENDING, SENT, FAILED and SKIPPED. RLS is
enabled and all browser-role table access is revoked. Express remains the boundary.

Deleting a source event or ticket cascades its notification records, consistent
with development fixture cleanup; no deletion endpoint or retention job is added.

## Types, triggers and deduplication

| Queue event / condition | Notification |
| --- | --- |
| TICKET_ADMITTED | QUEUE_JOINED |
| WAITING with peopleAhead <= 3 | NEAR_TURN |
| TICKET_CALLED | YOUR_TURN |
| SERVICE_STARTED | SERVICE_STARTED |
| SERVICE_COMPLETED | SERVICE_COMPLETED |
| TICKET_CANCELLED | QUEUE_CANCELLED |
| TICKET_SKIPPED | QUEUE_SKIPPED |
| TICKET_NO_SHOW | QUEUE_NO_SHOW |

A threshold of 3 is an exported constant, ready for future business configuration.
After a queue event, the first four WAITING tickets in the current OPEN session are
considered. Inactive businesses/branches/services and paused/closed sessions do not
produce near-turn alerts. Opening/resuming a queue also evaluates waiting tickets.

The existing peopleAhead definition counts WAITING predecessors, excluding CALLED
and SERVING. Therefore E moves from four to three ahead when A is called, before A
finishes. This preserves the Phase 4 meaning and gives the alert earlier than the
illustrative completion-based demo. It is still three after A completes.

Tickets already within the threshold on admission receive NEAR_TURN immediately.
For zero ahead, copy says the customer is next in the waiting queue; it does not
claim a free counter or replace the actual YOUR_TURN call.

Unique(channel, dedupe_key) makes dedupe durable. QUEUE_JOINED, NEAR_TURN and
SERVICE_COMPLETED use ticket ID + type. Other transition alerts also include the
persisted event ID: replay is suppressed, while a new call after skip/requeue gives
a new YOUR_TURN notification. Failed attempts retain their dedupe key.

Polling, reconnect, ticket GET and read-state requests never generate notifications.
Queue command idempotency remains unchanged. Notification inserts use ON CONFLICT
DO NOTHING, so handling the same event again cannot add duplicates.

## Failure isolation

The queue mutation and domain event are the primary transaction. Notification
generation runs inside a savepoint before the revision signal:

1. A provider exception becomes FAILED with the safe code PROVIDER_ERROR.
   Other deliveries, including in-app, can still succeed.
2. A notification persistence failure rolls back only to that savepoint. A
   GENERATION_FAILED audit entry is then attempted separately.
3. If even the audit cannot be stored, only a constant sanitized warning is logged.
   The primary operation still proceeds while the database transaction remains usable.

No exception details, full phones, tokens or provider credentials are logged.
Integration tests inject both a thrown provider error and invalid delivery data
that causes a PostgreSQL constraint failure; queue admission/calling still succeeds.

A complete database connection/commit failure cannot be isolated by a savepoint.
There is no background worker, automatic delivery retry or recovery scheduler in
this phase. FAILED and generation failure records remain available for future
recovery tooling. SENT on MOCK_WHATSAPP means simulated success only.

## Consent and phone normalization

The join form has an optional phone and an unchecked WhatsApp checkbox. Emptying
the phone clears/disables consent. Express validates consent as well, so a modified
client cannot opt in without a supported number.

081234567890, 6281234567890 and +6281234567890 normalize to +6281234567890.
Spaces, parentheses, dots and hyphens are stripped by the existing normalizer.
WhatsApp consent requires an Indonesian mobile pattern: +628 followed by 7–11
digits. This is basic format validation, not number ownership, carrier verification,
an OTP flow or comprehensive international validation. International numbers may
still be stored as optional contact data without WhatsApp consent.

The normalized phone and explicit consent timestamp are captured on the join request
for NONE, DEPOSIT and FULL. Paid checkout retries preserve that same request data.
No consent is inferred from merely entering a phone. A customer-facing preference
editor/revocation flow is outside this phase; no real messages are sent.

## Payments and admission

NONE receives QUEUE_JOINED only once its ticket is created.
DEPOSIT/FULL pending, failed and expired payment attempts produce no queue alerts.
Successful paid admission uses the same engine event and notification path as NONE.
A PAID request in RECONCILIATION_REQUIRED has no ticket and receives no QUEUE_JOINED.
Notification failures cannot turn a successful paid admission into reconciliation.

## Customer UI and Realtime

The ticket page adds a lightweight Updates list with title, message, local time,
New badge and individual Mark as read action. It shows the latest 50 SENT in-app
updates, newest first. Read state persists server-side and repeated reads are safe.

No historical notification backfill is performed. Existing tickets may receive near-turn alerts on subsequent queue events.

No new Realtime channel is introduced. Notification writes finish before the
existing queue revision changes. Supabase broadcasts an invalidation after commit,
then the customer refetches their authorized ticket snapshot from Express.
Marking an update read also increments that session revision, allowing other tabs
to refresh. Existing reconnect, visibility and polling fallback remain in place.

Development ticket pages offer Inspect mock WhatsApp. The panel clearly says
MOCK WHATSAPP and no real message was sent. It lists at most 50 own simulated
messages, delivery status and recipient such as +62*******7890. Full phone numbers
are never returned in the ticket snapshot, public catalog or inspection response.

## API and security

| Method | Path | Behavior |
| --- | --- | --- |
| GET | /api/v1/customer/tickets/:ticketId | Existing snapshot, now with notifications and mock availability |
| POST | /api/v1/customer/notifications/:notificationId/read | Own SENT in-app notification; strict empty body |
| GET | /api/v1/customer/tickets/:ticketId/mock-whatsapp | Own mock messages, development only |

All require the existing verified anonymous Supabase JWT. Ownership mismatches return
404; permanent staff identities are rejected by the customer boundary. Staff do not
receive arbitrary notification-reading endpoints. Cross-business ownership cannot
be forged because of composite foreign keys. Mutation of a read timestamp does not
need a separate idempotency key: repeated requests keep the original timestamp.

NODE_ENV=production returns 404 for mock inspection before authentication, even if
MOCK_WHATSAPP_ENABLED=true. The provider refuses production delivery, no mock intents
are generated, and the Vite production build excludes the inspection controls.
In-app notifications remain functional in production mode.

## Configuration and manual demo

Existing real environment files remain private. For local simulation, API .env:

```dotenv
NODE_ENV=development
PAYMENT_PROVIDER=MOCK
MOCK_WHATSAPP_ENABLED=true
```

The mock WhatsApp flag defaults to false. No WhatsApp credentials are needed.

1. Apply pending development migrations with `npm run db:migrate`; run `npm run dev`.
2. Sign in as staff, configure an active NONE service with one counter and open it.
3. In five separate browser profiles/sessions, join customers A through E.
   For E, enter an Indonesian mobile number and explicitly enable WhatsApp updates.
4. E initially has four people ahead and a QUEUE_JOINED update, without NEAR_TURN.
5. Call A: E sees three ahead and one NEAR_TURN. Start and complete A.
6. Call/start/complete B, C and D. Call E, start E, then complete E.
   Observe YOUR_TURN, SERVICE_STARTED and SERVICE_COMPLETED arrive through Realtime.
7. Open Inspect mock WhatsApp on E: matching simulated messages use a masked number.
8. Mark an update read, refresh and reconnect: read state persists; alerts do not duplicate.
9. Repeat admission with paid services: pending checkout has no joined update;
   successful payment produces the same updates. Paused-queue reconciliation does not.

## Verification

```sh
npm run check
npm run test:database
npm run test:database -- --notifications
npm run verify:phase4
npm run verify:phase5
npm run verify:phase6
npm run audit:secrets
```

The database tests use real independent transactions and isolated fixture IDs.
The browser harness uses actual development staff and anonymous Auth, committed
fixtures and private Realtime, then cleans its known fixture records. Reports and
screenshots are under ignored .runtime; no credentials are printed.

## Files added or changed

New:
- supabase/migrations/20260922000100_notifications.sql
- packages/contracts/src/notifications.ts
- apps/api/src/modules/notifications/provider.ts
- apps/api/src/modules/notifications/service.ts
- apps/web/src/features/customer/ticket-updates.tsx
- tests/notification-provider.test.ts
- tests/notifications.integration.test.ts
- scripts/verify-phase6-browser.mjs
- docs/phase-6.md

Updated:
- apps/api/src/config/env.ts and apps/api/.env.example
- apps/api/src/modules/queues/engine.ts
- apps/api/src/modules/customer/routes.ts and service.ts
- apps/api/src/modules/payments/service.ts (consent persistence)
- packages/contracts/src/customer.ts and index.ts
- apps/web/src/features/customer/join-page.tsx and ticket-page.tsx
- tests/database.test.ts and payment-production.test.ts
- scripts/test-database.mjs, package.json, README.md and docs/architecture.md

The ignored local API .env has the mock flag enabled; it is not tracked or exposed.

## Future WhatsApp integration and limitations

No real WhatsApp, SMS, email, web push or external delivery was added. Before a real
provider is enabled, durable delivery dispatch should run after queue commit using
the persisted intent, stable dedupe key, retries and provider acknowledgements.
External network delivery must not hold queue locks or risk rolling back the queue.
That worker infrastructure is deliberately not implemented in Phase 6.

Real delivery would also require verified provider configuration, appropriate consent
and revocation handling, approved templates, retention and delivery-status mapping.
The queue engine and customer Realtime architecture do not need WhatsApp-specific
changes. No analytics, subscriptions, appointments, real payment gateway, production
deployment or Phase 7 work is included.

## Completed verification

- TypeScript, ESLint, frontend production build and backend build passed.
- Offline/API/provider tests: 28 passed. Six database suites skip in the offline command and were run separately against Supabase.
- Full PostgreSQL integration/concurrency run: 64 passed, zero failed or skipped. Includes all Phase 2–5 database regressions and the 12 Phase 6 tests.
- RLS and browser privilege checks passed for all 16 foundational, payment and notification tables.
- Real browser Phase 4: 20 checks passed. Phase 5: 14 checks passed.
- Real browser Phase 6: 14 checks passed, including five customers, 4-to-3 near-turn, call/start/complete updates, masked mock messages, consent, read persistence, dedupe and ownership denial.
- Production mock endpoint/provider denial passed. Inspection labels are absent from the production frontend bundle.
- Source/Git/log/browser-build credential audit passed; both environment files remain ignored.
- Mobile screenshots were visually reviewed. Known fixture cleanup passed.
- Builds retain two non-blocking Zod/Rollup annotation warnings.

The long browser run initially encountered connection failures; its final complete rerun passed. The Phase 6 report's diagnostic field named databaseErrors contains three expected NOT_FOUND exceptions from deliberate cross-customer access tests. They are ownership denials, not database engine failures.

Reports: .runtime/phase4-browser.json, .runtime/phase5-browser.json and .runtime/phase6-browser.json.
Screenshots: .runtime/phase6-near-turn-mobile.png, .runtime/phase6-updates-mobile.png and .runtime/phase6-mock-whatsapp-mobile.png.

Phase 6 is complete. No Phase 7 or real WhatsApp integration has begun.
