-- Phase 1: schema only. Admission and state-transition operations are deferred.
BEGIN;

CREATE TYPE public.business_role AS ENUM ('OWNER', 'MANAGER', 'STAFF');
CREATE TYPE public.queue_status AS ENUM ('WAITING', 'CALLED', 'SERVING', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'NO_SHOW');
CREATE TYPE public.payment_mode AS ENUM ('NONE', 'DEPOSIT', 'FULL');
CREATE TYPE public.queue_session_status AS ENUM ('OPEN', 'PAUSED', 'CLOSED');
CREATE TYPE public.join_request_status AS ENUM ('PAYMENT_PENDING', 'ADMITTED', 'EXPIRED', 'CANCELLED');

CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_by uuid NOT NULL REFERENCES public.profiles(user_id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.business_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  user_id uuid NOT NULL REFERENCES public.profiles(user_id),
  role public.business_role NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, user_id),
  UNIQUE (business_id, id)
);

CREATE TABLE public.branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  public_slug text NOT NULL UNIQUE CHECK (public_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  timezone text NOT NULL DEFAULT 'Asia/Jakarta',
  address text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  description text,
  price_amount bigint NOT NULL DEFAULT 0 CHECK (price_amount >= 0),
  currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  estimated_duration_minutes integer NOT NULL CHECK (estimated_duration_minutes > 0),
  queue_prefix text NOT NULL CHECK (queue_prefix ~ '^[A-Z]{1,5}$'),
  payment_mode public.payment_mode NOT NULL DEFAULT 'NONE',
  deposit_amount bigint,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id) REFERENCES public.branches(business_id, id),
  UNIQUE (branch_id, queue_prefix),
  UNIQUE (business_id, branch_id, id),
  CHECK (
    (payment_mode = 'NONE' AND deposit_amount IS NULL) OR
    (payment_mode = 'DEPOSIT' AND deposit_amount IS NOT NULL AND deposit_amount > 0 AND deposit_amount <= price_amount) OR
    (payment_mode = 'FULL' AND deposit_amount IS NULL AND price_amount > 0)
  )
);

-- Scope tables are structural preparation; management endpoints come in Phase 2.
CREATE TABLE public.branch_members (
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  member_id uuid NOT NULL,
  PRIMARY KEY (branch_id, member_id),
  UNIQUE (business_id, branch_id, member_id),
  FOREIGN KEY (business_id, branch_id) REFERENCES public.branches(business_id, id),
  FOREIGN KEY (business_id, member_id) REFERENCES public.business_members(business_id, id)
);

CREATE TABLE public.staff_services (
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_id uuid NOT NULL,
  member_id uuid NOT NULL,
  PRIMARY KEY (service_id, member_id),
  FOREIGN KEY (business_id, branch_id, service_id) REFERENCES public.services(business_id, branch_id, id),
  FOREIGN KEY (business_id, branch_id, member_id) REFERENCES public.branch_members(business_id, branch_id, member_id)
);

CREATE TABLE public.service_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id, service_id) REFERENCES public.services(business_id, branch_id, id),
  UNIQUE (service_id, name),
  UNIQUE (business_id, branch_id, service_id, id)
);

CREATE TABLE public.queue_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_id uuid NOT NULL,
  business_date date NOT NULL,
  status public.queue_session_status NOT NULL DEFAULT 'OPEN',
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  next_order bigint NOT NULL DEFAULT 0 CHECK (next_order >= 0),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id, service_id) REFERENCES public.services(business_id, branch_id, id),
  UNIQUE (service_id, business_date),
  UNIQUE (business_id, branch_id, service_id, id),
  CHECK (closed_at IS NULL OR closed_at >= opened_at)
);

CREATE TABLE public.join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_id uuid NOT NULL,
  queue_session_id uuid NOT NULL,
  customer_auth_id uuid NOT NULL REFERENCES auth.users(id),
  customer_name text NOT NULL CHECK (length(trim(customer_name)) BETWEEN 1 AND 120),
  phone_e164 text CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_opt_in_at timestamptz,
  status public.join_request_status NOT NULL,
  payment_mode_snapshot public.payment_mode NOT NULL,
  price_snapshot bigint NOT NULL CHECK (price_snapshot >= 0),
  amount_due bigint NOT NULL CHECK (amount_due >= 0),
  currency text NOT NULL DEFAULT 'IDR' CHECK (currency = 'IDR'),
  expires_at timestamptz NOT NULL,
  admitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id, service_id, queue_session_id) REFERENCES public.queue_sessions(business_id, branch_id, service_id, id),
  UNIQUE (business_id, branch_id, service_id, queue_session_id, customer_auth_id, id),
  CHECK (expires_at > created_at),
  CHECK (whatsapp_opt_in_at IS NULL OR phone_e164 IS NOT NULL),
  CHECK ((status = 'ADMITTED') = (admitted_at IS NOT NULL)),
  CHECK (status <> 'PAYMENT_PENDING' OR payment_mode_snapshot <> 'NONE'),
  CHECK (
    (payment_mode_snapshot = 'NONE' AND amount_due = 0) OR
    (payment_mode_snapshot = 'DEPOSIT' AND amount_due > 0 AND amount_due <= price_snapshot) OR
    (payment_mode_snapshot = 'FULL' AND amount_due = price_snapshot AND amount_due > 0)
  )
);

