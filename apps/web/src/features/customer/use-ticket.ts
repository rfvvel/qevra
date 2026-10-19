import {useEffect,useRef,useState} from 'react';
import type {CustomerTicketSnapshot} from '@qevra/contracts';
import type {RealtimeChannel} from '@supabase/supabase-js';
import {customerRequest,customerError,rememberTicket,forgetTicket,CustomerError} from '../../lib/customer-api';
import {getCustomerSupabase} from '../../lib/supabase';
export function useTicket(ticketId:string){
  const [data,setData]=useState<CustomerTicketSnapshot|null>(null),[error,setError]=useState<string|null>(null),[connected,setConnected]=useState(false);
  const reload=useRef<()=>void>(()=>{});
  useEffect(()=>{
    let active=true,running=false,queued=false,online=false,channel:RealtimeChannel|undefined,latest:CustomerTicketSnapshot|null=null,lastFetch=0;
    let authBlocked=false;
    const controller=new AbortController(),client=getCustomerSupabase();
    async function refresh(){
      if(!active)return;
      if(running){queued=true;return;}
      running=true;
      try{
        const next=await customerRequest<CustomerTicketSnapshot>('/tickets/'+ticketId,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(15000)])});
        if(!active)return;
        if(!latest || (BigInt(next.queue.revision)>=BigInt(latest.queue.revision) && next.queue.generatedAt>=latest.queue.generatedAt)){
          latest=next;setData(next);setError(null);authBlocked=false;
          if(['COMPLETED','CANCELLED','NO_SHOW'].includes(next.ticket.status))forgetTicket(ticketId);else rememberTicket(ticketId);
        }
        if(!channel){
          const {data:session}=await client.auth.getSession();
          if(!active || !session.session)return;
          await client.realtime.setAuth(session.session.access_token);
          if(!active)return;
          channel=client.channel(next.queue.realtimeTopic,{config:{private:true}})
            .on('broadcast',{event:'queue_changed'},()=>{void refresh();})
            .subscribe(status=>{
              if(!active)return;
              online=status==='SUBSCRIBED';setConnected(online);
              if(online)void refresh();
            });
        }
      }catch(e){
        if(active){setError(customerError(e));if(e instanceof CustomerError&&(e.status===401||e.status===403||e.status===404)){authBlocked=true;setData(null);if(channel){void client.removeChannel(channel);channel=undefined;}}}
      }finally{
        running=false;lastFetch=Date.now();
        if(active&&queued){queued=false;void refresh();}
      }
    }
    reload.current=()=>{void refresh();};
    void refresh();
    const visible=()=>{if(document.visibilityState==='visible')void refresh();};
    const reconnect=()=>{void refresh();};
    document.addEventListener('visibilitychange',visible);window.addEventListener('online',reconnect);
    const timer=setInterval(()=>{
      if(document.visibilityState==='visible'&&!authBlocked&&Date.now()-lastFetch>=(online?60000:20000))void refresh();
    },5000);
    return()=>{active=false;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible);window.removeEventListener('online',reconnect);if(channel)void client.removeChannel(channel);};
  },[ticketId]);
  return {data,error,connected,refresh:()=>reload.current()};
}
