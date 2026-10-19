# Hosted demo: Railway API/worker, Vercel web, Supabase

This guide does not deploy anything or apply SQL. The operator reports that the WhatsApp outbox and Twilio inbound migrations are already applied; do not rerun/reset schema as a deployment step. Keep the existing demo records. No test may target the shared database.

## Railway: two services from the repository root

Use the repository root (not apps/api) for both services. Use Node 22.12+ (Node 24 supported). Include development dependencies during installation because TypeScript is a build dependency. Keep workspace dependencies and the compiled contracts at runtime.

Install for both: `npm ci --include=dev`

Build for both:
```sh
npm run build -w @qevra/contracts && npm run build -w @qevra/api
```

API start:
```sh
npm run start -w @qevra/api
```

Worker start:
```sh
npm run worker:whatsapp -w @qevra/api
```

Override Railway's service commands independently; do not start both processes in one shell. API listens on 0.0.0.0 and the platform PORT. Expose only the API publicly; use `/api/v1/health` for its process health check and manually inspect `/api/v1/health/database` for DB readiness. The worker has no HTTP listener: no public domain or HTTP health check. Keep the worker service running continuously and restart on failure. Start with one instance; database claims support multiple workers. Do not add migrations or tests to deployment/start commands. See [Railway monorepo settings](https://docs.railway.com/deployments/monorepo) and [start commands](https://docs.railway.com/deployments/start-command).

Set these variables on **both** services:

| Name | Setting |
| --- | --- |
| NODE_ENV | production |
| WHATSAPP_PROVIDER | TWILIO |
| TWILIO_HOSTED_DEMO_ENABLED | true; explicit, defaults false |
| TWILIO_ACCOUNT_SID | Account SID, private configuration |
| TWILIO_AUTH_TOKEN | Auth token, secret configuration |
| TWILIO_WHATSAPP_FROM | Sandbox sender including whatsapp: prefix |
| TWILIO_WEBHOOK_ORIGIN | Exact public API HTTPS origin; no slash/path/query |
| DATABASE_URL | Verified PostgreSQL URL described below |
| DATABASE_CA_CERT | Optional trusted CA PEM text, only when needed |
| WEB_ORIGIN | Exact Vercel frontend HTTPS origin; no slash/path |
| SUPABASE_URL | Supabase project HTTPS origin |
| SUPABASE_PUBLISHABLE_KEY | Project publishable/legacy anon key |
| PAYMENT_PROVIDER | DISABLED |
| MOCK_WHATSAPP_ENABLED | false |

Let Railway supply PORT for the API. The worker inherits the shared configuration validator, so it also needs the origin and Supabase settings. The demo flag only permits Twilio selection; all production startup, TLS and payment protections still apply. Even if PAYMENT_PROVIDER is accidentally MOCK, development mock payment endpoints remain unavailable in production. Use NONE services for the hosted demo; DEPOSIT/FULL do not get a production payment bypass. No real gateway is introduced.

## PostgreSQL TLS without Windows paths

Use the host/username/port for the intended Supabase connection method. A session pooler may be appropriate for host network compatibility; copy the correct connection identity privately from Supabase rather than inventing the username. Retain the DNS hostname for hostname verification.

Format only (not real credentials):
```text
postgresql://<URL_ENCODED_USER>:<URL_ENCODED_PASSWORD>@<SUPABASE_DB_OR_SESSION_POOLER_HOST>:5432/postgres?sslmode=verify-full
```

Percent-encode username/password components. In production the app requires exactly one verify-full mode, removes that query parameter before passing the URL to pg, and supplies explicit `ssl: { rejectUnauthorized: true }`. Node's normal certificate-chain and hostname verification remain in effect. No custom checkServerIdentity override is installed.

If the database certificate needs a custom CA, copy the **trusted CA certificate PEM** from the verified Supabase project configuration into DATABASE_CA_CERT on both services. Real multiline text or literal `\n` separators are accepted; startup validates certificate parsing. Do not paste a filename, private key or a certificate obtained from an untrusted failed connection. If the system trust store already validates the endpoint, leave this variable unset.

Production URLs reject sslrootcert/sslcert/sslkey/ssl and compatibility/host overrides. Remove old Windows paths entirely. No CA file is loaded relative to the workspace, and the untracked local certificate is not needed. Do not set NODE_TLS_REJECT_UNAUTHORIZED to disable TLS or weaken SSL settings. This helper is used by the running API/worker; legacy migration scripts have their own connection handling and are **not** part of this deployment.

