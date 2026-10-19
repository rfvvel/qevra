# Phase 5 — development mock payments

Phase 5 adds payment-before-admission for DEPOSIT and FULL while preserving NONE
and the existing ticket/Realtime architecture. No real money moves.

## Architecture and data

React calls authenticated Express customer endpoints. Express validates Supabase
JWTs and requires anonymous customer ownership. PaymentService uses PaymentProvider
to create attempts and verify notifications, then calls the existing
admitJoinRequest engine. MockPaymentProvider signs internal simulation events;
the browser never supplies the amount, currency, provider reference or proof.

Migration: `supabase/migrations/20260921000100_mock_payments.sql`.
It adds payments, payment_events, payment_status, join request reconciliation
fields/state, tenant foreign keys, one pending attempt per request, one recognized
settlement per request and one pending paid request per customer/service.
Existing unique ticket constraints remain. RLS is enabled and browser table
privileges are revoked. A database trigger also refuses paid ticket insertion
without a matching PAID settlement.

Amounts are bigint in PostgreSQL and decimal strings in DTOs. IDR formatting uses
BigInt, without floating point arithmetic. Join requests snapshot payment mode,
service price, amount due and currency from locked database configuration.

| Mode | Amount due | Admission |
| --- | --- | --- |
| NONE | 0 | Immediately through the existing engine; no payment |
| DEPOSIT | Configured deposit | Only after verified PAID settlement |
| FULL | Configured service price | Only after verified PAID settlement |

Changing service price, deposit or payment mode later does not change an existing
checkout. Active business/branch/service and an OPEN current-day queue are still
required at admission time.

## Lifecycles and transactions

Paid requests start PAYMENT_PENDING. Payment attempts start PENDING and can become
FAILED, EXPIRED or PAID. REFUNDED is reserved in the schema; no refund operation
exists. A verified success records paid_at and an audit event, then admits the
request atomically. Admission allocates the number/order, ticket, queue event and
revision using the Phase 3 engine; the request becomes ADMITTED.

The existing canonical lock order is retained: business shared lock, service,
session, request, payment attempts. Retry idempotency keys are locked before the
service. This deliberately differs from the illustrative payment-first sequence
in the request: all queue/configuration paths need compatible lock order to avoid
deadlocks. Payment state verification, settlement, admission and commit still occur
in one transaction.

A savepoint surrounds admission after recording PAID. If admission is impossible
(paused/closed queue, inactive business/branch/service, expired request, previous
business day, active ticket conflict or another admission error), payment remains
PAID and the request becomes RECONCILIATION_REQUIRED with a reason and audit event.
No ticket or queue number is consumed. The customer sees:

> Payment was received, but your queue ticket could not be created. Please contact the service provider.

Reopening the queue and replaying the confirmation do not automatically retry
reconciliation. There is no refund or staff reconciliation UI in this phase.

## Attempts, expiry and idempotency

Requests last 30 minutes; mock attempts last at most 5 minutes and never outlive the
request. Expiry is evaluated when checkout/retry/join is accessed; there is no
background expiry worker. A verified late success is still recorded truthfully.
If the request is expired, that success requires reconciliation.

FAILED or EXPIRED attempts are retained. An eligible retry inserts a new attempt;
it does not replace an earlier row. Concurrent retries serialize and share the
pending attempt. Each provider event is unique by provider/event ID and has a
payload fingerprint. Reusing an ID with different content fails. Repeated or
concurrent success for one payment cannot create a second settlement or ticket.
Late failure cannot downgrade PAID.

If two distinct attempts both report real success, both facts must remain in the
ledger: only one is the recognized settlement, the additional payment is marked
DUPLICATE_PAYMENT for reconciliation, and there is still one ticket. No automatic
refund is claimed. This edge is covered by integration tests.

## API and UI

All paths below begin with `/api/v1/customer`. Mutation requests require a UUID
`Idempotency-Key`. Every checkout/payment access is scoped to the verified customer.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | /join-requests | NONE admission or paid request + PENDING attempt |
| GET | /join-requests/:joinRequestId | Own checkout and attempt history |
| POST | /join-requests/:joinRequestId/payments | New eligible mock attempt |
| POST | /payments/:paymentId/mock | Simulate SUCCESS, FAILURE or EXPIRY |

Checkout lives at `/checkout/:joinRequestId`, clearly labeled **Development Mock
Payment**. It displays service price/pay now and, for deposits, deposit/remaining.
Pending, failed, expired and reconciliation states have explicit messages.
Success redirects to the existing ticket page and private Realtime behavior.
Checkout refresh preserves the Supabase anonymous session. No customer login UI
is introduced. Network-uncertain actions can retry the same idempotency key.

