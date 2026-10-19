import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
// Deterministic, isolated development histories. Only test harnesses import this file.
export function analyticsFixture(ownerId?:string){
 const owner=ownerId??randomUUID(),manager=randomUUID(),staff=randomUUID(),outsider=randomUUID(),anonymous=randomUUID();
 const business=randomUUID(),otherBusiness=randomUUID(),branches=[randomUUID(),randomUUID()],services=[randomUUID(),randomUUID(),randomUUID(),randomUUID()];
 const users=[manager,staff,outsider,anonymous,...Array.from({length:12},()=>randomUUID())];
 if(!ownerId)users.push(owner);
 let createdProfile=false;
 async function seed(c:PoolClient){
  for(const id of users)await c.query('INSERT INTO auth.users(id,is_anonymous) VALUES($1,$2)',[id,id===anonymous||!([owner,manager,staff,outsider].includes(id))]);
  for(const id of [owner,manager,staff,outsider]){
   const result=await c.query("INSERT INTO public.profiles(user_id,display_name) VALUES($1,'Analytics test') ON CONFLICT DO NOTHING",[id]);
   if(id===owner)createdProfile=!!result.rowCount;
  }
  for(const [id,user]of [[business,owner],[otherBusiness,outsider]])await c.query("INSERT INTO public.businesses(id,name,slug,created_by) VALUES($1,'Analytics Demo',$2,$3)",[id,'analytics-'+id,user]);
  for(const [id,user,role]of [[business,owner,'OWNER'],[business,manager,'MANAGER'],[business,staff,'STAFF'],[otherBusiness,outsider,'OWNER']])await c.query('INSERT INTO public.business_members(business_id,user_id,role) VALUES($1,$2,$3)',[id,user,role]);
  for(let i=0;i<2;i++)await c.query("INSERT INTO public.branches(id,business_id,name,public_slug,timezone) VALUES($1,$2,$3,$4,'Asia/Jakarta')",[branches[i],business,i?'Riverside':'Central','analytics-'+branches[i]]);
  await c.query('INSERT INTO public.branch_members(business_id,branch_id,member_id) SELECT $1,$2,id FROM public.business_members WHERE business_id=$1 AND user_id=ANY($3::uuid[])',[business,branches[0],[manager,staff]]);
  for(let i=0;i<4;i++)await c.query("INSERT INTO public.services(id,business_id,branch_id,name,price_amount,estimated_duration_minutes,queue_prefix,payment_mode) VALUES($1,$2,$3,$4,0,20,$5,'NONE')",[services[i],business,branches[i<2?0:1],['Haircut','Hair Coloring','Consultation','Empty service'][i],['H','C','D','E'][i]]);
  const specs=[
   {s:0,status:'COMPLETED',h:9,events:[['TICKET_CALLED',10],['SERVICE_STARTED',12],['SERVICE_COMPLETED',32]]},
   {s:0,status:'COMPLETED',h:9,events:[['TICKET_CALLED',5],['TICKET_SKIPPED',6],['TICKET_REQUEUED',10],['TICKET_CALLED',30],['SERVICE_STARTED',35],['SERVICE_COMPLETED',75]]},
   {s:0,status:'CANCELLED',h:10,events:[['TICKET_CANCELLED',5]]},
   {s:0,status:'NO_SHOW',h:10,events:[['TICKET_CALLED',20],['TICKET_NO_SHOW',25]]},
   {s:0,status:'WAITING',h:11,events:[]},
   {s:0,status:'CALLED',h:11,events:[['TICKET_CALLED',15]]},
   {s:0,status:'SKIPPED',h:12,events:[['TICKET_CALLED',8],['TICKET_SKIPPED',9]]},
   // Invalid service chronology must not enter the average.
   {s:0,status:'COMPLETED',h:12,events:[['TICKET_CALLED',12],['SERVICE_COMPLETED',40],['SERVICE_STARTED',50]]},
   {s:1,status:'COMPLETED',h:9,events:[['TICKET_CALLED',5],['SERVICE_STARTED',6],['SERVICE_COMPLETED',16]]},
   {s:2,status:'COMPLETED',h:14,events:[['TICKET_CALLED',25],['SERVICE_STARTED',30],['SERVICE_COMPLETED',80]]},
   {s:0,status:'WAITING',h:0,days:0,events:[]},
   {s:1,status:'COMPLETED',h:9,days:20,events:[['TICKET_CALLED',10],['SERVICE_STARTED',12],['SERVICE_COMPLETED',32]]},
  ];
  for(let i=0;i<specs.length;i++){
   const spec=specs[i]!,service=services[spec.s],branch=branches[spec.s<2?0:1],ticket=randomUUID(),request=randomUUID(),user=users[4+i];
   const session=(await c.query("INSERT INTO public.queue_sessions(business_id,branch_id,service_id,business_date) VALUES($1,$2,$3,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Jakarta')::date-$4::int) ON CONFLICT(service_id,business_date) DO UPDATE SET status='OPEN' RETURNING id,business_date::text",[business,branch,service,spec.days??1])).rows[0];
   const joined=(await c.query("SELECT ($1::date+$2::int*interval '1 hour') AT TIME ZONE 'Asia/Jakarta' AS value",[session.business_date,spec.h])).rows[0].value as Date;
   const at=(minutes:number)=>new Date(joined.getTime()+minutes*60000);
   const counter=randomUUID();await c.query("INSERT INTO public.service_counters(id,business_id,branch_id,service_id,name) VALUES($1,$2,$3,$4,$5)",[counter,business,branch,service,'Fixture '+i]);
   await c.query("INSERT INTO public.join_requests(id,business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,status,payment_mode_snapshot,price_snapshot,amount_due,expires_at,admitted_at,created_at) VALUES($1,$2,$3,$4,$5,$6,'Fixture customer','ADMITTED','NONE',0,0,$7,$8,$8)",[request,business,branch,service,session.id,user,at(120),joined]);
   await c.query(`INSERT INTO public.queue_tickets(id,business_id,branch_id,service_id,queue_session_id,join_request_id,customer_auth_id,sequence_number,prefix_snapshot,queue_order,status,joined_at,called_at,serving_at,completed_at,skipped_at,cancelled_at,no_show_at,counter_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::int,'H',$8::int,$9,$10,$11,$13,$13,$13,$13,$13,$12)`,[ticket,business,branch,service,session.id,request,user,i+1,spec.status,joined,spec.events.some(e=>e[0]==='TICKET_CALLED')?at(Number(spec.events.filter(e=>e[0]==='TICKET_CALLED').at(-1)![1])):spec.status==='WAITING'||spec.status==='CANCELLED'?null:at(90),['CALLED','SERVING'].includes(spec.status)?counter:null,at(90)]);
   for(const [kind,minutes]of [['TICKET_ADMITTED',0],...spec.events])await c.query("INSERT INTO public.queue_events(business_id,queue_session_id,queue_ticket_id,event_type,actor_type,occurred_at) VALUES($1,$2,$3,$4,'SYSTEM',$5)",[business,session.id,ticket,kind,at(Number(minutes))]);
  }
 }
 async function cleanup(c:PoolClient){
  for(const table of ['queue_command_keys','queue_events','queue_tickets','payment_events','payments','join_requests','queue_sessions','service_counters','staff_services','branch_members','services','business_members','branches'])await c.query('DELETE FROM public.'+table+' WHERE business_id=ANY($1::uuid[])',[[business,otherBusiness]]);
  await c.query('DELETE FROM public.businesses WHERE id=ANY($1::uuid[])',[[business,otherBusiness]]);
  await c.query('DELETE FROM public.profiles WHERE user_id=ANY($1::uuid[])',[[manager,staff,outsider,...(createdProfile?[owner]:[])]]);
  await c.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[users]);
 }
 return {owner,manager,staff,outsider,anonymous,business,otherBusiness,branches,services,seed,cleanup};
}
