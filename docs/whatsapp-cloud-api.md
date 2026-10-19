# Meta WhatsApp queue reminders (post-MVP)

## Scope and activation

This integration adds real outbound NEAR_TURN and YOUR_TURN reminders through one shared Qevra Meta sender. All existing IN_APP notification types remain. Development MockWhatsApp remains a local simulation; its inspection screen never represents Meta delivery. Payments remain mock-only. No hosted configuration, deployment, migration execution or real send was performed during implementation.

Default configuration is DISABLED. Explicit WHATSAPP_PROVIDER selects DISABLED, MOCK or META. For older installations only, an absent selector retains MOCK_WHATSAPP_ENABLED compatibility. MOCK is disabled in production. META requires every Meta configuration field at startup. Valid-looking configuration does not prove token validity, template approval or Graph version support; the operator must verify these in Meta. Never put Meta configuration in VITE_* variables.

## Architecture and delivery semantics

1. Queue event handling invokes the existing NotificationService in the queue transaction. It inserts a META_WHATSAPP notification and its outbox row together. No Meta HTTP request occurs in that transaction. Existing notification savepoints isolate generation failures from queue mutations and record a sanitized generation failure when possible.
2. The standalone worker claims a READY row using FOR UPDATE SKIP LOCKED, sets a unique claim token and commits. Separate worker processes can safely share the same database. Each process handles one message at a time.
3. A second short transaction checks current ownership joins, consent, normalized Indonesian mobile phone, business/branch/service activity, today's session, ticket state and five-minute expiry. NEAR_TURN requires an OPEN session, WAITING ticket and at most three waiting customers ahead. YOUR_TURN requires a CALLED ticket and the latest call event. Invalid work becomes SKIPPED.
4. After both transactions commit, the provider sends an approved template to Meta over HTTPS, with a 15-second timeout. Text parameters are bounded and stripped of newlines. No arbitrary free-form messages or redirects are allowed.
5. A separate transaction records acceptance or failure. Meta acceptance is stored as notification SENT/outbox ACCEPTED; it is **not delivery confirmation**. Only status webhooks establish sent/delivered/read/failed delivery status.

NEAR_TURN deduplicates once per ticket, including requeues. YOUR_TURN deduplicates per call event: a legitimate subsequent call may produce a new reminder. Duplicate API events do not create duplicate jobs. A skipped/failed NEAR_TURN does not create another near reminder for that ticket.

Only explicit throttle rejection codes are automatically retried. There are at most five attempts, with delays of 5, 10, 20 and 40 seconds between those attempts. Permanent rejection ends FAILED. Network errors, malformed successful responses and server errors become AMBIGUOUS; they are not automatically resent. A SENDING claim abandoned beyond its two-minute lease also becomes AMBIGUOUS. This deliberately favors avoiding duplicates over guaranteed delivery. There is no exactly-once claim.

Signed status callbacks are durably deduplicated in an inbox. The provider's message ID is authoritative after acceptance; the opaque outbox UUID can correlate a callback that arrives before the HTTP response is recorded. Monotonic status precedence is read > delivered > failed > sent. Late sent/failed callbacks cannot overwrite delivered/read. An early receipt can resolve an ambiguous response. Webhook persistence errors return a sanitized error so Meta can retry.

## Database and source map

Apply all existing migrations, then `supabase/migrations/20261019000100_whatsapp_outbox.sql` through the established reviewed migration workflow. This new migration adds the META_WHATSAPP enum value, whatsapp_outbox and whatsapp_receipts, supporting indexes and the updated_at trigger. Previously applied migrations are unchanged. Apply it before enabling META or starting the worker. Rollback activation by stopping workers and selecting DISABLED, preserving notification history; do not drop the enum/tables as an operational rollback.

Both new tables enable RLS and revoke browser-role access. Express/worker database credentials retain server-side access. Outbox rows reference a notification with the same business ID, and notifications retain their existing customer/ticket/event ownership foreign keys. No public delivery-inspection API was added. The receipt inbox is server-only and may briefly contain unmatched receipts.

