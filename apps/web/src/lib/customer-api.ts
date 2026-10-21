import {getCustomerSupabase} from './supabase';
const base=(import.meta.env.VITE_API_URL || '/api/v1').replace(/\/$/,'');
export class CustomerError extends Error{
  constructor(public readonly status:number,public readonly code:string){super(code);}
}
export async function customerRequest<T>(path:string,options:{body?:unknown;key?:string;signal?:AbortSignal}={}):Promise<T>{
  const {data,error}=await getCustomerSupabase().auth.getSession();
  if(error || !data.session?.user.is_anonymous)throw new CustomerError(401,'BROWSER_ACCESS_LOST');
  const response=await fetch(base+'/customer'+path,{method:options.body===undefined?'GET':'POST',
    headers:{Authorization:'Bearer '+data.session.access_token,...(options.body===undefined?{}:{'Content-Type':'application/json'}),...(options.key?{'Idempotency-Key':options.key}:{})},
    body:options.body===undefined?undefined:JSON.stringify(options.body),signal:options.signal??AbortSignal.timeout(15000)});
  const body=await response.json();
  if(!response.ok)throw new CustomerError(response.status,typeof body?.error?.code==='string'?body.error.code:'UNAVAILABLE');
  return body as T;
}
export function customerError(error:unknown):string{
  if(error instanceof CustomerError){
    if(error.status===401)return 'We could not restore your ticket on this browser. Reopen the original browser or contact staff.';
    if(error.status===403 || error.status===404)return 'This ticket or service is not available on this browser. Please check the link or contact staff.';
    const messages:Record<string,string>={
      DEMO_RATE_LIMIT:'Too many demo actions. Please wait one minute and try again.',
      QUEUE_NOT_OPENED:'The queue has not opened yet. Please check again later.',
      QUEUE_PAUSED:'The queue is temporarily paused. Please check again later.',
      QUEUE_CLOSED:'The queue is closed for today.',SERVICE_UNAVAILABLE:'This service is currently unavailable.',
      PAID_JOIN_UNAVAILABLE:'Online payment queue joining is not available yet.',
      CHECKOUT_UNAVAILABLE:'This checkout cannot accept another payment. Please return to services or contact staff.',
      PAYMENT_EVENT_CONFLICT:'This action has changed. Refresh the checkout before trying again.',
      PAYMENT_MISMATCH:'Payment could not be verified. Please contact staff.',
      CANNOT_CANCEL:'Your ticket has already moved forward. Please contact staff to leave the queue.',
      STALE_VERSION:'Your ticket has changed. Please check its latest status.',
      IDEMPOTENCY_CONFLICT:'Please return to the service page and try again.',
    };
    if(messages[error.code])return messages[error.code]!;
    if(error.status===400)return 'Please check your name and optional phone number.';
  }
  return 'We could not connect. Please try again when your connection returns.';
}
const referenceKey='qevra-ticket-references';
export function ticketReferences():string[]{
  try{const value:unknown=JSON.parse(localStorage.getItem(referenceKey)??'[]');return Array.isArray(value)?value.filter((id):id is string=>typeof id==='string'&&/^[0-9a-f-]{36}$/i.test(id)).slice(0,10):[];}catch{return [];}
}
export function rememberTicket(id:string):void{try{localStorage.setItem(referenceKey,JSON.stringify([id,...ticketReferences().filter(value=>value!==id)].slice(0,10)));}catch{/* Exact ticket URL remains usable if storage is unavailable. */}}
export function forgetTicket(id:string):void{try{localStorage.setItem(referenceKey,JSON.stringify(ticketReferences().filter(value=>value!==id)));}catch{/* Storage is optional. */}}