CREATE TABLE public.queue_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_id uuid NOT NULL,
  queue_session_id uuid NOT NULL,
  join_request_id uuid NOT NULL UNIQUE,
  customer_auth_id uuid NOT NULL,
  sequence_number integer NOT NULL CHECK (sequence_number > 0),
  prefix_snapshot text NOT NULL CHECK (prefix_snapshot ~ '^[A-Z]{1,5}$'),
  queue_order bigint NOT NULL CHECK (queue_order > 0),
  status public.queue_status NOT NULL DEFAULT 'WAITING',
  counter_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  joined_at timestamptz NOT NULL DEFAULT now(),
  called_at timestamptz,
  serving_at timestamptz,
  completed_at timestamptz,
  skipped_at timestamptz,
  cancelled_at timestamptz,
  no_show_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, branch_id, service_id, queue_session_id, customer_auth_id, join_request_id)
    REFERENCES public.join_requests(business_id, branch_id, service_id, queue_session_id, customer_auth_id, id),
  FOREIGN KEY (business_id, branch_id, service_id, counter_id) REFERENCES public.service_counters(business_id, branch_id, service_id, id),
  UNIQUE (queue_session_id, sequence_number),
  UNIQUE (queue_session_id, queue_order),
  UNIQUE (business_id, id),
  CHECK (status NOT IN ('CALLED', 'SERVING') OR counter_id IS NOT NULL),
  CHECK (status <> 'CALLED' OR called_at IS NOT NULL),
  CHECK (status <> 'SERVING' OR serving_at IS NOT NULL),
  CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL),
  CHECK (status <> 'SKIPPED' OR skipped_at IS NOT NULL),
  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL),
  CHECK (status <> 'NO_SHOW' OR no_show_at IS NOT NULL)
);

CREATE TABLE public.queue_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  queue_ticket_id uuid NOT NULL,
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  from_status public.queue_status,
  to_status public.queue_status,
  actor_user_id uuid REFERENCES auth.users(id),
  actor_type text NOT NULL CHECK (actor_type IN ('CUSTOMER', 'STAFF', 'SYSTEM')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  FOREIGN KEY (business_id, queue_ticket_id) REFERENCES public.queue_tickets(business_id, id)
);

CREATE INDEX business_members_user_idx ON public.business_members(user_id, is_active);
CREATE INDEX branch_members_member_idx ON public.branch_members(member_id, branch_id);
CREATE INDEX services_tenant_idx ON public.services(business_id, branch_id);
CREATE INDEX join_requests_customer_idx ON public.join_requests(customer_auth_id, status);
CREATE INDEX queue_tickets_order_idx ON public.queue_tickets(queue_session_id, status, queue_order);
CREATE INDEX queue_tickets_customer_idx ON public.queue_tickets(customer_auth_id, status);
CREATE INDEX queue_events_ticket_idx ON public.queue_events(queue_ticket_id, occurred_at);
CREATE UNIQUE INDEX queue_tickets_counter_busy_idx ON public.queue_tickets(counter_id) WHERE status IN ('CALLED', 'SERVING');
CREATE UNIQUE INDEX queue_tickets_customer_active_idx ON public.queue_tickets(customer_auth_id, service_id) WHERE status IN ('WAITING', 'CALLED', 'SERVING');

CREATE FUNCTION public.set_updated_at() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- No browser grants or permissive policies. Express uses server-only pg credentials.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['profiles', 'businesses', 'business_members', 'branches', 'services', 'branch_members', 'staff_services', 'service_counters', 'queue_sessions', 'join_requests', 'queue_tickets', 'queue_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', table_name);
    IF table_name NOT IN ('branch_members', 'staff_services', 'queue_events') THEN
      EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', table_name);
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.set_updated_at() FROM PUBLIC;
COMMIT;
