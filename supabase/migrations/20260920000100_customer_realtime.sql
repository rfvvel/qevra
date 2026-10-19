BEGIN;

CREATE INDEX queue_tickets_customer_session_idx ON public.queue_tickets(customer_auth_id, queue_session_id);

-- Narrow Realtime permission only; business tables stay inaccessible to browser roles.
CREATE FUNCTION public.customer_owns_queue_topic(requested_topic text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT coalesce((auth.jwt()->>'is_anonymous')::boolean, false)
    AND EXISTS (
      SELECT 1 FROM public.queue_tickets t
      WHERE t.customer_auth_id = auth.uid()
        AND requested_topic = 'queue:' || t.queue_session_id::text
    );
$$;
REVOKE ALL ON FUNCTION public.customer_owns_queue_topic(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customer_owns_queue_topic(text) TO authenticated;

CREATE POLICY qevra_customer_queue_broadcast_read ON realtime.messages
FOR SELECT TO authenticated USING (
  extension = 'broadcast'
  AND topic = (SELECT realtime.topic())
  AND public.customer_owns_queue_topic(topic)
);
-- No client INSERT policy: customers cannot publish queue signals.

CREATE FUNCTION public.broadcast_queue_refresh()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE target record;
BEGIN
  -- Counter occupancy can cross dates. Refresh other unresolved sessions for
  -- this service as well; only minimal revision metadata leaves PostgreSQL.
  FOR target IN
    SELECT s.id, s.revision FROM public.queue_sessions s
    WHERE s.service_id = NEW.service_id AND (
      s.id = NEW.id OR EXISTS (
        SELECT 1 FROM public.queue_tickets t WHERE t.queue_session_id=s.id
        AND t.status IN ('WAITING','CALLED','SERVING','SKIPPED')
      )
    )
  LOOP
    PERFORM realtime.send(
      jsonb_build_object('revision',target.revision::text,'generatedAt',clock_timestamp()),
      'queue_changed', 'queue:' || target.id::text, true
    );
  END LOOP;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.broadcast_queue_refresh() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER qevra_queue_refresh AFTER UPDATE OF revision ON public.queue_sessions
FOR EACH ROW WHEN (OLD.revision IS DISTINCT FROM NEW.revision)
EXECUTE FUNCTION public.broadcast_queue_refresh();

CREATE FUNCTION public.invalidate_queue_configuration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE scope_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'service_counters' THEN
    IF TG_OP = 'DELETE' THEN scope_id := OLD.service_id; ELSE scope_id := NEW.service_id; END IF;
    UPDATE public.queue_sessions SET revision=revision+1 WHERE service_id=scope_id;
  ELSIF TG_TABLE_NAME = 'services' THEN
    UPDATE public.queue_sessions SET revision=revision+1 WHERE service_id=NEW.id;
  ELSIF TG_TABLE_NAME = 'branches' THEN
    UPDATE public.queue_sessions SET revision=revision+1 WHERE branch_id=NEW.id;
  ELSE
    UPDATE public.queue_sessions SET revision=revision+1 WHERE business_id=NEW.id;
  END IF;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.invalidate_queue_configuration() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER qevra_counter_configuration AFTER INSERT OR UPDATE OR DELETE ON public.service_counters
FOR EACH ROW EXECUTE FUNCTION public.invalidate_queue_configuration();
CREATE TRIGGER qevra_service_configuration AFTER UPDATE ON public.services
FOR EACH ROW EXECUTE FUNCTION public.invalidate_queue_configuration();
CREATE TRIGGER qevra_branch_configuration AFTER UPDATE ON public.branches
FOR EACH ROW EXECUTE FUNCTION public.invalidate_queue_configuration();
CREATE TRIGGER qevra_business_configuration AFTER UPDATE ON public.businesses
FOR EACH ROW EXECUTE FUNCTION public.invalidate_queue_configuration();
COMMIT;