| File | Responsibility |
| --- | --- |
| apps/api/src/config/whatsapp.ts | Mode and backend configuration validation |
| apps/api/src/config/env.ts | Loads validated mode alongside existing configuration |
| apps/api/src/modules/notifications/service.ts | Atomic enqueue; existing IN_APP/mock delivery |
| apps/api/src/modules/notifications/provider.ts | Shared provider contract |
| apps/api/src/modules/notifications/meta-provider.ts | Official Graph template transport and safe error classification |
| apps/api/src/modules/notifications/outbox.ts | Claims, eligibility, retries, receipt persistence/reconciliation |
| apps/api/src/modules/notifications/webhook.ts | Challenge, raw-body HMAC and payload validation |
| apps/api/src/app.ts | Mounts webhook before JSON middleware |
| apps/api/src/whatsapp-worker.ts | Polling process and graceful shutdown |
| apps/web/src/features/customer/join-page.tsx | Transparent optional consent wording |
| tests/whatsapp.test.ts | Fake transport and local webhook tests |
| tests/whatsapp.integration.test.ts | PostgreSQL concurrency, rollback, retries, stale suppression and isolation |
| scripts/test-whatsapp.mjs | Test launcher that never loads .env |

## Backend configuration

Use `apps/api/.env.example` as the placeholder reference. Keep actual secrets only in a backend environment/secret store, never in frontend files, Git, screenshots or chat.

| Variable name | Purpose |
| --- | --- |
| WHATSAPP_PROVIDER | Explicit provider selection |
| META_WHATSAPP_ACCESS_TOKEN | Access token authorized for the sender/WABA |
| META_WHATSAPP_PHONE_NUMBER_ID | Meta phone-number object ID, not the visible phone number or WABA ID |
| META_WHATSAPP_API_VERSION | Currently supported Graph version selected by the operator; no implicit default |
| META_WHATSAPP_APP_SECRET | App secret used for webhook HMAC verification |
| META_WHATSAPP_WEBHOOK_VERIFY_TOKEN | Operator-generated random challenge verification secret |
| META_WHATSAPP_NEAR_TURN_TEMPLATE | Approved near-turn template name |
| META_WHATSAPP_YOUR_TURN_TEMPLATE | Approved called-ticket template name |
| META_WHATSAPP_TEMPLATE_LANGUAGE | Exact approved language code shared by both templates |

API and worker use the same configuration and database. Existing DATABASE_URL, Supabase and production configuration requirements still apply. The test-only database variable is TEST_DATABASE_URL; it must name a separate disposable test database, never a production database.

## Manual Meta setup

Meta changes navigation labels periodically. Use the named resources below if a panel has moved. No step below was executed automatically.

### Test sender

1. In Meta for Developers, create/select the business app associated with Qevra's business portfolio and add the WhatsApp product/use case.
2. Open WhatsApp → API Setup (sometimes Getting Started). Select the Meta-provided test sender. Record the **Phone number ID** and **WhatsApp Business Account ID** separately in your private configuration.
3. Add an authorized recipient through the test recipient selector and complete its verification. Use only a person who explicitly agrees to receive this test.
4. The panel's temporary access token and preapproved sample template can establish Meta connectivity manually. A sample `hello_world` send is **not** Qevra's end-to-end test: this adapter needs the two exact templates/parameter counts below. Do not configure a sample template as a queue template or add a free-text fallback. If the test WABA does not support creating/approving these templates, finish custom-template testing on a properly onboarded business WABA.
5. Temporary tokens expire. For an ongoing integration, use a properly authorized system-user token and monitor its validity rather than relying on the dashboard's temporary token.

### Business sender

