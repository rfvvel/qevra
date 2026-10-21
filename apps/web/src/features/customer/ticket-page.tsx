import {TicketUpdates} from './ticket-updates';
import {useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import type {QueueStatus} from '@qevra/contracts';
import {useTicket} from './use-ticket';
import {customerRequest,customerError,CustomerError} from '../../lib/customer-api';
import {Panel,Button,ErrorNotice,Loading} from '../../components/ui';
const statusMessages:Record<QueueStatus,string>={
  WAITING:"You're in the queue.",CALLED:"It's your turn soon. Please proceed to the service location.",
  SERVING:'Your service has started.',COMPLETED:'Service completed.',
  SKIPPED:'You were skipped. Please contact staff or wait for requeue.',
  CANCELLED:'This queue ticket was cancelled.',NO_SHOW:'Marked as no-show.',
};
export function TicketPage(){const {ticketId=''}=useParams();return <TicketView key={ticketId} ticketId={ticketId}/>;}
function TicketView({ticketId}:{ticketId:string}){
  const {data,error,connected,refresh}=useTicket(ticketId);
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[actionError,setActionError]=useState<string|null>(null);
  const pending=useRef<{key:string;version:number}|null>(null),inFlight=useRef(false);
  async function cancel(){
    if(!data || inFlight.current)return;
    inFlight.current=true;setBusy(true);setActionError(null);
    pending.current??={key:crypto.randomUUID(),version:data.ticket.version};
    try{
      await customerRequest('/tickets/'+ticketId+'/cancel',{body:{expectedVersion:pending.current.version},key:pending.current.key});
      pending.current=null;setConfirm(false);refresh();
    }catch(e){setActionError(customerError(e));if(e instanceof CustomerError&&e.status<500){pending.current=null;setConfirm(false);refresh();}}
    finally{setBusy(false);inFlight.current=false;}
  }
  if(!data)return <div className="mx-auto max-w-lg"><ErrorNotice message={error}/>{error?<Button onClick={refresh}>Try again</Button>:<Loading/>}</div>;
  const {ticket,queue}=data;
  return <div className="mx-auto max-w-lg space-y-5">
    <div><p className="text-sm font-medium text-teal-800">{data.business.name}</p><h1 className="mt-1 text-2xl font-semibold">{data.service.name}</h1><p className="mt-1 text-sm text-slate-500">{data.branch.name}</p></div>
    <ErrorNotice message={error||actionError}/>
    {ticket.simulatedPayment&&<Panel><p className="font-semibold text-amber-900">SIMULASI PEMBAYARAN — TIDAK ADA UANG ASLI</p><p className="mt-2 text-sm">Tiket antrean aktif. Pembayaran tercatat sebagai MOCK, bukan uang yang diterima.</p></Panel>}
    <section className="rounded-2xl bg-teal-900 px-5 py-8 text-center text-white" aria-label="Your queue ticket">
      <p className="text-xs uppercase tracking-widest text-teal-100">Your number</p><p className="my-5 break-all text-6xl font-semibold tracking-tight sm:text-7xl" data-testid="queue-number">{ticket.queueNumber}</p>
      <p className="text-sm font-medium" data-testid="ticket-status">{ticket.status}</p><p className="mt-3 text-sm leading-relaxed text-teal-50" aria-live="polite">{statusMessages[ticket.status]}</p>
    </section>
    {ticket.status==='WAITING'&&<Panel><p className="text-xl font-semibold" data-testid="people-ahead">{queue.peopleAhead} {queue.peopleAhead===1?'person':'people'} ahead</p>
      <p className="mt-1 text-xs text-slate-500">Waiting customers before you; customers being served are shown below.</p>
      <p className="mt-5 text-lg font-medium">{queue.etaStatus==='AVAILABLE'?'Estimated wait: ~'+queue.estimatedWaitMinutes+' minutes':queue.sessionStatus==='CLOSED'?'The queue is closed. Please contact staff.':'Service is temporarily paused.'}</p>
      <p className="mt-2 text-xs leading-relaxed text-slate-500">This is an estimate, not an appointment time. Please stay nearby.</p>
    </Panel>}
    {queue.nowServing.length>0&&<Panel title="Currently being handled"><div className="flex flex-wrap gap-3">{queue.nowServing.map((number,index)=><span className="rounded-lg bg-slate-100 px-4 py-2 text-lg font-semibold" key={number+'-'+index}>{number}</span>)}</div></Panel>}
    <TicketUpdates ticketId={ticketId} notifications={data.notifications} mockAvailable={data.mockWhatsAppAvailable} refresh={refresh}/>
    <p className="text-center text-xs text-slate-500" role="status">{connected?'Updates are live.':'Updates will refresh automatically when connected.'}</p>
    {ticket.status==='WAITING'&&(confirm?<Panel title="Are you sure you want to leave the queue?"><p className="mb-4 text-sm text-slate-500">Your place will be released.</p><div className="flex flex-wrap gap-3"><Button disabled={busy} onClick={()=>void cancel()}>{busy?'Leaving…':'Yes, leave queue'}</Button><Button disabled={busy||pending.current!==null} onClick={()=>setConfirm(false)}>Keep my place</Button></div></Panel>:<Button className="min-h-12 w-full" onClick={()=>setConfirm(true)}>Leave queue</Button>)}
    <div className="flex flex-wrap justify-between gap-4 text-sm"><Link className="text-teal-800 underline" to={'/q/'+data.branch.publicSlug}>Back to services</Link><button className="text-slate-500 underline" onClick={refresh}>Refresh ticket</button></div>
    <p className="text-xs text-slate-500">Keep this link and use the same browser to return to your ticket.</p>
  </div>;
}
