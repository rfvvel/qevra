# Qevra MVP

Qevra is a modular monolith in an npm monorepo: React/Vite/TypeScript/Tailwind and
React Router in apps/web; Express/TypeScript/pg in apps/api; shared contracts;
Supabase PostgreSQL, Auth and private Realtime. All business data travels through
Express. SQL migrations are immutable; no ORM, workers or analytics warehouse.

## Business users and team

Business users register at /register with name, email, password and confirmation.
Supabase owns passwords, confirmation emails, sessions and refresh. Email-confirming
projects show a check-your-email state; auto-confirming development projects can
enter the app immediately. Duplicate-email handling remains privacy-preserving:
the UI suggests signing in without promising that an account exists. Invalid
credentials, mismatch, network errors and signup throttling have safe messages.

Permanent Auth accounts with an email get a profile containing UUID, display name,
normalized email and timestamps. An Auth trigger keeps email/name synchronized.
Anonymous customers do not receive business profiles. Auth metadata never assigns
business roles. Public database access to profiles remains revoked.

A new user with no memberships sees a welcome/onboarding state. They may create a
business and become OWNER atomically, or wait for an owner to add their email.
Ordinary app usage needs no database or Supabase Dashboard changes.

OWNER opens Team & access, enters an exact registered, confirmed email and chooses
MANAGER or STAFF. Unknown/unconfirmed accounts get a register-first explanation.
There is no invitation email, token, autocomplete or public email directory.
Team cards show name, email, role, assignments and active status. Internal UUIDs
remain relational identifiers but are not shown as normal team input or text.
The legacy owner-only UUID API remains for compatibility, not the normal UX.

- OWNER: business-wide configuration, team, queues and analytics.
- MANAGER: assigned branches, permitted configuration/queues, assigned analytics.
- STAFF: assigned branches/services and queue operations; no configuration writes,
team management or analytics.
- Role changes/deactivation clear stale assignments. The last active OWNER cannot
be demoted or deactivated, including under concurrent requests.

## Setup and public links

Business → Branch → Service → Counter, with daily Queue Sessions and Queue Tickets.
Counters are serving capacity: stylists, chairs, doctors, rooms or desks.
Overview explains branch → service → counter → open queue → share public link.
Services are reached through their branch; settings include a direct Open queue link.

Branch pages show Customer Queue Link, Copy Link and Open Public Page. URLs use the
current frontend origin and URL-safe, globally unique branch slug. Editing a slug
requires confirmation because existing/printed links stop working. No QR generator,
redirect history or printed-code service is included.

## Customers, queue lifecycle and payment

Customers open /q/:branchSlug, choose a service and silently receive a separate
anonymous Supabase session on joining. They enter their name, optional phone and
explicit optional WhatsApp consent; they never register a business account.
Session ownership survives refresh. Only the owner can fetch or cancel their
eligible ticket. Queue number, people ahead, capacity-based ETA, lifecycle status
and in-app updates appear on the ticket page.

Admission creates one ticket per accepted request. SQL transactions, row locks,
idempotency keys and ticket versions protect concurrent operations. Staff call,
start and complete; skip/requeue, cancellation and no-show remain supported.
Requeue retains the number, moves the ticket to the tail and does not create a
second customer. Daily queue close is final, while active work can finish.

NONE admits immediately. DEPOSIT/FULL require verified payment before admission.
Development mock checkout supports pending, success, failure, expiry, retry and
reconciliation. Stored payment truth is retained when admission cannot proceed.
Real payment provider not integrated in MVP. Production disables mock endpoints
and views; paid services therefore cannot accept new online admissions yet.

## Notifications and analytics

NotificationService handles queue events with deduplication and failure isolation.
InAppNotificationProvider persists customer updates; MockWhatsAppProvider simulates
consented delivery with masked recipients in development only. A real provider can
later implement the interface without changing queue lifecycle logic. No real
WhatsApp, invitation delivery or background notification worker exists.

OWNER/assigned MANAGER analytics derives SQL aggregates from real tickets/events:
admission/outcome counts, valid wait/service durations, hourly volume, service and
branch comparisons. Today/7/30-day filters use branch business dates. Live today is
separate. Requeue is counted once; missing/invalid durations are excluded or use a
valid authoritative call timestamp. See [Phase 7](phase-7.md) for exact definitions.

## Security and production boundaries

Supabase validates bearer tokens; Express loads current tenant membership and
branch/service scope. Composite foreign keys enforce tenant relationships.
Browser database grants are denied; the existing server PostgreSQL credential is
privileged, so Express authorization remains the primary boundary. This is not a
new least-privilege database role/RLS redesign.

Customer, payment, notification and private Realtime ownership are checked.
Exact staff email resolution requires OWNER permission in the target business.
SQL values are parameterized. Error responses omit SQL, stack traces and secrets.
Environment files are ignored; frontend has only public configuration.
CORS is an explicit origin; production startup requires HTTPS configuration and
verified PostgreSQL TLS. Health endpoints reveal only safe status.

## Limits and next steps

No password-reset/account-deletion UI, invitations, real payments/refunds, real
WhatsApp, subscriptions, appointments, QR generation, native app, AI forecasting,
exports or financial analytics. Analytics refreshes manually and supports up to
30 days. Current timezone settings apply to historical hourly buckets. Profile
and operational references require a deliberate retention/deletion process.
Supabase Auth email delivery and allowed redirects must be configured by the
developer before public release. No hosting infrastructure has been provisioned.

Future provider integration, password recovery, operational monitoring and scaling
can be separate work. See [manual deployment](manual-deployment.md) for the later
developer-run path. This phase performs no deployment.
