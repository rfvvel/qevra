BEGIN;
CREATE TYPE public.payment_status AS ENUM ('PENDING','PAID','FAILED','EXPIRED','REFUNDED');
ALTER TYPE public.join_request_status ADD VALUE IF NOT EXISTS 'RECONCILIATION_REQUIRED';
ALTER TABLE public.join_requests ADD COLUMN reconciliation_reason text;
ALTER TABLE public.join_requests ADD CONSTRAINT join_requests_business_identity UNIQUE (business_id,id);
CREATE UNIQUE INDEX join_requests_one_pending_payment_idx ON public.join_requests(customer_auth_id,service_id) WHERE status='PAYMENT_PENDING';

CREATE TABLE public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  join_request_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  provider_reference text NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 160),
  status public.payment_status NOT NULL DEFAULT 'PENDING',
  amount bigint NOT NULL CHECK (amount>0),
  currency text NOT NULL DEFAULT 'IDR' CHECK (currency='IDR'),
  is_settlement boolean NOT NULL DEFAULT false,
  paid_at timestamptz,
  expires_at timestamptz NOT NULL,
  failure_code text,
  reconciliation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id,join_request_id) REFERENCES public.join_requests(business_id,id),
  UNIQUE (provider,provider_reference),
  UNIQUE (business_id,id,join_request_id),
  CHECK ((status IN ('PAID','REFUNDED')) = (paid_at IS NOT NULL)),
  CHECK (NOT is_settlement OR status IN ('PAID','REFUNDED')),
  CHECK (expires_at>created_at)
);
CREATE UNIQUE INDEX payments_one_settlement_idx ON public.payments(join_request_id) WHERE is_settlement;
CREATE UNIQUE INDEX payments_one_pending_attempt_idx ON public.payments(join_request_id) WHERE status='PENDING';
CREATE INDEX payments_request_history_idx ON public.payments(join_request_id,created_at DESC,id DESC);
CREATE TABLE public.payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  join_request_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  provider text NOT NULL,
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 200),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  from_status public.payment_status,
  to_status public.payment_status NOT NULL,
  actor_user_id uuid REFERENCES auth.users(id),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=2048),
  FOREIGN KEY (business_id,payment_id,join_request_id) REFERENCES public.payments(business_id,id,join_request_id),
  UNIQUE (provider,provider_event_id)
);
CREATE INDEX payment_events_payment_idx ON public.payment_events(payment_id,occurred_at,id);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payments,public.payment_events FROM anon,authenticated;
REVOKE UPDATE,DELETE ON public.payment_events FROM service_role;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Defense in depth: even a different application caller cannot insert a paid
-- ticket without a recorded settlement matching the immutable checkout amount.
CREATE FUNCTION public.require_ticket_settlement()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.join_requests j WHERE j.id=NEW.join_request_id AND j.payment_mode_snapshot<>'NONE')
    AND NOT EXISTS (
      SELECT 1 FROM public.payments p JOIN public.join_requests j ON j.id=p.join_request_id
      WHERE p.join_request_id=NEW.join_request_id AND p.business_id=NEW.business_id
        AND p.status='PAID' AND p.is_settlement AND p.amount=j.amount_due AND p.currency=j.currency
    )
  THEN RAISE EXCEPTION 'A verified payment settlement is required.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.require_ticket_settlement() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER queue_ticket_requires_settlement BEFORE INSERT ON public.queue_tickets
FOR EACH ROW EXECUTE FUNCTION public.require_ticket_settlement();
COMMIT;
