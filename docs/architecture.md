> Historical Phase 1 design snapshot. Implemented behavior is documented in [Phase 2](phase-2.md), [Phase 3](phase-3.md), [Phase 4](phase-4.md), [Phase 5](phase-5.md), and [Phase 6](phase-6.md).

# Qevra — approved Phase 1 boundaries

React/Vite communicates with Express through REST. Express uses `pg` and SQL
transactions against Supabase PostgreSQL. Supabase handles staff authentication,
invisible anonymous customer authentication, and future private Realtime events.
The frontend has no business-table queries or business data yet.

## Authorization

`requireAuth` validates a bearer JWT by asking the configured Supabase Auth server
through `getUser(token)`. `requireStaff` rejects anonymous identities.
`requireBusinessRole` loads active membership and checks an explicit role allowlist.
Future branch endpoints must also query branch/service assignments. Never treat
membership alone as permission for every branch. These middleware functions are
prepared but not mounted on the public health endpoint.

All Phase 1 tables have RLS enabled, with access revoked from browser roles and no
allow policies. The local Express connection uses the server-only PostgreSQL owner
credential, which bypasses RLS. Express authorization is therefore the primary
security boundary, as approved. This is not a least-privilege production role.
No transaction-local actor context or service-role API key is used. A future
database role/policy design must preserve the deny-by-default browser boundary.

## Data model

Business → branch → service → queue session → queue ticket. Composite foreign keys
ensure child records remain inside their tenant and service. Join requests precede
tickets; counters represent dedicated service capacity rather than necessarily
physical desks. `branch_members` and `staff_services` prepare assignment integrity.

All money is integer IDR. PostgreSQL bigint values need explicit safe serialization
when DTOs are added; do not blindly cast arbitrary bigint values to JavaScript numbers.
The database stores UTC timestamps and a branch timezone for future business dates.
Timezone validity, last-owner protection and queue transitions will be enforced by
future Express operations. Profiles are created explicitly for staff in Phase 2;
there is no trigger creating profiles for every anonymous customer.

The schema intentionally has no payment tables. Consequently, payment-before-
admission is an architectural invariant, not an implemented payment guarantee.
There is no admission endpoint. Before paid admission ships, add payment records,
verified confirmation and the atomic payment/admission workflow. Queue-event
append-only behavior will be enforced through future runtime privileges and APIs.

## Future transactions

`withTransaction` checks out one pg client for BEGIN/COMMIT/ROLLBACK. Queue numbering
and call-next will use row locks on this client in their implementation phase.
No queue mutation, number allocation or locking operation is implemented now.

## Provider boundaries (design only)

PaymentProvider now exposes createCheckout and verifyNotification; PaymentService consumes verified events and reuses queue admission. MockPaymentProvider is development-only. Gateway status recovery and refund interfaces remain future work. See [Phase 5](phase-5.md).
NotificationProvider will expose send with a deduplication key and delivery result;
InAppProvider and MockWhatsAppProvider come with the notification phase.
Outbox persistence, workers, provider adapters and external requests are deferred.

## Realtime (later phase)

Use private authorized Broadcast channels carrying revision/invalidation events;
clients fetch authorized snapshots from Express. Add realtime.messages policies
and publication/broadcast logic with queue functionality. No channels or business
table publications are enabled by this foundation. Reconnect must refetch state.

## Remaining phases

2. Business/branch/service CRUD, staff profiles and scoped assignments.
3. Transactional queue engine, numbering, states and concurrency tests.
4. Customer join flow, ETA and private Realtime.
5. Mock payment abstraction and payment-before-admission.
6. Durable notifications, in-app messages and mock WhatsApp.
Later: analytics, real integrations, plans and production deployment.
