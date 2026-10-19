import {useCallback,useEffect,useRef,useState} from 'react';
import {useParams,Link} from 'react-router-dom';
import type {QueueSnapshot,QueueTicketDto,QueueHistory,QueueCommandResult,TicketAction} from '@qevra/contracts';
import {request,errorMessage,ApiError} from '../../lib/configuration-api';
import {PageTitle,Panel,Button,ErrorNotice,Field,Loading} from '../../components/ui';
type Command={path:string;body:unknown;key:string};
export function QueuePage(){
  const {businessId,branchId,serviceId}=useParams();
  return <QueueWorkspace key={[businessId,branchId,serviceId].join('/')} />;
}
function QueueWorkspace(){
  const {businessId,branchId,serviceId}=useParams();
  const path='/businesses/'+businessId+'/branches/'+branchId+'/services/'+serviceId;
  const [data,setData]=useState<QueueSnapshot|null>(null),[history,setHistory]=useState<QueueHistory|null>(null);
  const [error,setError]=useState<string|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [counterId,setCounterId]=useState(''),[reason,setReason]=useState('');
  const [retry,setRetry]=useState<Command|null>(null);
  const inFlight=useRef(false);
  const refresh=useCallback(async()=>{
    const [next,events]=await Promise.all([request<QueueSnapshot>(path+'/queue'),request<QueueHistory>(path+'/history?limit=20')]);
    setData(next);setHistory(events);
  },[path]);
  useEffect(()=>{
    let alive=true;
    const load=async()=>{try{const [next,events]=await Promise.all([request<QueueSnapshot>(path+'/queue'),request<QueueHistory>(path+'/history?limit=20')]);if(alive){setData(next);setHistory(events);}}catch(e){if(alive)setError(errorMessage(e));}};
    void load();const timer=setInterval(()=>{if(!inFlight.current)void load();},5000);
    return()=>{alive=false;clearInterval(timer);};
  },[path]);
  async function send(command:Command){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError(null);setNotice('');
    try{
      const result=await request<QueueCommandResult>(path+command.path,{method:'POST',body:command.body,idempotencyKey:command.key});
      setRetry(null);setNotice(result.outcome==='EMPTY'?'No waiting tickets.':'Queue updated.');setReason('');
      await refresh();
    }catch(e){
      if(e instanceof ApiError && e.status<500){setRetry(null);setError(errorMessage(e));await refresh().catch(()=>{});}
      else {setRetry(command);setError('The result could not be confirmed. Retry the same action safely before continuing.');}
    }finally{inFlight.current=false;setBusy(false);}
  }
  function command(suffix:string,body:unknown){void send({path:suffix,body,key:crypto.randomUUID()});}
  if(!data)return <><ErrorNotice message={error}/><Loading/></>;
  const open=data.session?.status==='OPEN' && data.acceptingOperations;
  const available=data.counters.filter(c=>c.isActive && !c.activeTicketId);
  const selected=available.some(c=>c.id===counterId);
  const disabled=busy || retry!==null;
  function ticketAction(ticket:QueueTicketDto,action:TicketAction){
    command('/tickets/'+ticket.id+'/'+action,{expectedVersion:ticket.version,...(action==='call'?{counterId,...(reason.trim()?{reason:reason.trim()}: {})}:{})});
  }
  function tickets(title:string,rows:QueueTicketDto[],carryover=false){
    return <Panel title={title}>{rows.length===0?<p className="text-sm text-slate-500">No tickets.</p>:<ul className="divide-y divide-slate-100">{rows.map(ticket=><li key={ticket.id} className="py-4">
      <div className="flex flex-wrap items-center gap-3"><strong className="text-xl tabular-nums">{ticket.number}</strong><span>{ticket.customerName}</span><span className="text-xs text-slate-500">{ticket.status}{ticket.counterId?' · '+data!.counters.find(c=>c.id===ticket.counterId)?.name:''}{carryover?' · '+ticket.businessDate:''}</span></div>
      <div className="mt-3 flex flex-wrap gap-2">
        {ticket.status==='WAITING' && !carryover && <Button disabled={disabled || !open || !selected} onClick={()=>ticketAction(ticket,'call')}>Call {ticket.number}</Button>}
        {ticket.status==='CALLED' && <><Button disabled={disabled} onClick={()=>ticketAction(ticket,'start')}>Start service</Button><Button disabled={disabled} onClick={()=>ticketAction(ticket,'skip')}>Skip</Button><Button disabled={disabled} onClick={()=>ticketAction(ticket,'no-show')}>No show</Button></>}
        {ticket.status==='SERVING' && <Button disabled={disabled} onClick={()=>ticketAction(ticket,'complete')}>Complete</Button>}
        {ticket.status==='SKIPPED' && !carryover && <Button disabled={disabled || !open} onClick={()=>ticketAction(ticket,'requeue')}>Requeue</Button>}
        {(ticket.status==='WAITING'||ticket.status==='CALLED')&&<Button disabled={disabled} onClick={()=>ticketAction(ticket,'cancel')}>Cancel</Button>}
      </div></li>)}</ul>}</Panel>;
  }
  return <>
    <PageTitle title={data.serviceName} description={data.branchName+' · '+data.businessDate+' · '+data.timezone} actions={<Link className="text-sm text-teal-800" to={'/app/'+businessId+'/branches/'+branchId+'/services/'+serviceId+'/settings'}>Service settings</Link>}/>
    <ErrorNotice message={error}/>{notice&&<p role="status" className="mb-4 text-teal-800">{notice}</p>}
    {retry&&<Button disabled={busy} onClick={()=>void send(retry)}>Retry pending action</Button>}
    <Panel title={'Queue: '+(data.session?.status ?? 'NOT OPENED')}>
      <div className="flex flex-wrap gap-2">
        {!data.session&&<Button disabled={disabled || !data.acceptingOperations} onClick={()=>command('/queue/open',{})}>Open queue</Button>}
        {data.session?.status==='OPEN'&&<Button disabled={disabled} onClick={()=>command('/queue/pause',{sessionId:data.session!.id,expectedRevision:data.revision})}>Pause queue</Button>}
        {data.session?.status==='PAUSED'&&<Button disabled={disabled || !data.acceptingOperations} onClick={()=>command('/queue/resume',{sessionId:data.session!.id,expectedRevision:data.revision})}>Resume queue</Button>}
        {data.session&&data.session.status!=='CLOSED'&&<Button disabled={disabled} onClick={()=>command('/queue/close',{sessionId:data.session!.id,expectedRevision:data.revision})}>Close queue</Button>}
        <Button disabled={busy} onClick={()=>void refresh().catch(e=>setError(errorMessage(e)))}>Refresh</Button>
      </div>
      <p className="mt-3 text-sm text-slate-500">{data.summary.waitingCount} waiting · {data.summary.calledCount} called · {data.summary.servingCount} serving · {data.summary.completedToday} completed today</p>
      <p className="mt-2 text-xs text-slate-500">Refreshes every 5 seconds. Closing is final for this business date. Active work can still finish.</p>
    </Panel>
    <div className="my-6"><Panel title="Call a customer"><div className="grid items-end gap-4 md:grid-cols-3">
      <Field label="Available counter"><select className="input" value={counterId} onChange={e=>setCounterId(e.target.value)}><option value="">Choose a counter</option>{available.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
      <Field label="Reason for calling out of order"><input className="input" value={reason} maxLength={300} onChange={e=>setReason(e.target.value)} placeholder="Required when bypassing earlier tickets"/></Field>
      <Button disabled={disabled || !open || !selected} onClick={()=>command('/queue/call-next',{counterId,sessionId:data.session!.id})}>Call next</Button>
    </div><div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">{data.counters.map(c=><span key={c.id}>{c.name}: {!c.isActive?'inactive':c.activeTicketId?'busy':'available'}</span>)}</div></Panel></div>
    <div className="grid gap-6 lg:grid-cols-2">{tickets('Now serving / Called',[...data.serving,...data.called])}{tickets('Waiting',data.waiting)}{tickets('Skipped',data.skipped)}{data.carryover.length>0&&tickets('Previous days — finish or cancel',data.carryover,true)}</div>
    <div className="mt-6"><Panel title="Recent activity"><ul className="divide-y divide-slate-100">{history?.events.map(e=><li className="py-3 text-sm" key={e.id}><span className="font-medium">{e.number ?? 'Queue'}</span> · {e.eventType.replaceAll('_',' ').toLowerCase()}<span className="ml-2 text-xs text-slate-500">{new Date(e.occurredAt).toLocaleTimeString()}</span>{typeof e.metadata.reason==='string'&&<p className="mt-1 text-slate-500">Reason: {e.metadata.reason}</p>}</li>)}</ul></Panel></div>
  </>;
}
