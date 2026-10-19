# Twilio WhatsApp Sandbox demo

This development-only provider sends NEAR_TURN and YOUR_TURN through the existing NotificationService/outbox/worker. IN_APP, Meta, mock WhatsApp and mock payments remain. Selecting TWILIO in NODE_ENV=production fails startup unless TWILIO_HOSTED_DEMO_ENABLED is explicitly true. See [hosted demo deployment](hosted-demo.md); other production protections remain enabled. No hosted migrations or live sends were performed during implementation.

## Eligibility: consent is not a messaging window

Each recipient must join **your** Sandbox using its join code. Sandbox enrollment expires **three days after joining** and must then be renewed. Separately, a customer-initiated WhatsApp message opens a **24-hour customer service window**. Scanning a Qevra QR code or checking its consent checkbox does not open it. See [Twilio Sandbox rules](https://www.twilio.com/docs/whatsapp/sandbox).

After configuring the inbound webhook, ask the authorized recipient to send a fresh text message to the Sandbox. The webhook signature and account/sender are validated, then Qevra retrieves that Message SID from Twilio to verify its direction, addresses and original `date_created`. That provider timestamp is stored with a unique account/message key; arrival time is never used to extend eligibility. Delayed callbacks and duplicate retries therefore cannot create a fresh 24-hour window. See [Twilio inbound timestamps](https://help.twilio.com/articles/46569585455003).

Before each send, the provider reads the most recent verified inbound timestamp for the configured account/sender/recipient. Missing, invalid, future or expired timestamps cause SKIPPED/TWILIO_WINDOW_CLOSED. A one-minute boundary margin is enforced. Opt-in and Indonesian +628 phone validation remain independently required. Only text-message SIDs starting SM are accepted by this demo implementation.

This local check is conservative evidence, not an authoritative Sandbox membership API. Qevra cannot independently prove current enrollment, blocking/opt-out state or provider eligibility. Twilio may still reject the message, and network/queue delay can cross the window boundary. An absent callback fails closed even if Twilio actually has an open window. There is no template fallback, and a job skipped for a closed window is not resurrected by a later inbound message. No new queue triggers were added.

## Configure manually

Backend-only variable names (placeholders are in apps/api/.env.example):

- WHATSAPP_PROVIDER — explicitly select TWILIO.
- TWILIO_ACCOUNT_SID
- TWILIO_AUTH_TOKEN
- TWILIO_WHATSAPP_FROM — the Sandbox sender, including the `whatsapp:` prefix.
- TWILIO_WEBHOOK_ORIGIN — exact public HTTPS origin, no trailing slash/path/query, e.g. `https://your-demo-host.example`.

Keep NODE_ENV=development and the existing database/Supabase configuration. Credentials must never be VITE_* variables or committed. API and worker must share configuration. Missing configuration fails startup. The origin is required for signature validation behind a tunnel/proxy; request Host/X-Forwarded-Host headers are not trusted to choose it.

1. In Twilio Console, open Messaging → Try it out → Send a WhatsApp message / Sandbox. Activate the Sandbox and copy its sender and join instructions privately. UI labels can change.
2. Have **one authorized recipient** send the specified `join ...` message and confirm enrollment. Do not use arbitrary customer numbers.
3. Review/apply migrations through the normal backed-up workflow **before enabling the provider**. This change adds `supabase/migrations/20261019000200_twilio_sandbox.sql`; it requires the existing WhatsApp outbox migration. It adds TWILIO_WHATSAPP and a server-only inbound timestamp table with RLS. It does not delete/backfill demo records. The migration runner applies every pending migration, so inspect migration history first. No migrations were run for this task.
4. Provide an operator-managed public HTTPS tunnel to the API for the demo. In Sandbox settings, set **When a message comes in** to `https://<API_HOST>/api/v1/webhooks/twilio/inbound`, method POST. Save it. Do not replace this with the frontend URL.
5. Each outbound message automatically sets its StatusCallback to `https://<API_HOST>/api/v1/webhooks/twilio/status?job=<OUTBOX_UUID>`. The query must survive proxying exactly. You do not manually invent a job UUID or configure a static status URL in place of this per-message callback.
6. Keep webhook form bodies and X-Twilio-Signature intact. Signature validation includes the exact public URL and every POST field. Duplicate/non-string fields fail closed. Never log Authorization, Auth Token, form bodies or recipient data. See [Twilio request validation](https://www.twilio.com/docs/usage/security).

## Start API and worker

From the repository root, after the preceding manual configuration/migration review:

```bash
npm run build -w @qevra/contracts
npm run dev:api
```

In separate terminals:

```bash
npm run dev:web
npm run dev:worker:whatsapp -w @qevra/api
```

Or build the API and run the compiled worker:

```bash
npm run build -w @qevra/api
npm run worker:whatsapp -w @qevra/api
```

These are manual commands, not processes started by this implementation. `npm run dev` does not start the delivery worker. Stop any previous provider worker before switching modes; each worker now claims/recoveries only its provider's channel. Switching providers is not an automatic replay of old jobs, and deliberate repeated queue events across mode changes can create separate channel histories.

## One-recipient smoke test

1. Start the configured API, and have the enrolled authorized recipient send a fresh text message to the Sandbox. The inbound webhook returns empty TwiML, so Qevra does not automatically reply. Confirm inbound verification succeeds without logging message text or the recipient number.
2. Use an isolated demo service with payment mode NONE. Create any preceding customers **without WhatsApp consent**, then join as the authorized recipient with their Indonesian mobile number and explicit consent. With four customers ahead there is no near reminder yet; advance until at most three are waiting ahead.
3. Start the worker if not running. Expect one near-turn custom text containing branch, name, queue number and people-ahead count. Call that ticket and expect the called-ticket message. These are the only real message types.
4. Inspect server-only delivery records: provider_message_id should be a Twilio SID. ACCEPTED/notification SENT means accepted by Twilio, not delivered. Signed sent/delivered/read callbacks update delivery_status; failed/undelivered/canceled map to failed. Read receipts depend on the recipient's settings. Refreshing the customer page does not enqueue another reminder.
5. A no-consent customer must not receive messages. A recipient without a verified recent inbound timestamp is skipped. A canceled/completed/expired job is suppressed before transport. Use mocked tests for expiry/error cases rather than fabricating database eligibility for real recipients.
6. Stop the worker after the demo and restore DISABLED if delivery should not remain active. Renew Sandbox enrollment and send another inbound text when needed. Check Twilio's current trial restrictions, usage charges and Sandbox limits; do not assume messages are free.

## Delivery and test safety

HTTP runs outside queue transactions. Claims, retries (five attempts maximum), stale-ticket suppression, event deduplication and graceful shutdown reuse the existing outbox. Only explicit HTTP 429 / Twilio 20429 rejection is retried. Timeouts, transport errors, malformed acceptance and server errors become AMBIGUOUS and are not automatically resent. No exactly-once guarantee is made.

Signed callbacks are deduplicated in whatsapp_receipts and correlate early responses using the outbox UUID; subsequent callbacks must match the known provider ID. Delivered/read statuses cannot regress to sent/failed. Queued/accepted/sending callbacks are acknowledged without falsely treating them as delivery. Errors after durable persistence can be retried idempotently. There is no incoming STOP processor or customer-facing consent-revocation screen; this demo requires an operator consent/support process. Incoming text is not stored, but recipient phone and original message timestamp are stored server-side; establish retention before wider use.

Safe automated command:

```bash
npm run test:whatsapp
```

It disables .env loading and runs Meta/Twilio unit tests with fabricated credentials, fake provider HTTP and local webhook listeners. No database is connected and no live messages are sent.

The previous database-test risk was real: claims and expired-lease recovery were global. They now filter by provider and accept an optional business scope; the existing integration suite passes its generated business ID to every worker. Manual transaction blocks now roll back before releasing connections and pool closure also runs when cleanup fails. This is hardening, **not approval to use a shared demo database**: fixtures are committed, process crashes can leave them, and a separately running real worker can still claim fixture jobs. Continue using a dedicated migrated test database with all real workers stopped. No database integration suite or hosted SQL write was run here. PostgreSQL runtime behavior and actual Sandbox callbacks remain manually unverified.

Primary implementation files: apps/api/src/modules/notifications/twilio-provider.ts, twilio-webhook.ts, outbox.ts, service.ts; apps/api/src/whatsapp-worker.ts; apps/api/src/config/whatsapp.ts; tests/twilio.test.ts.

Verification during implementation: workspace typecheck, strict test-file typecheck, ESLint and backend/frontend builds passed. Full safe regression run: 47 passed, 0 failed, 9 database suites skipped. Dedicated Meta/Twilio mocked tests: 15 passed. Frontend build used envDir=false to avoid reading real .env; it emitted existing Zod annotation warnings and an empty auth chunk because public Auth configuration was intentionally absent. This build does not establish configured browser/Auth runtime readiness. No real Sandbox smoke test or PostgreSQL execution was performed.
