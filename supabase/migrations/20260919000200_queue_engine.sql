BEGIN;

-- READY is a non-paid join intent; it is not a ticket and has no queue number.
ALTER TYPE public.join_request_status ADD VALUE IF NOT EXISTS 'READY';
ALTER TABLE public.join_requests ADD CONSTRAINT join_requests_ready_is_free
  CHECK (status::text <> 'READY' OR payment_mode_snapshot = 'NONE');

ALTER TABLE public.queue_sessions ADD CONSTRAINT queue_sessions_business_identity UNIQUE (business_id, id);
ALTER TABLE public.queue_tickets ADD CONSTRAINT queue_tickets_session_identity UNIQUE (business_id, queue_session_id, id);
ALTER TABLE public.queue_events ADD COLUMN queue_session_id uuid;
UPDATE public.queue_events e SET queue_session_id = t.queue_session_id
  FROM public.queue_tickets t WHERE t.business_id = e.business_id AND t.id = e.queue_ticket_id;
ALTER TABLE public.queue_events ALTER COLUMN queue_session_id SET NOT NULL;
ALTER TABLE public.queue_events ALTER COLUMN queue_ticket_id DROP NOT NULL;
ALTER TABLE public.queue_events ADD COLUMN from_session_status public.queue_session_status;
ALTER TABLE public.queue_events ADD COLUMN to_session_status public.queue_session_status;
ALTER TABLE public.queue_events ADD CONSTRAINT queue_events_session_fk
  FOREIGN KEY (business_id, queue_session_id) REFERENCES public.queue_sessions(business_id, id);
ALTER TABLE public.queue_events ADD CONSTRAINT queue_events_ticket_session_fk
  FOREIGN KEY (business_id, queue_session_id, queue_ticket_id) REFERENCES public.queue_tickets(business_id, queue_session_id, id);
ALTER TABLE public.queue_events ADD CONSTRAINT queue_events_target_check CHECK (
  (queue_ticket_id IS NULL AND from_status IS NULL AND to_status IS NULL AND to_session_status IS NOT NULL) OR
  (queue_ticket_id IS NOT NULL AND from_session_status IS NULL AND to_session_status IS NULL)
);
ALTER TABLE public.queue_events ADD CONSTRAINT queue_events_metadata_size CHECK (octet_length(metadata::text) <= 2048);
CREATE INDEX queue_events_session_history_idx ON public.queue_events(queue_session_id, occurred_at DESC, id DESC);

CREATE TABLE public.queue_command_keys (
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  idempotency_key uuid NOT NULL,
  business_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  service_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_user_id, idempotency_key),
  FOREIGN KEY (business_id, branch_id, service_id) REFERENCES public.services(business_id, branch_id, id)
);
ALTER TABLE public.queue_command_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.queue_command_keys FROM anon, authenticated;
-- Runtime code only appends events; no edit/delete API exists.
REVOKE UPDATE, DELETE ON public.queue_events FROM anon, authenticated, service_role;
CREATE INDEX queue_command_keys_service_idx ON public.queue_command_keys(service_id, created_at);
COMMIT;