1. In Business Settings/WhatsApp Manager, create/select Qevra's WABA, add the business number, complete number verification/registration and display-name approval, and satisfy the account's business verification/payment requirements. Follow Meta's current number eligibility or migration/coexistence workflow if the number is already used elsewhere.
2. Assign the app and WABA assets to the appropriate system user in Business Settings → Users → System users. Generate a token for that app with the needed WhatsApp permissions. Sending uses whatsapp_business_messaging; account/template/subscription administration uses whatsapp_business_management and the necessary asset access. Follow Meta's current access-review requirements for your account/use case.
3. Retrieve the app secret from the app's basic settings. Generate a separate strong webhook verify token. Store these privately in the backend configuration.
4. In WhatsApp Manager → Message templates, create the two templates below as **UTILITY**, with the selected language, positional body parameters, no header parameters and no button parameters. Supply fictional sample parameter values for review. Wait for APPROVED status and verify that Meta retained the Utility category; code cannot verify category/approval from a template name. Avoid promotions.
5. Set META_WHATSAPP_API_VERSION to a currently supported version for the app, checked against the [Graph API versions](https://developers.facebook.com/docs/graph-api/changelog/versions). The version in test fixtures is just a fixture, not a promise of current support.
6. Register and subscribe the webhook as described below, then run the authorized smoke test. All tenants currently share this sender and its reputation/limits. Business names are body parameters; there is no per-tenant credential or sender onboarding.

### Exact template contract

Suggested names are `qevra_near_turn` and `qevra_your_turn`, language Indonesian (`id`). Names and language remain configurable, but parameter position/count must match the code. Review wording with Meta before use.

NEAR_TURN body (four parameters):

```text
Info antrean {{1}}: Halo {{2}}, nomor antrean Anda {{3}}. Ada {{4}} pelanggan menunggu di depan Anda. Mohon tetap berada di dekat area layanan dan pantau halaman antrean Qevra.
```

YOUR_TURN body (three parameters):

```text
Info antrean {{1}}: Halo {{2}}, nomor antrean Anda {{3}} sedang dipanggil. Silakan menuju area layanan dan ikuti arahan petugas.
```

The positions are branch name, customer name, formatted queue number, then people-ahead for NEAR_TURN only. The shared sender's identity should clearly identify Qevra; ensure customers understand which branch the reminder concerns. This code never substitutes free-form content if a template is unavailable.

## Webhook and WABA subscription

The public HTTPS callback is `https://<API_HOST>/api/v1/webhooks/whatsapp` (GET and POST). Localhost alone is not reachable by Meta; an operator-managed HTTPS development tunnel can be used for the manual test. Creating a tunnel/deployment is not part of this implementation.

1. Start the migrated API with META selected and complete configuration.
2. In the app's WhatsApp → Configuration webhook panel (or Webhooks → WhatsApp Business Account), enter the callback URL and the same backend webhook verify token. Verify and save. GET must return the supplied hub.challenge as plain text after checking hub.mode and hub.verify_token.
3. Subscribe to the **messages** field. Delivery status events arrive through this field, not a separate `statuses` subscription.
4. Ensure the app is subscribed to the intended WABA, not merely that the callback challenge passed. The management operation is `POST /<WABA_ID>/subscribed_apps` using an appropriately authorized token on the configured Graph version; `GET /<WABA_ID>/subscribed_apps` verifies the subscription. Use Meta's secure API tools and do not paste bearer tokens into shared logs or chat. WABA ID is not Phone number ID.
5. The POST handler validates X-Hub-Signature-256 against the **original bytes** using the app secret, before parsing JSON. Configure proxies to preserve body bytes and the signature header. Redact webhook GET query strings (they contain the verify token), authorization headers and bodies in reverse-proxy/access logs.
6. Status events must identify the configured phone-number ID. Unknown types are ignored. Incoming customer messages are not processed; this is not a conversational inbox or automated STOP/opt-out handler.

See Meta's [Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api), [webhooks documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks), and [message reference](https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages). Direct Meta reference pages were rate-limited during implementation; dashboard readiness and the real message/status cycle still need manual verification.

## Running the worker

From the repository root, after configuration and migrations:

```bash
npm run build -w @qevra/contracts
npm run build -w @qevra/api
npm run worker:whatsapp -w @qevra/api
```

For development, use `npm run dev:worker:whatsapp -w @qevra/api` alongside `npm run dev`. The worker is intentionally a separate process; `npm run dev` alone does not start real sending. Use a process supervisor when operating it long-term. SIGINT/SIGTERM stops new claims, wakes an idle poll, lets the current bounded operation finish and closes the pool. A hard kill is handled conservatively through lease expiry.

## Verification and manual smoke test

Offline tests: `npm run test:whatsapp`. This command disables dotenv file loading and uses only fabricated credentials/injected HTTP; the webhook test uses localhost. Database tests: set TEST_DATABASE_URL privately in the process environment, migrate a **separate Supabase-compatible test database** with all migrations, then run `npm run test:whatsapp:database`. This launcher does not read .env or apply migrations and fails clearly when no test database is configured. Tests insert isolated fixtures and clean them up; they need privileges to create test auth.users and exercise browser roles.

The regular `npm test` discovers the new suites as well. Existing phase database/browser verification commands retain their previous configuration behavior; do not run them in a no-.env audit. Full Phase 1–8 database/browser regression remains a separate required check before rollout.

Manual smoke, only after approval/configuration:

1. Use an isolated development branch/service and an authorized test recipient. Confirm the two templates are approved and the webhook/WABA subscriptions are active. Start API and worker; monitor sanitized outbox status.
2. Join with consent unchecked: expect IN_APP updates and no real WhatsApp outbox row for that customer.
3. Use synthetic other customers **without WhatsApp consent** to place the consenting test recipient at least four waiting positions behind. Advance the queue until three or fewer are ahead; expect one near template, matching branch/name/number/count. Check accepted ID and signed delivered/read callbacks where the recipient supports read receipts.
4. Call the recipient's ticket: expect one called template and the existing IN_APP update. Refresh/reconnect/repeat an idempotent request: no extra job for the same event. A legitimate requeue and subsequent new call is a different event and may send again.
5. Stop the worker, create an eligible job, then cancel/complete the ticket before restarting. Expect SKIPPED and no send. Also verify expiry past five minutes.
6. Inspect the mock panel only in MOCK development mode; it must be clearly simulated. Do not switch it to display Meta acceptance as mock history.
7. Stop the worker and restore DISABLED after the smoke test if real delivery is not intended to remain enabled. Keep results free of phone numbers, names, tokens and raw Meta payloads.

Implementation verification: workspace TypeScript checks, additional strict type checks for the new test files, ESLint, backend build and frontend build passed. The regression run reported **39 passed, 0 failed, 9 skipped database suites**. The frontend was built with Vite envDir disabled to avoid reading real .env files; its empty auth chunk and Zod annotation warnings do not establish configured Auth runtime readiness. The PostgreSQL integration suite was prepared but **not executed**, because the user confirmed no separate test database is available. Its dedicated launcher correctly reports the missing TEST_DATABASE_URL. No live Meta smoke or new browser E2E run has been performed. Therefore this is not a claim of production readiness.

## Operations, privacy and limitations

- Inspect counts by status/attempts/error_code using server-only database access. Alert on oldest READY age, growing AMBIGUOUS/FAILED counts and notification_events GENERATION_FAILED. Existing API health does not certify worker health.
- Example safe aggregate: `SELECT status, error_code, count(*), min(created_at) FROM public.whatsapp_outbox GROUP BY status,error_code;` Never copy recipient records, tokens or raw HTTP errors into logs.
- Do not blindly reset AMBIGUOUS to READY. A missing webhook does not prove non-delivery. Investigate provider IDs/receipts and consent/current ticket state; no automatic administrative resend endpoint is provided.
- Five-minute expiry limits reminders delayed by outages. State/consent can change after the final database check while HTTP is in flight; delivered messages cannot be recalled. No distributed database/Meta transaction exists.
- The existing normalized Indonesian +628 mobile-number policy is retained. Opt-in timestamps are rechecked immediately before sending. Phone ownership is not verified by this integration. No customer-facing consent revocation screen or incoming STOP processor was added; operators need a consent-revocation/support process before rollout. Clearing the stored consent prevents future eligible sends but cannot recall a send in flight.
- No recipient phone is copied into outbox or receipts. Existing join requests still contain phone and consent, existing notifications contain message copy, and Meta necessarily receives the authorized destination and template data. Establish access and retention policies for these records. Receipt pruning/archival is not automated; do not delete live unmatched receipts before reconciliation or dedupe records while callbacks may be retried.
- One sender shares Meta rate limits and quality across tenants. Monitor opt-outs, template status, token expiry, API version deprecation and queue backlog. There is no tenant quota/fair scheduling, delivery dashboard, circuit breaker or automatic token rotation in this change.
- Meta's published pricing is based on delivered messages and varies by destination/category, with applicable exceptions. Check the current [official pricing and rate cards](https://business.whatsapp.com/products/platform-pricing) before enabling; do not assume queue reminders are always free. Qevra does not bill tenants or implement subscriptions here.
- Templates are configured by operators. Their approval and UTILITY classification are not queried at runtime. Choose appropriate shared-sender branding and verify account/platform-policy eligibility before a multi-tenant launch.
- Public webhook inputs are size-bounded and signature checked, but edge rate limiting/traffic protection and proxy log redaction remain deployment responsibilities. Shared Meta credentials require careful server-side handling; rotate exposed secrets.
