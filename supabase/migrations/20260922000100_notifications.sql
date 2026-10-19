BEGIN;
CREATE TYPE public.notification_channel AS ENUM ('IN_APP','MOCK_WHATSAPP');
CREATE TYPE public.notification_status AS ENUM ('PENDING','SENT','FAILED','SKIPPED');
CREATE TYPE public.notification_type AS ENUM ('QUEUE_JOINED','NEAR_TURN','YOUR_TURN','SERVICE_STARTED','SERVICE_COMPLETED','QUEUE_CANCELLED','QUEUE_SKIPPED','QUEUE_NO_SHOW');
ALTER TABLE public.queue_tickets ADD CONSTRAINT queue_tickets_notification_owner UNIQUE(business_id,id,customer_auth_id);
ALTER TABLE public.queue_events ADD CONSTRAINT queue_events_business_identity UNIQUE(business_id,id);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  queue_ticket_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  channel public.notification_channel NOT NULL,
  type public.notification_type NOT NULL,
  status public.notification_status NOT NULL DEFAULT 'PENDING',
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  message text NOT NULL CHECK(length(message) BETWEEN 1 AND 1000),
  dedupe_key text NOT NULL CHECK(length(dedupe_key) BETWEEN 1 AND 200),
  recipient_masked text,
  failure_code text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(business_id,queue_ticket_id,customer_user_id) REFERENCES public.queue_tickets(business_id,id,customer_auth_id) ON DELETE CASCADE,
  FOREIGN KEY(business_id,source_event_id) REFERENCES public.queue_events(business_id,id) ON DELETE CASCADE,
  UNIQUE(channel,dedupe_key),
  UNIQUE(business_id,id),
  CHECK((status='SENT')=(sent_at IS NOT NULL)),
  CHECK(read_at IS NULL OR (channel='IN_APP' AND status='SENT')),
  CHECK(recipient_masked IS NULL OR (channel='MOCK_WHATSAPP' AND recipient_masked ~ '^\+62\*+[0-9]{4}$'))
);
CREATE INDEX notifications_customer_ticket_idx ON public.notifications(customer_user_id,queue_ticket_id,created_at DESC,id DESC);
CREATE TABLE public.notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  queue_event_id uuid NOT NULL,
  notification_id uuid,
  kind text NOT NULL CHECK(kind IN ('SENT','FAILED','SKIPPED','GENERATION_FAILED')),
  code text CHECK(code ~ '^[A-Z_]{1,80}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(business_id,queue_event_id) REFERENCES public.queue_events(business_id,id) ON DELETE CASCADE,
  FOREIGN KEY(business_id,notification_id) REFERENCES public.notifications(business_id,id) ON DELETE CASCADE
);
CREATE INDEX notification_events_notification_idx ON public.notification_events(notification_id,created_at);
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notifications,public.notification_events FROM anon,authenticated;
REVOKE UPDATE,DELETE ON public.notification_events FROM service_role;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Consent already exists on join_requests as whatsapp_opt_in_at, with a phone-required CHECK.
COMMIT;
