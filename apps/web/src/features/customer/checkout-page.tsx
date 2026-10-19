import {useCallback,useEffect,useRef,useState} from 'react';
import {Link,useNavigate,useParams} from 'react-router-dom';
import type {CheckoutDto,MockPaymentOutcome} from '@qevra/contracts';
import {customerRequest,customerError,CustomerError,rememberTicket} from '../../lib/customer-api';
import {Panel,Button,ErrorNotice,Loading,money} from '../../components/ui';
type Command={path:string;body:unknown;key:string};
export function CheckoutPage(){const {joinRequestId=''}=useParams();return import.meta.env.DEV?<CheckoutView key={joinRequestId} id={joinRequestId}/>:<Panel title="Online payments unavailable"><p>Real payment provider not integrated in MVP.</p><Link className="mt-4 inline-block text-teal-800 underline" to="/">Return home</Link></Panel>;}
function CheckoutView({id}:{id:string}){
  const navigate=useNavigate();
  const [data,setData]=useState<CheckoutDto|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[pending,setPending]=useState<Command|null>(null);
  const inFlight=useRef(false),latest=useRef('');
  const accept=useCallback((next:CheckoutDto)=>{
    if(next.generatedAt<latest.current)return;
    latest.current=next.generatedAt;setData(next);
    if(next.ticketId){rememberTicket(next.ticketId);navigate('/ticket/'+next.ticketId,{replace:true});}
  },[navigate]);
  const refresh=useCallback(async()=>{const next=await customerRequest<CheckoutDto>('/join-requests/'+id);accept(next);},[id,accept]);
  useEffect(()=>{
    let active=true;
    const update=async()=>{try{const next=await customerRequest<CheckoutDto>('/join-requests/'+id);if(active){accept(next);setError(null);}}catch(e){if(active){setError(customerError(e));if(e instanceof CustomerError&&[401,403,404].includes(e.status))setData(null);}}};
    void update();
    const visible=()=>{if(document.visibilityState==='visible'&&!inFlight.current)void update();};
    const timer=setInterval(visible,10000);
    document.addEventListener('visibilitychange',visible);window.addEventListener('online',visible);
    return()=>{active=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',visible);};
  },[id,accept]);
  async function send(command:Command){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError(null);
    try{const next=await customerRequest<CheckoutDto>(command.path,{body:command.body,key:command.key});setPending(null);accept(next);}
    catch(e){setError(customerError(e));if(e instanceof CustomerError&&e.status<500){setPending(null);await refresh().catch(()=>{});}else setPending(command);}
    finally{inFlight.current=false;setBusy(false);}
  }
  function simulate(outcome:MockPaymentOutcome){
    if(data)void send({path:'/payments/'+data.payment.id+'/mock',body:{outcome},key:crypto.randomUUID()});
  }
  if(!data)return <div className="mx-auto max-w-lg"><ErrorNotice message={error}/>{error?<Button onClick={()=>void refresh().catch(e=>setError(customerError(e)))}>Try again</Button>:<Loading/>}</div>;
  const mockControls=import.meta.env.DEV && data.mockControlsEnabled;
  const reconciliation=data.joinRequest.status==='RECONCILIATION_REQUIRED';
  const expiredRequest=data.joinRequest.status==='EXPIRED';
  return <div className="mx-auto max-w-lg space-y-5">
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4"><h1 className="text-lg font-semibold text-amber-950">Development Mock Payment</h1><p className="mt-1 text-sm text-amber-900">Simulation only. No real money is charged.</p></div>
    <div><h2 className="text-2xl font-semibold">{data.service.name}</h2><p className="mt-1 text-sm text-slate-500">{data.service.branchName}</p></div>
    <ErrorNotice message={error}/>
    <Panel title="Payment summary"><dl className="space-y-4 text-sm">
      <div className="flex justify-between gap-4"><dt>Service price</dt><dd data-testid="service-price">{money(data.pricing.servicePrice)}</dd></div>
      {data.pricing.mode==='DEPOSIT'&&<div className="flex justify-between gap-4"><dt>Deposit</dt><dd>{money(data.pricing.payNow)}</dd></div>}
      <div className="flex justify-between gap-4 border-t border-slate-100 pt-4 text-lg font-semibold"><dt>Pay now</dt><dd data-testid="pay-now">{money(data.pricing.payNow)}</dd></div>
      {data.pricing.mode==='DEPOSIT'&&<div className="flex justify-between gap-4"><dt>Remaining payment</dt><dd data-testid="remaining-payment">{money(data.pricing.remaining)}</dd></div>}
    </dl><p className="mt-5 text-xs text-slate-500">This checkout keeps the price agreed when it was created. A queue number is assigned only after successful verification.</p></Panel>
    <Panel title={reconciliation?'Payment received — assistance needed':data.payment.status==='PENDING'?'Waiting for payment':data.payment.status==='FAILED'?'Payment failed':data.payment.status==='EXPIRED'?'Payment expired':'Payment successful'}>
      <p data-testid="payment-status" className="text-sm font-medium text-slate-600">{data.payment.status}</p>
      {reconciliation?<p role="status" className="mt-3 leading-relaxed">Payment was received, but your queue ticket could not be created. Please contact the service provider.</p>:<>
        {expiredRequest&&<p className="mt-3 text-sm">This checkout has expired. Return to services to start again.</p>}
        {!mockControls&&<p className="mt-3 text-sm text-slate-500">Simulation controls are unavailable in this environment.</p>}
        {pending?<Button disabled={busy} className="mt-4 w-full" onClick={()=>void send(pending)}>Retry pending action</Button>:<>
          {mockControls&&data.payment.status==='PENDING'&&<div className="mt-5 space-y-3">
            <Button className="min-h-12 w-full" disabled={busy} onClick={()=>simulate('SUCCESS')}>Simulate Successful Payment</Button>
            <Button className="min-h-12 w-full" disabled={busy} onClick={()=>simulate('FAILURE')}>Simulate Failed Payment</Button>
            <Button className="min-h-12 w-full" disabled={busy} onClick={()=>simulate('EXPIRY')}>Simulate Expired Payment</Button>
          </div>}
          {mockControls&&data.canRetry&&<Button disabled={busy} className="mt-5 min-h-12 w-full" onClick={()=>void send({path:'/join-requests/'+id+'/payments',body:{},key:crypto.randomUUID()})}>{data.payment.status==='FAILED'?'Try Again':'Create New Payment'}</Button>}
        </>}
      </>}
    </Panel>
    {data.attempts.length>1&&<Panel title="Payment attempts"><ol className="space-y-3 text-sm">{data.attempts.map((attempt,index)=><li key={attempt.id}>Attempt {index+1}: {attempt.status} · {money(attempt.amount)}</li>)}</ol></Panel>}
    <Link className="inline-block text-sm text-teal-800 underline" to={'/q/'+data.service.branchSlug}>Back to services</Link>
  </div>;
}
