import {useEffect,useState} from 'react';
import type {CustomerNotification,MockWhatsAppNotification} from '@qevra/contracts';
import {customerRequest,customerError} from '../../lib/customer-api';
import {Panel,Button,ErrorNotice} from '../../components/ui';
export function TicketUpdates({ticketId,notifications,mockAvailable,refresh}:{ticketId:string;notifications:CustomerNotification[];mockAvailable:boolean;refresh:()=>void}){
  const [busy,setBusy]=useState<string|null>(null),[error,setError]=useState<string|null>(null),[inspect,setInspect]=useState(false),[mock,setMock]=useState<MockWhatsAppNotification[]|null>(null);
  const showMock=import.meta.env.DEV&&mockAvailable;
  useEffect(()=>{
    let active=true;
    if(showMock&&inspect)void customerRequest<MockWhatsAppNotification[]>('/tickets/'+ticketId+'/mock-whatsapp').then(value=>{if(active){setMock(value);setError(null);}}).catch(e=>{if(active)setError(customerError(e));});
    return()=>{active=false;};
  },[ticketId,notifications,inspect,showMock]);
  async function read(id:string){
    if(busy)return;setBusy(id);setError(null);
    try{await customerRequest('/notifications/'+id+'/read',{body:{}});refresh();}catch(e){setError(customerError(e));}finally{setBusy(null);}
  }
  const time=(value:string)=>new Intl.DateTimeFormat('id-ID',{hour:'2-digit',minute:'2-digit'}).format(new Date(value));
  return <>
    <Panel title="Updates"><ErrorNotice message={error}/>
      {notifications.length?<ol className="space-y-5" data-testid="notification-updates">{notifications.map(item=><li key={item.id} data-testid={'notification-'+item.type} className="border-l-2 border-teal-100 pl-4">
        <div className="flex items-center justify-between gap-3"><time dateTime={item.createdAt} className="text-xs text-slate-500">{time(item.createdAt)}</time>{!item.readAt&&<span className="text-xs font-semibold text-teal-800">New</span>}</div>
        <p className="mt-1 text-sm font-semibold">{item.title}</p><p className="mt-1 text-sm leading-relaxed text-slate-600">{item.message}</p>
        {!item.readAt&&<button className="mt-2 min-h-10 text-xs text-teal-800 underline disabled:opacity-50" disabled={busy!==null} onClick={()=>void read(item.id)}>Mark as read</button>}
      </li>)}</ol>:<p className="text-sm text-slate-500">Your queue updates will appear here.</p>}
    </Panel>
    {showMock&&<Panel><Button className="w-full" onClick={()=>setInspect(value=>!value)}>{inspect?'Hide mock WhatsApp':'Inspect mock WhatsApp'}</Button>
      {inspect&&<div className="mt-4 space-y-4" data-testid="mock-whatsapp"><h2 className="font-semibold">MOCK WHATSAPP</h2><p className="text-xs text-slate-500">Development simulation only. No WhatsApp message was sent.</p>
        {mock===null?<p className="text-sm">Loading simulated messages…</p>:!mock.length?<p className="text-sm">No simulated messages. A supported phone number and explicit consent are required.</p>:mock.map(item=><div key={item.id} data-testid={'mock-'+item.type} className="rounded-lg bg-slate-50 p-3 text-sm">
          <p className="text-xs text-slate-500">{time(item.createdAt)} · {item.status}</p><p className="mt-1">Recipient: {item.recipientMasked??'Not delivered'}</p><p className="mt-2">{item.message}</p>{item.failureCode&&<p className="mt-1 text-xs">{item.failureCode}</p>}
        </div>)}
      </div>}
    </Panel>}
  </>;
}
