# Twilio inbound HTTP 400

## What the source proves

The Express app mounts the Twilio router after Helmet/CORS and before the global
JSON parser. It uses a dedicated URL-encoded form parser. CORS does not authenticate
server-to-server requests. Twilio's additional fields participate in signature
validation; they are not removed or rejected just for being unknown.

Before this change, inbound `sendStatus(400)` produced exactly text/plain
`Bad Request` for one of four conditions: noncanonical original URL, mismatched
`To`, unsupported Indonesian `From`, or non-SM MessageSid. This branch was reached
only after signature and account verification. The status callback had a separate
plain 400 path. Signature/account failure produced 403, and database/provider
exceptions reached the JSON error handler. Some form-parser failures incorrectly
fell through to generic 500; they now return explicit sanitized 400/413/415.

Thus payload/configuration rejection is the leading explanation for a plain 400
from the inbound route, but the failing field is not yet known. A Railway request
ID alone does not prove Express handled a request; an edge-generated error remains
possible. No deployed payload, credentials, remote logs or records were accessed.

## After deploying

All requests reaching this router now receive `X-Qevra-Webhook: twilio-v1`.
Failures return JSON `{"error":{"code":"TWILIO_<CODE>"}}` and log
`{"event":"twilio_webhook_rejected","code":"<CODE>"}`. Database failures also include
the existing sanitized database category/code. No phone, form, signature, token,
URL, message SID or raw exception is logged.

| Code | Meaning and private check |
| --- | --- |
| METHOD / CONTENT_TYPE | Configure POST with application/x-www-form-urlencoded. |
| BODY_PARSE / BODY_LIMIT / BODY_ENCODING | Invalid body stream, >32KB/>100 fields, or unsupported charset/encoding. Keep parser limits; inspect request format privately. |
| FORM_FIELDS | Missing parsed form or duplicate/non-string fields. Do not flatten duplicate parameters before signature verification. |
| SIGNATURE | Compare configured public HTTPS origin and exact webhook URL, then account/token association privately. Forwarded host/protocol are intentionally ignored. Do not log or disable signatures. |
| ACCOUNT | Valid signature but AccountSid differs from configured account. Check account/subaccount association. |
| INBOUND_URL | Exact path must be `/api/v1/webhooks/twilio/inbound`, without trailing slash or query. Signature verification still uses the complete original URL first. |
| DESTINATION | Compare signed `To` with TWILIO_WHATSAPP_FROM privately, including `whatsapp:` prefix and Sandbox number. Do not substitute a customer's phone. |
| SENDER | Signed From must be `whatsapp:+628...`, matching the existing Indonesian mobile rule. No recipient allowlist exists. |
| MESSAGE_SID | Missing/unsupported MessageSid format. Current code **and existing database constraint** accept SM plus 32 hexadecimal characters. MM media-message IDs are a known limitation; do not rewrite IDs to SM. Supporting MM requires a coordinated schema/provider change, not a signature bypass. |
| INBOUND_VERIFICATION | Twilio REST lookup failed or did not verify the account, direction, sender, recipient and original timestamp. Returns 502; no database write occurs. |
| DATABASE | Verified inbound could not be persisted; returns 503 with safe database diagnostics. Database health alone does not establish insert privileges/constraints. |

Correct URL:
`https://qevraapi-production.up.railway.app/api/v1/webhooks/twilio/inbound`

TWILIO_WEBHOOK_ORIGIN is the same HTTPS origin without the path or trailing slash.
No new environment variables are introduced. Change configuration only after the
diagnostic identifies the mismatch. For a plain 400 without the new marker after
deploying this commit, check Railway's deployed commit and HTTP edge logs privately;
do not assume the signature failed.

## Verification and safeguards

Offline tests exercise the real createApp middleware stack, form encoding of plus
signs/Unicode/extra fields, proxy headers, signed SM requests and retries,
malformed forms, missing/tampered signatures, each payload rejection, provider
failure and database failure. Twilio REST and transaction callbacks are mocked.
No hosted database tests or live messages are needed for this patch.

Successful inbound requests still retrieve the original Twilio resource before
opening a transaction, store no message body and use ON CONFLICT DO NOTHING.
Replay retains the original timestamp. WhatsApp consent and the 24-hour sending
window are unchanged; inbound persistence is not itself queue opt-in.

References: [Twilio form parameters](https://www.twilio.com/docs/messaging/guides/webhook-request),
[request signing](https://www.twilio.com/docs/usage/security).
