BEGIN;
ALTER TYPE public.notification_channel ADD VALUE IF NOT EXISTS 'TWILIO_WHATSAPP';
-- Original provider timestamp, not webhook arrival time. Duplicates never extend a window.
CREATE TABLE public.twilio_inbound_messages (
 account_sid text NOT NULL CHECK(account_sid ~ '^AC[0-9a-fA-F]{32}$'),
 message_sid text NOT NULL CHECK(message_sid ~ '^SM[0-9a-fA-F]{32}$'),
 sender text NOT NULL,
 phone_e164 text NOT NULL CHECK(phone_e164 ~ '^\+628[0-9]{7,11}$'),
 sent_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(account_sid,message_sid)
);
CREATE INDEX twilio_inbound_window_idx ON public.twilio_inbound_messages(account_sid,sender,phone_e164,sent_at DESC);
ALTER TABLE public.twilio_inbound_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.twilio_inbound_messages FROM anon,authenticated;
COMMIT;
