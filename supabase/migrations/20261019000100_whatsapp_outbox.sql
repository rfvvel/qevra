BEGIN;
ALTER TYPE public.notification_channel ADD VALUE IF NOT EXISTS 'META_WHATSAPP';
-- No recipient plaintext is copied: resolve phone/consent from the owned join request.
CREATE TABLE public.whatsapp_outbox (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 business_id uuid NOT NULL,
 notification_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'READY' CHECK(status IN ('READY','SENDING','ACCEPTED','AMBIGUOUS','FAILED','SKIPPED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
 lease_until timestamptz,
 claim_token uuid,
 provider_message_id text UNIQUE CHECK(length(provider_message_id)<=250),
 delivery_status text CHECK(delivery_status IN ('sent','delivered','read','failed')),
 error_code text CHECK(error_code ~ '^[A-Z0-9_]{1,80}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(business_id,notification_id) REFERENCES public.notifications(business_id,id) ON DELETE CASCADE
);
CREATE INDEX whatsapp_outbox_ready_idx ON public.whatsapp_outbox(available_at,created_at) WHERE status='READY';
CREATE INDEX whatsapp_outbox_lease_idx ON public.whatsapp_outbox(lease_until) WHERE status='SENDING';
-- Sanitized durable receipt inbox: no raw payload, recipient, access token or message text.
CREATE TABLE public.whatsapp_receipts (
 event_hash text PRIMARY KEY CHECK(event_hash ~ '^[a-f0-9]{64}$'),
 provider_message_id text NOT NULL CHECK(length(provider_message_id) BETWEEN 1 AND 250),
 callback_id uuid,
 status text NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
 provider_timestamp bigint NOT NULL CHECK(provider_timestamp>=0),
 error_code text CHECK(error_code ~ '^[A-Z0-9_]{1,80}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX whatsapp_receipts_message_idx ON public.whatsapp_receipts(provider_message_id);
CREATE INDEX whatsapp_receipts_callback_idx ON public.whatsapp_receipts(callback_id);
ALTER TABLE public.whatsapp_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.whatsapp_outbox,public.whatsapp_receipts FROM anon,authenticated;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.whatsapp_outbox FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMIT;