The public catalog uses Join queue, Pay deposit & join and Pay & join actions.
Payment availability is supplied by Express. Client input cannot override business,
price, mode, currency or queue identity.

## Development configuration and manual demo

Keep existing Supabase environment files private. In `apps/api/.env` set:

```dotenv
NODE_ENV=development
PAYMENT_PROVIDER=MOCK
```

PAYMENT_PROVIDER defaults to DISABLED. NODE_ENV=production always disables mock
confirmation and retry endpoints (404), even if MOCK is configured. Vite production
builds also remove the mock controls. No provider signing secret is exposed or
configured in VITE variables.

1. Run `npm run db:migrate` against the development database, then `npm run dev`.
2. Sign in at /login. Configure active services/counters, then open their queues.
3. Use FULL price 100000 and DEPOSIT price 500000/deposit 50000.
4. Open the public branch page in a separate browser profile. Select FULL, enter
   a name, and verify checkout has no queue number before payment.
5. Simulate success. The ticket appears; staff can call, start and complete it,
   with live customer updates.
6. Select DEPOSIT. Verify Rp500.000, Rp50.000 and Rp450.000. Simulate failure,
   retry, simulate expiry, create a new payment and simulate success.
7. For reconciliation, start a new customer's checkout, pause its queue from the
   staff page, then simulate success. Confirm PAID plus the contact-provider message.

## Verification commands

```sh
npm run check
npm run test:database
npm run test:database -- --payments
npm run verify:phase4
npm run verify:phase5
npm run audit:secrets
```

Database tests use isolated fixture UUIDs with real independent transactions and
clean up those fixtures. Browser tests use real development staff/anonymous Auth
and committed fixtures so actual private Realtime broadcasts are verified.
Optional TEST_STAFF_EMAIL and TEST_STAFF_PASSWORD remain server-only in the API
.env. Sanitized reports and screenshots are written under ignored .runtime.

## Files

- API: config/env.ts, app.ts, customer/routes.ts and service.ts,
  configuration/routes.ts, queues/admission.ts and idempotency.ts,
  payments/provider.ts and service.ts.
- Web: customer checkout-page.tsx, join-page.tsx, public branch page,
  customer-api.ts and router.
- Contracts: payments.ts, configuration.ts and index.ts.
- Database: new 20260921000100_mock_payments.sql only.
- Tests: payment-provider.test.ts, payment-production.test.ts,
  payment.integration.test.ts; customer regression configuration and database RLS checks.
- Scripts: test-database.mjs, verify-phase5-browser.mjs, audit-secrets.mjs and Phase 4 catalog selector.
- Documentation/config: README, this file, architecture notes, API .env.example
  and root package scripts.

## Future provider boundary and limitations

A future Midtrans adapter implements createCheckout and verifyNotification,
verifies the gateway's signature and authoritative amount/currency, and passes
verified notifications to PaymentService.confirm. Queue admission remains unchanged.
A real integration must add its own server-only configuration, stable external
idempotency reference, durable checkout-creation recovery and webhook authentication.
External network calls should be orchestrated without holding queue locks for long
periods. No public webhook or real gateway is included now.

Mock proofs use a process-local key because simulation and verification happen in
the same call; this is not a real gateway signature scheme. Status polling/recovery
and refund interfaces should be added when their gateway behavior is specified.
There is no real payment, refund, WhatsApp, notification worker, analytics,
subscription, appointment or production deployment. Stop at Phase 5.

## Completed verification

- TypeScript, ESLint, API build and production frontend build passed.
- Offline/API/provider/production-mode tests: 26 passed; five live database suites explicitly skipped in that command and verified separately.
- Full real PostgreSQL integration/concurrency suite: 52 passed, zero skipped or failed.
- Additional schema check: 14 foundational/payment tables have RLS enabled and browser SELECT/INSERT/UPDATE/DELETE denied.
- Phase 4 real browser regression: all 20 checks passed, including NONE, private Realtime, ownership, persistence, polling fallback and cancellation.
- Phase 5 real browser: all 14 checks passed, including FULL, DEPOSIT, failed/expired retries, payment-before-ticket, live staff transitions and persisted reconciliation.
- Browser fixture cleanup and credential-log checks passed. Production build contains no mock simulation button labels; production API tests return 404 for mock actions.
- Four migrations are recorded as applied, including the new payment migration; no earlier migration was edited.
- Two existing Zod/Rollup annotation warnings are non-blocking; builds succeed.

Reports: .runtime/phase4-browser.json and .runtime/phase5-browser.json. Mobile screenshots for checkout and reconciliation are in .runtime; this directory is ignored by Git.
