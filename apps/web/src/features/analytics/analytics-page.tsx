import {useState} from 'react';
import {BusinessRole,type AnalyticsDashboard,type AnalyticsGroup,type AnalyticsQuery} from '@qevra/contracts';
import {useBusiness} from '../../components/layouts';
import {PageTitle,Panel,Loading,ErrorNotice,Field} from '../../components/ui';
import {useResource} from '../../lib/use-resource';
const duration=(value:number|null)=>value===null?'—':new Intl.NumberFormat('en',{maximumFractionDigits:1}).format(value)+' min';
function Performance({title,rows}:{title:string;rows:AnalyticsGroup[]}){
 return <Panel title={title}><div className="overflow-x-auto"><table className="w-full text-left text-sm" aria-label={title}>
 <thead><tr>{['Name','Joined','Completed','Avg wait','Avg service','Cancelled','No show'].map(label=><th className="whitespace-nowrap border-b p-3" key={label}>{label}</th>)}</tr></thead>
 <tbody>{rows.map(row=><tr key={row.id}><th className="border-b p-3 font-medium">{row.name}</th>{[row.joined,row.completed,duration(row.averageWaitMinutes),duration(row.averageServiceMinutes),row.cancelled,row.noShow].map((value,i)=><td key={i} className="whitespace-nowrap border-b p-3">{value}</td>)}</tr>)}</tbody>
 </table></div>{!rows.length&&<p className="text-sm text-slate-500">No services or branches in this selection.</p>}</Panel>;
}
export function AnalyticsPage(){
 const {business}=useBusiness();
 return business.role===BusinessRole.STAFF?<><PageTitle title="Analytics"/><ErrorNotice message="Analytics are available to owners and authorized managers only." /></>:<Dashboard key={business.id} businessId={business.id}/>;
}
function Dashboard({businessId}:{businessId:string}){
 const [range,setRange]=useState<AnalyticsQuery['range']>('TODAY'),[branchId,setBranch]=useState(''),[serviceId,setService]=useState('');
 const query=new URLSearchParams({range,...(branchId?{branchId}:{}),...(serviceId?{serviceId}:{})});
 const resource=useResource<AnalyticsDashboard>('/businesses/'+businessId+'/analytics?'+query.toString());
 // Keep authorized filter choices while a new result loads; never retain old metrics.
 const [options,setOptions]=useState<Pick<AnalyticsDashboard,'branches'|'services'>|null>(null);
 if(resource.data&&resource.data!==options)setOptions(resource.data);
 const data=resource.data;
 const filteredServices=options?.services.filter(s=>!branchId||s.branchId===branchId)??[];
 const summary=data?.summary;
 return <div className="space-y-6"><PageTitle title="Analytics" description="Understand your queue activity and service times." actions={<button className="button" disabled={resource.loading} onClick={resource.reload}>Refresh</button>}/>
 <Panel><div className="grid gap-4 sm:grid-cols-3">
 <Field label="Date range"><select aria-label="Date range" className="input" value={range} onChange={e=>setRange(e.target.value as AnalyticsQuery['range'])}><option value="TODAY">Today</option><option value="LAST_7_DAYS">Last 7 Days</option><option value="LAST_30_DAYS">Last 30 Days</option></select></Field>
 <Field label="Branch"><select aria-label="Branch" className="input" value={branchId} onChange={e=>{setBranch(e.target.value);setService('');}}><option value="">All authorized branches</option>{options?.branches.map(b=><option value={b.id} key={b.id}>{b.name}</option>)}</select></Field>
 <Field label="Service"><select aria-label="Service" className="input" value={serviceId} onChange={e=>setService(e.target.value)}><option value="">All services</option>{filteredServices.map(s=><option key={s.id} value={s.id}>{s.name}{!branchId?' · '+options?.branches.find(b=>b.id===s.branchId)?.name:''}</option>)}</select></Field>
 </div></Panel>
 <ErrorNotice message={resource.error}/>{resource.error&&<button className="button" onClick={resource.reload}>Try again</button>}
 {resource.loading?<Loading/>:data&&summary&&<>
 <section aria-label="Historical performance"><h2 className="text-xl font-semibold">Historical performance</h2><p className="mt-2 text-sm text-slate-500">Tickets admitted on selected business dates, with their latest outcomes. Times use each branch’s local timezone.</p>
 <p className="mt-1 text-xs text-slate-500">{data.branches.filter(b=>data.byBranch.some(row=>row.id===b.id)).map(b=>b.name+': '+b.from+' – '+b.to+' ('+b.timezone+')').join(' · ')}</p>
 {!summary.joined?<div className="mt-5 rounded-xl border border-dashed border-slate-300 p-8"><h3 className="font-semibold">{branchId||serviceId?'No results for selected filters':'No queue data yet'}</h3><p className="mt-2 text-sm text-slate-500">No admitted tickets in this date range. Try another range or filter.</p></div>:
 <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[
 ['Customers joined',summary.joined,'Admitted tickets, counted once'],
 ['Completed',summary.completed,'Completed tickets in this cohort'],
 ['Average wait',duration(summary.averageWaitMinutes),summary.waitSamples+' valid call samples'],
 ['Average service time',duration(summary.averageServiceMinutes),summary.serviceSamples+' completed service samples'],
 ['Cancelled',summary.cancelled,'Cancelled tickets in this cohort'],
 ['No show',summary.noShow,'No-show tickets in this cohort'],
 ].map(([label,value,hint])=><Panel key={label}><h3 className="text-sm text-slate-500">{label}</h3><p data-testid={'metric-'+String(label).toLowerCase().replaceAll(' ','-')} className="mt-2 text-3xl font-semibold">{value}</p><p className="mt-2 text-xs text-slate-500">{hint}</p></Panel>)}</div>}
 </section>
 <Panel title="Live today"><p className="mb-4 text-sm text-slate-500">Current queues in active businesses, branches and services, including paused queues. Uses today regardless of the historical date range. Updated when you refresh.</p>
 <dl className="grid grid-cols-3 gap-3">{Object.entries(data.live).map(([label,value])=><div key={label}><dt className="text-sm capitalize text-slate-500">{label}</dt><dd data-testid={'live-'+label} className="text-2xl font-semibold">{value}</dd></div>)}</dl></Panel>
 <Panel title="Queue volume by hour">
 {data.busiestHour?<><p className="mb-5" data-testid="busiest-hour">Busiest hour: <strong>{String(data.busiestHour.hour).padStart(2,'0')}:00–{String((data.busiestHour.hour+1)%24).padStart(2,'0')}:00</strong> · {data.busiestHour.joined} customers joined</p>
 <ol aria-label="Hourly admissions" className="space-y-2">{data.volume.map(bucket=><li key={bucket.hour} aria-label={String(bucket.hour).padStart(2,'0')+':00: '+bucket.joined+' admitted'} className="grid grid-cols-[3rem_minmax(0,1fr)_2rem] items-center gap-3 text-xs"><span>{String(bucket.hour).padStart(2,'0')}:00</span><span className="h-3 rounded bg-slate-100"><span aria-hidden="true" className="block h-full rounded bg-teal-600" style={{width:(bucket.joined/data.busiestHour!.joined*100)+'%'}}/></span><span>{bucket.joined}</span></li>)}</ol></>:<p className="text-sm text-slate-500">No admissions to chart for this selection.</p>}</Panel>
 <Performance title="Service performance" rows={data.byService}/><Performance title="Branch performance" rows={data.byBranch}/>
 <p className="text-xs text-slate-500">A dash means no valid duration samples. Requeued tickets use their first call after the last requeue, measured from original admission. Busiest-hour ties use the earliest hour. Last refreshed {new Date(data.generatedAt).toLocaleString()}.</p>
 </>}
 </div>;
}