## Vercel

Import the same repository with Root Directory set to the repository root and the Vite framework preset. The new root vercel.json defines:

- Install: `npm ci --include=dev`
- Build: `npm run build -w @qevra/contracts && npm run build -w @qevra/web`
- Output: `apps/web/dist`
- SPA rewrite to index.html for direct `/q/...`, `/app/...`, `/login` and ticket routes.

Build-time public variables:

| Name | Setting |
| --- | --- |
| VITE_API_URL | Public Railway API HTTPS origin followed by /api/v1 |
| VITE_SUPABASE_URL | Supabase project HTTPS origin |
| VITE_SUPABASE_PUBLISHABLE_KEY | Public project publishable/legacy anon key |

Never expose DATABASE_URL, CA configuration or Twilio secrets to Vite. Rebuild after public variables change. Match API WEB_ORIGIN to the actual frontend domain (not the API domain); CORS allows that single origin, not arbitrary preview domains. Configure Supabase Auth Site URL and allowed login redirects for the frontend, and preserve anonymous Auth/Realtime settings. See [Vercel Vite deep-link configuration](https://vercel.com/docs/frameworks/frontend/vite).

## Twilio callbacks and public access

In Sandbox settings, set the inbound webhook to:
```text
POST https://<API_HOST>/api/v1/webhooks/twilio/inbound
```

The provider sets a per-message callback automatically:
```text
POST https://<API_HOST>/api/v1/webhooks/twilio/status?job=<OUTBOX_UUID>
```

Use the same exact API origin on API and worker. Preserve path, query and form fields through the proxy. Signature validation uses the configured HTTPS origin plus originalUrl, not an untrusted forwarded host. No trailing slash or extra query arguments should be added. No trust-proxy relaxation is needed for this signature scheme.

Public branch QR pages remain open to everyone. There is **no recipient allowlist, preselected number or participant cap**. Visitors silently authenticate anonymously, enter any valid Indonesian mobile number, and choose consent. The near-turn threshold (three waiting customers ahead, hence four currently near-turn candidates) is a notification threshold, **not queue capacity**. Existing validation, idempotency, ownership and queue constraints remain unchanged.

Each WhatsApp recipient must still enroll with Twilio's Sandbox join code and send an inbound WhatsApp message to the Sandbox. QR scanning/consent does not open the 24-hour window. Enrollment expires after three days; renew when required. See [Twilio Sandbox rules](https://www.twilio.com/docs/whatsapp/sandbox). The existing provider rechecks verified inbound evidence with a one-minute boundary margin and skips missing/expired windows. Twilio remains the final authority on eligibility; no free-form fallback outside the window is introduced.

## Manual sequence after deployment

1. Privately confirm the target project and existing migration versions; back up demo data. Do not run integration suites or automatic migrations against it.
2. Configure Vercel/Railway domains and matching variables, then build/start API first. Check process and database health and open a frontend deep link directly.
3. Register the Twilio inbound webhook. An authorized tester joins the Sandbox and sends a fresh text message. Confirm webhook success without copying credentials, phone numbers or message bodies into logs.
4. Start the worker. Join an open NONE service through its public branch link with consent. Any additional visitors can join normally; do not opt other people's numbers in for testing. Verify near-turn then call the ticket and verify YOUR_TURN. Check accepted versus delivered/read status separately.
5. Verify a no-consent customer still receives IN_APP updates, expired/missing inbound evidence skips WhatsApp, and refreshing does not duplicate jobs. Confirm production mock payment endpoints are unavailable. Use mocked tests for provider failures, not unsolicited live messages.
6. Monitor worker errors/backlog, provider usage and Sandbox limits. There is no new general rate limiter, enrollment verifier, automatic STOP handling or guaranteed delivery. An open public demo can consume account quota; existing validation is not a complete anti-abuse system. Stop the worker and disable provider selection when the demo ends.

This change is code-ready for a controlled hosted demo after manual configuration. Database connectivity, deployed browser/Auth behavior, Twilio enrollment/callback reachability and delivery still require the above smoke test. No deployment, schema change or real message was performed during implementation.

Offline verification: 50 tests passed, zero failed, nine database suites skipped; workspace TypeScript, strict hosted-test TypeScript, ESLint and contracts/API/frontend builds passed. Frontend build disabled .env loading and emitted the existing Zod annotation warnings plus an empty auth chunk due to absent public runtime configuration. Public joining checks cover anonymous public-route access and input contracts; real PostgreSQL admission and deployed authentication were not exercised in this run.
