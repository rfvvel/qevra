import {Link,useParams} from 'react-router-dom';
import type {PublicBranchDto} from '@qevra/contracts';
import {useResource} from '../../lib/use-resource';
import {Panel,Loading,ErrorNotice,Button,money} from '../../components/ui';
export function PublicBranchPage(){
  const {branchSlug}=useParams();
  const resource=useResource<PublicBranchDto>('/public/branches/'+encodeURIComponent(branchSlug||''),true);
  if(resource.loading)return <Loading/>;
  if(!resource.data)return <><ErrorNotice message="This branch is unavailable. Check your connection or ask staff for the correct link."/><Button onClick={resource.reload}>Try again</Button></>;
  const {business_name,branch,services}=resource.data;
  const labels={OPEN:'Open',PAUSED:'Temporarily paused',CLOSED:'Closed today',NOT_OPENED:'Not opened yet'};
  return <><p className="mb-2 text-sm font-semibold text-teal-800">{business_name}</p><h1 className="text-3xl font-semibold">{branch.name}</h1>{branch.address&&<p className="mt-2 text-slate-500">{branch.address}</p>}
    <h2 className="mb-4 mt-8 text-xl font-semibold">Choose a service</h2><div className="grid gap-4 sm:grid-cols-2">{services.map(service=><Panel key={service.id}>
      <h3 className="text-xl font-semibold">{service.name}</h3>{service.description&&<p className="mt-2 text-sm text-slate-500">{service.description}</p>}
      <p className="mt-5 text-xl font-semibold text-teal-900">{money(service.price_amount)}</p><p className="mt-1 text-sm text-slate-500">~{service.estimated_duration_minutes} minute service</p>
      {service.payment_simulated&&<p className="mt-3 text-sm font-semibold text-amber-900">SIMULASI PEMBAYARAN — TIDAK ADA UANG ASLI</p>}
      <p className="mt-5 text-sm font-medium">Queue: {labels[service.queue_status]}</p>
      {service.payment_mode==='DEPOSIT'&&service.deposit_amount&&<p className="mt-2 text-sm text-slate-600">Deposit {money(service.deposit_amount)}</p>}{service.payment_mode==='FULL'&&<p className="mt-2 text-sm text-slate-600">Payment required</p>}
      {service.payment_mode!=='NONE'&&!service.online_payment_available?<p className="mt-3 text-sm text-slate-500">Online payment queue joining is not available yet.</p>:<Link className="button mt-4 min-h-12 w-full justify-center" to={'/q/'+branch.public_slug+'/services/'+service.id+'/join'}>{service.queue_status==='OPEN'?(service.payment_mode==='NONE'?'Join queue':service.payment_mode==='DEPOSIT'?'Pay deposit & join':'Pay & join'):'Check queue'}</Link>}
    </Panel>)}</div>{!services.length&&<Panel><p>No services are currently available.</p></Panel>}<button className="mt-6 text-sm text-teal-800 underline" onClick={resource.reload}>Refresh availability</button></>;
}
