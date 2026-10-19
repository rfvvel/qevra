BEGIN;
-- Business/date cohorts; existing ticket(session,status,order) and event(ticket,time)
-- indexes already support the two downstream joins.
CREATE INDEX queue_sessions_analytics_date_idx
 ON public.queue_sessions(business_id,business_date,branch_id,service_id);
COMMIT;
