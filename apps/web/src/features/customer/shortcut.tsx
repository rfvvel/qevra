import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import type {CustomerTicketSnapshot} from '@qevra/contracts';
import {customerRequest,ticketReferences,forgetTicket,CustomerError} from '../../lib/customer-api';
import {getCustomerSupabase} from '../../lib/supabase';
export function TicketShortcut(){
  const [tickets,setTickets]=useState<CustomerTicketSnapshot[]>([]);
  useEffect(()=>{
    let active=true;
    void (async()=>{
      const existing=await getCustomerSupabase().auth.getSession();
      if(!existing.data.session?.user.is_anonymous)return;
      const snapshots=await Promise.all(ticketReferences().map(async id=>{
        try{const snapshot=await customerRequest<CustomerTicketSnapshot>('/tickets/'+id);
          if(['COMPLETED','CANCELLED','NO_SHOW'].includes(snapshot.ticket.status)){forgetTicket(id);return null;}
          return snapshot;
        }catch(error){if(error instanceof CustomerError && error.status===404)forgetTicket(id);return null;}
      }));
      if(active)setTickets(snapshots.filter((snapshot):snapshot is CustomerTicketSnapshot=>snapshot!==null));
    })().catch(()=>{});
    return()=>{active=false;};
  },[]);
  return tickets.length?<aside aria-label="Your queue tickets" className="mb-6 space-y-3">{tickets.map(value=><Link key={value.ticket.id} to={'/ticket/'+value.ticket.id} className="block rounded-xl border border-teal-200 bg-teal-50 p-4 text-teal-900">View your ticket <strong>{value.ticket.queueNumber}</strong> · {value.service.name}</Link>)}</aside>:null;
}
