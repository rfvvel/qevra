import {useEffect,useRef,useState,type FormEvent} from 'react';
import {useParams,useNavigate,Link} from 'react-router-dom';
import {customerJoinSchema,type PublicBranchDto,type ActiveCustomerTicket,type CustomerJoinResult,type CustomerJoinInput} from '@qevra/contracts';
import {useResource} from '../../lib/use-resource';
import {ensureCustomerSession} from '../../lib/auth';
import {customerRequest,customerError,CustomerError,rememberTicket} from '../../lib/customer-api';
import {Panel,Button,Field,ErrorNotice,Loading,money} from '../../components/ui';
export function JoinPage(){
  const params=useParams();
  return <JoinForm key={params.branchSlug+'/'+params.serviceId}/>;
}
function JoinForm(){
  const {branchSlug='',serviceId=''}=useParams(),navigate=useNavigate();
  const resource=useResource<PublicBranchDto>('/public/branches/'+encodeURIComponent(branchSlug),true);
  const [phone,setPhone]=useState(''),[whatsappOptIn,setWhatsappOptIn]=useState(false);
  const [ready,setReady]=useState(false),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const [attempt,setAttempt]=useState<{key:string;body:CustomerJoinInput}|null>(null),[retry,setRetry]=useState(false);
  const [prepareVersion,setPrepareVersion]=useState(0);
  const inFlight=useRef(false);
  useEffect(()=>{
    let active=true;
    void (async()=>{
      await ensureCustomerSession();
      const existing=await customerRequest<ActiveCustomerTicket|null>('/active-ticket?serviceId='+encodeURIComponent(serviceId));
      if(!active)return;
      if(existing){rememberTicket(existing.ticketId);navigate('/ticket/'+existing.ticketId,{replace:true});return;}
      setReady(true);setError(null);
    })().catch(e=>{if(active)setError(customerError(e));});
    return()=>{active=false;};
  },[serviceId,navigate,prepareVersion]);
  async function send(command:{key:string;body:CustomerJoinInput}){
    if(inFlight.current)return;
    inFlight.current=true;setBusy(true);setError(null);setAttempt(command);
    try{
      const result=await customerRequest<CustomerJoinResult>('/join-requests',{body:command.body,key:command.key});
      if(result.ticketId){rememberTicket(result.ticketId);navigate('/ticket/'+result.ticketId,{replace:true});}
      else if(result.outcome==='PAYMENT_REQUIRED')navigate('/checkout/'+result.joinRequestId,{replace:true});
      else throw new Error('Missing ticket');
    }catch(e){
      setError(customerError(e));
      if(e instanceof CustomerError && e.status<500){setRetry(false);setAttempt(null);resource.reload();}
      else setRetry(true);
    }finally{setBusy(false);inFlight.current=false;}
  }
  function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();const form=new FormData(event.currentTarget);
    const body={branchSlug,serviceId,customerName:String(form.get('customerName')??''),phone:String(form.get('phone')??''),whatsappOptIn};
    const parsed=customerJoinSchema.safeParse(body);
    if(!parsed.success){setError(parsed.error.issues.map(issue=>issue.message).join(' '));return;}
    void send({key:crypto.randomUUID(),body});
  }
  if(resource.loading)return <Loading/>;
  const service=resource.data?.services.find(item=>item.id===serviceId);
  if(!service)return <ErrorNotice message="This service or branch is currently unavailable."/>;
  const unavailable=service.payment_mode!=='NONE'&&!service.online_payment_available?'Online payment queue joining is not available yet.':service.queue_status==='PAUSED'?'The queue is temporarily paused.':service.queue_status==='CLOSED'?'The queue is closed for today.':service.queue_status==='NOT_OPENED'?'The queue has not opened yet.':null;
  return <div className="mx-auto max-w-lg"><Link to={'/q/'+branchSlug} className="text-sm text-teal-800">← All services</Link><p className="mt-6 text-sm text-slate-500">{resource.data!.business_name} · {resource.data!.branch.name}</p><h1 className="mb-2 mt-2 text-3xl font-semibold">{service.name}</h1><p className="mb-6 text-slate-500">{money(service.price_amount)} · ~{service.estimated_duration_minutes} minute service</p>
    <ErrorNotice message={error}/>{!ready && error&&<Button onClick={()=>setPrepareVersion(value=>value+1)}>Try again</Button>}
    {unavailable?<Panel><p>{unavailable}</p><Button className="mt-4" onClick={resource.reload}>Check availability</Button></Panel>:<Panel title="Join the queue">
      {retry&&attempt?<><p className="mb-4 text-sm text-slate-600">We could not confirm the result. Retry safely to retrieve your ticket.</p><Button disabled={busy} onClick={()=>void send(attempt)}>Retry joining</Button></>:<form onSubmit={submit} className="space-y-5">
      <Field label="Your name"><input className="input" name="customerName" autoComplete="name" required maxLength={120}/></Field>
      <Field label="WhatsApp / phone (optional)" hint="Optional Indonesian mobile number."><input className="input" name="phone" value={phone} onChange={event=>{setPhone(event.target.value);if(!event.target.value.trim())setWhatsappOptIn(false);}} type="tel" autoComplete="tel" maxLength={40} placeholder="+628123456789"/></Field>
      <label className="flex items-start gap-3 text-sm leading-relaxed"><input type="checkbox" className="mt-1 h-4 w-4 accent-teal-800" checked={whatsappOptIn} disabled={!phone.trim()} onChange={event=>setWhatsappOptIn(event.target.checked)}/><span>Send queue updates to this number via WhatsApp</span></label>
      {/* <p className="text-xs text-slate-500">By opting in, you agree that Qevra may share your number and queue details with Meta and, when used, Twilio to send near-turn and called-ticket reminders from Qevra’s shared WhatsApp number, when enabled. Delivery may be delayed or unavailable. For a Twilio Sandbox demo, join the Sandbox and send it a WhatsApp message first; consent here does not open its 24-hour messaging window. Development mock messages are simulations only. Keep this ticket open for in-app updates.</p> */}
      <Button className="min-h-12 w-full" type="submit" disabled={!ready||busy}>{busy?'Please wait…':ready?(service.payment_mode==='NONE'?'Join queue':service.payment_mode==='DEPOSIT'?'Pay deposit & join':'Pay & join'):'Getting ready…'}</Button></form>}
    </Panel>}</div>;
}
