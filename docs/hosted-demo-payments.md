# Explicit hosted-demo MOCK payments

This mode issues real queue tickets backed by simulated payments. It applies to
all businesses/branches/services, not a selected tenant. It is not a real gateway.
No migration is required; existing payments/provider and ticket relationships are reused.

## Activation

Railway API variables:
```
NODE_ENV=production
PAYMENT_PROVIDER=MOCK
PAYMENT_HOSTED_DEMO_ENABLED=true
```
The new flag defaults to false and accepts only true/false. Production requires
both MOCK and true; either absent/disabled denies simulated confirmation and retry
routes. Twilio's hosted-demo flag does not enable payments. Mock WhatsApp controls
remain unavailable in production. Keep existing Auth, database TLS and origin settings.

The WhatsApp worker does not perform payment admission and does NOT need these
payment flags enabled. Recommended worker settings: PAYMENT_PROVIDER=DISABLED,
PAYMENT_HOSTED_DEMO_ENABLED=false (or unset), NODE_ENV=production. Shared Railway
variables may set both flags on both services without enabling extra worker behavior,
but this is unnecessary. Retain the worker's existing WhatsApp configuration.

Build API from repository root:
`npm run build -w @qevra/contracts && npm run build -w @qevra/api`

API start: `npm run start -w @qevra/api`
Worker start stays: `npm run worker:whatsapp -w @qevra/api`

Redeploy Vercel with this frontend change: old production builds intentionally hide
checkout. No new VITE variable is needed. Keep VITE_API_URL,
VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY unchanged. Capabilities now come
from Express (`online_payment_available`, `payment_simulated`, `mockControlsEnabled`).
Never put the payment demo flag in a VITE variable.

Vercel root build remains
`npm run build -w @qevra/contracts && npm run build -w @qevra/web`;
output `apps/web/dist`. Deploy API/frontend together so both understand demo metadata.

## Flow and provenance

Public service and join pages label enabled paid services
**SIMULASI PEMBAYARAN — TIDAK ADA UANG ASLI**. DEPOSIT snapshots its configured deposit;
FULL snapshots the full price. Joining creates a pending request/checkout, not a
ticket. The customer must explicitly press “Konfirmasi pembayaran simulasi”.
Existing anonymous Auth, payment ownership, server-generated mock proof, event
deduplication, amount/currency validation and SQL locking remain in place. Successful
verification uses existing admission logic to create a real ticket. NONE continues
direct admission. Closed/paused/inactive queues and expired requests retain existing
restrictions. Reconciliation remains necessary if payment simulation completes but
admission cannot proceed.

The existing state machine records status PAID with provider MOCK and a mock_
reference; payment_events also retain provider MOCK. PAID means successful simulation
in this provider, never real funds. Checkout DTOs expose the persisted provider.
Customer tickets and staff queue cards derive their demo label from the linked MOCK
settlement even after the flag is disabled. No real financial instrument is collected.
Existing failure/expiry simulation controls remain limited to the owner's checkout.

## Public-demo risks and shutdown

Hosted demo customer join/retry/confirm POST requests are limited to 30 per minute
per authenticated customer per API process. Read/poll requests and other endpoints
are unaffected. This is a request-rate limit, not a participant cap or phone allowlist.
The bounded in-memory limiter resets on restart, is not shared across replicas,
and can be evaded by acquiring new anonymous identities. Existing one-active-ticket
per service and pending checkout reuse remain important additional constraints.

Anyone can intentionally simulate payment and consume actual queue capacity while
enabled. A simulation is not a financial barrier to abuse. Use this only for a
supervised public demo, not paid operations. For sustained public exposure add a
distributed limiter and bot protection in a separate change. Tickets contribute to
operational analytics and may trigger configured notifications, including chargeable
WhatsApp delivery if its separate eligibility checks pass. Inform staff that MOCK
records are not revenue. No per-tenant exception is provided: the flag is global.

To stop issuance, set API PAYMENT_HOSTED_DEMO_ENABLED=false (optionally also
PAYMENT_PROVIDER=DISABLED) and restart/redeploy it. Existing tickets remain usable;
no data is deleted. In-flight transactions may complete during rollout. Pending
checkouts cannot confirm after the new process has disabled the capability.

## Verification

Offline tests cover the production flag matrix, default 404, anonymous/staff auth,
ownership, public capabilities across branches, throttling, DEPOSIT/FULL amounts,
NONE admission, duplicate confirmations and conflicting idempotency events using
in-memory SQL fixtures. These fixtures do not prove real PostgreSQL concurrency.
Shared Supabase integration tests must remain disabled.

`node tests/payment-demo-browser.mjs` builds with envDir:false and synthetic public
configuration into ignored .runtime/payment-demo-web, then uses installed Chrome.
External browser requests are blocked and API/Auth data is mocked. It verifies the
production Join buttons, checkout, explicit confirmation, ticket label and NONE path.
Do not deploy this synthetic build; Vercel builds normally with its own public config.

After deployment, manually check one authorized customer in each NONE/DEPOSIT/FULL
service, refresh/retry without duplicate tickets, and let staff call/start/complete
the ticket. Verify provider MOCK privately. This manual smoke test creates demo
records and was not performed during implementation.
