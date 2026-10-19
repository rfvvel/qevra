import type {PoolClient} from 'pg';
import {BusinessRole,type AnalyticsQuery,type AnalyticsDashboard,type AnalyticsMetrics} from '@qevra/contracts';
import {businessScope,allow,missing} from '../configuration/access.js';

const metricSql=`count(*)::int AS joined,
 count(*) FILTER(WHERE status='COMPLETED')::int AS completed,
 count(*) FILTER(WHERE status='CANCELLED')::int AS cancelled,
 count(*) FILTER(WHERE status='NO_SHOW')::int AS "noShow",
 avg(wait_minutes)::float8 AS "averageWaitMinutes",
 avg(service_minutes)::float8 AS "averageServiceMinutes",
 count(wait_minutes)::int AS "waitSamples",count(service_minutes)::int AS "serviceSamples"`;

// One statement produces all aggregates from the same PostgreSQL snapshot.
// Lifecycle events are joined once as a set, never fetched ticket by ticket.
const aggregateSql=`
WITH selected_services AS (
 SELECT s.id,s.branch_id,s.name,b.timezone,
  (CURRENT_TIMESTAMP AT TIME ZONE b.timezone)::date AS today,
  s.is_active AND b.is_active AND biz.is_active AS active
 FROM public.services s JOIN public.branches b ON b.id=s.branch_id
 JOIN public.businesses biz ON biz.id=s.business_id
 WHERE s.business_id=$1 AND s.branch_id=ANY($2::uuid[])
 AND ($3::uuid IS NULL OR s.branch_id=$3) AND ($4::uuid IS NULL OR s.id=$4)
), cohort AS MATERIALIZED (
 SELECT t.id,t.status,t.joined_at,t.called_at AS recorded_called_at,t.service_id,t.branch_id,s.timezone
 FROM selected_services s JOIN public.queue_sessions q ON q.service_id=s.id
 JOIN public.queue_tickets t ON t.queue_session_id=q.id
 WHERE q.business_id=$1 AND q.business_date BETWEEN s.today-($5::int-1) AND s.today
 AND t.joined_at<=CURRENT_TIMESTAMP
), events AS MATERIALIZED (
 SELECT e.queue_ticket_id,e.event_type,e.occurred_at
 FROM public.queue_events e JOIN cohort c ON c.id=e.queue_ticket_id
 WHERE e.occurred_at>=c.joined_at AND e.occurred_at<=CURRENT_TIMESTAMP
 AND e.event_type IN ('TICKET_REQUEUED','TICKET_CALLED','SERVICE_STARTED','SERVICE_COMPLETED')
), resets AS (
 SELECT c.id,max(e.occurred_at) FILTER(WHERE e.event_type='TICKET_REQUEUED') AS reset_at
 FROM cohort c LEFT JOIN events e ON e.queue_ticket_id=c.id GROUP BY c.id
), starts AS (
 SELECT r.id,r.reset_at,min(e.occurred_at) FILTER(WHERE e.event_type='SERVICE_STARTED') AS started_at
 FROM resets r LEFT JOIN events e ON e.queue_ticket_id=r.id AND (r.reset_at IS NULL OR e.occurred_at>=r.reset_at)
 GROUP BY r.id,r.reset_at
), times AS (
 SELECT s.id,s.started_at,s.reset_at,
 min(e.occurred_at) FILTER(WHERE e.event_type='TICKET_CALLED' AND (s.started_at IS NULL OR e.occurred_at<=s.started_at)) AS called_at,
 min(e.occurred_at) FILTER(WHERE e.event_type='SERVICE_COMPLETED' AND e.occurred_at>=s.started_at) AS completed_at
 FROM starts s LEFT JOIN events e ON e.queue_ticket_id=s.id AND (s.reset_at IS NULL OR e.occurred_at>=s.reset_at)
 GROUP BY s.id,s.started_at,s.reset_at
), measured AS MATERIALIZED (
 SELECT c.*,
 extract(epoch FROM (coalesce(t.called_at,
 CASE WHEN c.status<>'WAITING' AND c.recorded_called_at>=c.joined_at
 AND c.recorded_called_at<=CURRENT_TIMESTAMP
 AND (t.reset_at IS NULL OR c.recorded_called_at>=t.reset_at)
 AND (t.started_at IS NULL OR c.recorded_called_at<=t.started_at)
 THEN c.recorded_called_at END)-c.joined_at))/60 AS wait_minutes,
 CASE WHEN c.status='COMPLETED' THEN extract(epoch FROM (t.completed_at-t.started_at))/60 END AS service_minutes
 FROM cohort c JOIN times t ON t.id=c.id
), summary AS (SELECT ${metricSql} FROM measured),
 service_metrics AS (SELECT service_id AS id,${metricSql} FROM measured GROUP BY service_id),
 branch_metrics AS (SELECT branch_id AS id,${metricSql} FROM measured GROUP BY branch_id),
 hourly AS (SELECT extract(hour FROM joined_at AT TIME ZONE timezone)::int AS hour,count(*)::int AS joined FROM cohort GROUP BY 1),
 volume AS (SELECT hour,coalesce(h.joined,0) AS joined FROM generate_series(0,23) hour LEFT JOIN hourly h USING(hour)),
 live AS (
 SELECT count(*) FILTER(WHERE t.status='WAITING')::int AS waiting,
 count(*) FILTER(WHERE t.status='CALLED')::int AS called,
 count(*) FILTER(WHERE t.status='SERVING')::int AS serving
 FROM selected_services s JOIN public.queue_sessions q ON q.service_id=s.id AND q.business_date=s.today
 JOIN public.queue_tickets t ON t.queue_session_id=q.id
 WHERE s.active AND q.status IN ('OPEN','PAUSED')
)
SELECT CURRENT_TIMESTAMP AS "generatedAt",
 (SELECT row_to_json(summary) FROM summary) AS summary,
 (SELECT row_to_json(live) FROM live) AS live,
 (SELECT json_agg(volume ORDER BY hour) FROM volume) AS volume,
 (SELECT row_to_json(h) FROM (SELECT * FROM hourly ORDER BY joined DESC,hour ASC LIMIT 1) h) AS "busiestHour",
 coalesce((SELECT json_agg(service_metrics) FROM service_metrics),'[]') AS services,
 coalesce((SELECT json_agg(branch_metrics) FROM branch_metrics),'[]') AS branches
`;
const empty:AnalyticsMetrics={joined:0,completed:0,cancelled:0,noShow:0,averageWaitMinutes:null,averageServiceMinutes:null,waitSamples:0,serviceSamples:0};
export async function dashboard(client:PoolClient,businessId:string,userId:string,query:AnalyticsQuery):Promise<AnalyticsDashboard>{
 const scope=await businessScope(client,businessId,userId,false);
 allow(scope,[BusinessRole.OWNER,BusinessRole.MANAGER]);
 const days=query.range==='LAST_30_DAYS'?30:query.range==='LAST_7_DAYS'?7:1;
 const branches=(await client.query<AnalyticsDashboard['branches'][number]>(`
 SELECT b.id,b.name,b.timezone,
 ((CURRENT_TIMESTAMP AT TIME ZONE b.timezone)::date-($4::int-1))::text AS "from",
 (CURRENT_TIMESTAMP AT TIME ZONE b.timezone)::date::text AS "to"
 FROM public.branches b WHERE b.business_id=$1
 AND ($2::boolean OR EXISTS(SELECT 1 FROM public.branch_members m WHERE m.business_id=$1 AND m.branch_id=b.id AND m.member_id=$3))
 ORDER BY b.name,b.id`,[businessId,scope.role===BusinessRole.OWNER,scope.memberId,days])).rows;
 if(query.branchId&&!branches.some(b=>b.id===query.branchId))throw missing();
 const branchIds=branches.map(b=>b.id);
 const services=(await client.query<AnalyticsDashboard['services'][number]>(`
 SELECT id,name,branch_id AS "branchId" FROM public.services WHERE business_id=$1 AND branch_id=ANY($2::uuid[]) ORDER BY name,id`,[businessId,branchIds])).rows;
 if(query.serviceId&&!services.some(s=>s.id===query.serviceId&&(!query.branchId||s.branchId===query.branchId)))throw missing();
 const result=(await client.query(aggregateSql,[businessId,branchIds,query.branchId??null,query.serviceId??null,days])).rows[0];
 const selectedServices=services.filter(s=>(!query.branchId||s.branchId===query.branchId)&&(!query.serviceId||s.id===query.serviceId));
 const selectedBranches=branches.filter(b=>(!query.branchId||b.id===query.branchId)&&(!query.serviceId||selectedServices.some(s=>s.branchId===b.id)));
 const byService=new Map<string,AnalyticsMetrics>(result.services.map((m:AnalyticsMetrics&{id:string})=>[m.id,m]));
 const byBranch=new Map<string,AnalyticsMetrics>(result.branches.map((m:AnalyticsMetrics&{id:string})=>[m.id,m]));
 return {generatedAt:result.generatedAt.toISOString(),range:query.range,branches,services,summary:result.summary,live:result.live,
 volume:result.volume,busiestHour:result.busiestHour,
 byService:selectedServices.map(s=>({...empty,...byService.get(s.id),...s})),
 byBranch:selectedBranches.map(b=>({...empty,...byBranch.get(b.id),id:b.id,name:b.name}))};
}
