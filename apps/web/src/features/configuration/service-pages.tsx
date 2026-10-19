import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BusinessRole, counterCreateSchema, type ServiceDto, type CounterDto } from '@qevra/contracts';
import { useBusiness } from '../../components/layouts';
import { useResource } from '../../lib/use-resource';
import { request, errorMessage } from '../../lib/configuration-api';
import { PageTitle, Panel, ErrorNotice, Loading, Button, Badge, Field, money } from '../../components/ui';
import { ServiceForm } from './forms';
export function ServicesPage() {
  const { business } = useBusiness(), { branchId } = useParams(), navigate = useNavigate();
  const [create, setCreate] = useState(false);
  const path = '/businesses/' + business.id + '/branches/' + branchId + '/services';
  const resource = useResource<ServiceDto[]>(path);
  return <><PageTitle title="Services" description="Independent service offerings for this branch." actions={business.role !== BusinessRole.STAFF && <Button onClick={() => setCreate(value => !value)}>{create ? 'Close form' : 'Create service'}</Button>} />
    {create && <div className="mb-6 max-w-2xl"><Panel title="New service"><ServiceForm label="Create service" save={async body => {
      const service = await request<ServiceDto>(path, { method: 'POST', body }); navigate('/app/' + business.id + '/branches/' + branchId + '/services/' + service.id + '/settings');
    }} /></Panel></div>}
    <ErrorNotice message={resource.error} />{resource.loading ? <Loading /> : resource.data?.length ? <div className="grid gap-4 lg:grid-cols-2">{resource.data.map(service => <Panel key={service.id}><div className="flex justify-between gap-3"><h2 className="text-lg font-semibold">{service.name}</h2><Badge active={service.is_active} /></div><p className="mt-3 text-slate-700">{money(service.price_amount)} <span className="text-sm text-slate-500">· ~{service.estimated_duration_minutes} min</span></p><p className="mt-2 text-xs text-slate-500">Prefix {service.queue_prefix} · Payment {service.payment_mode}</p><Link className="mt-5 inline-block text-sm font-medium text-teal-800" to={'/app/' + business.id + '/branches/' + branchId + '/services/' + service.id + '/settings'}>{business.role === BusinessRole.STAFF ? 'View service' : 'Settings & counters'} →</Link><Link className="ml-5 text-sm font-medium text-teal-800" to={'/app/' + business.id + '/branches/' + branchId + '/services/' + service.id + '/queue'}>Open queue →</Link></Panel>)}</div> : !resource.error && <Panel><p className="text-slate-500">No services are available in your assigned scope yet.</p></Panel>}</>;
}
function CounterRow({ counter, path, changed, canWrite }: { counter: CounterDto; path: string; changed: () => void; canWrite: boolean }) {
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const parsed = counterCreateSchema.safeParse({ name: form.get('name'), is_active: form.has('is_active') });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(' ')); return; }
    if (counter.is_active && !parsed.data.is_active && !window.confirm('Deactivate this counter? It will no longer be available for new calls.')) return;
    setBusy(true); setError(null);
    try { await request(path + '/' + counter.id, { method: 'PATCH', body: parsed.data }); changed(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  if (!canWrite) return <div className="flex justify-between border-b border-slate-100 py-3"><span>{counter.name}</span><Badge active={counter.is_active} /></div>;
  return <form onSubmit={event => { void submit(event); }} className="border-b border-slate-100 py-4"><div className="flex flex-wrap items-end gap-3"><div className="min-w-40 flex-1"><Field label="Counter name"><input className="input" name="name" required maxLength={120} defaultValue={counter.name} /></Field></div><label className="flex items-center gap-2 py-2 text-sm"><input name="is_active" type="checkbox" defaultChecked={counter.is_active} />Active</label><Button disabled={busy} type="submit">Save counter</Button></div><ErrorNotice message={error} /></form>;
}
function Counters({ path, canWrite }: { path: string; canWrite: boolean }) {
  const resource = useResource<CounterDto[]>(path);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    const parsed = counterCreateSchema.safeParse({ name: data.get('name'), is_active: true });
    if (!parsed.success) { setError(parsed.error.issues.map(i => i.message).join(' ')); return; }
    setBusy(true); setError(null);
    try { await request(path, { method: 'POST', body: parsed.data }); form.reset(); resource.reload(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <Panel title="Serving capacity"><p className="mb-4 text-sm text-slate-500">Counters can represent stylists, chairs, rooms or service desks. Active capacity: <strong>{resource.data?.filter(c => c.is_active).length ?? '…'}</strong></p>
    <ErrorNotice message={resource.error || error} />{resource.loading ? <Loading /> : resource.data?.map(counter => <CounterRow key={counter.id + counter.name + counter.is_active} counter={counter} path={path} changed={resource.reload} canWrite={canWrite} />)}
    {resource.data?.length === 0 && <p className="mb-4 text-sm text-slate-500">No counters configured.</p>}
    {canWrite && <form onSubmit={event => { void add(event); }} className="mt-5 flex flex-wrap items-end gap-3"><div className="min-w-40 flex-1"><Field label="New counter name"><input className="input" name="name" required maxLength={120} placeholder="Stylist station 1" /></Field></div><Button type="submit" disabled={busy}>Add counter</Button></form>}
  </Panel>;
}
export function ServiceSettingsPage() {
  const { business } = useBusiness(), { branchId, serviceId } = useParams();
  const path = '/businesses/' + business.id + '/branches/' + branchId + '/services/' + serviceId;
  const resource = useResource<ServiceDto>(path), canWrite = business.role !== BusinessRole.STAFF;
  if (resource.loading) return <Loading />;
  if (!resource.data) return <ErrorNotice message={resource.error} />;
  const service = resource.data;
  return <><PageTitle title={service.name} actions={<Link className="button" to={'/app/' + business.id + '/branches/' + branchId + '/services/' + serviceId + '/queue'}>Open queue</Link>} description={canWrite ? 'Configure this service and its serving capacity.' : 'Assigned service · read-only configuration'} /><div className="grid gap-6 xl:grid-cols-2">
    <Panel title="Service settings">{canWrite ? <ServiceForm key={service.id} initial={service} save={async body => { await request(path, { method: 'PATCH', body }); resource.reload(); }} /> : <div className="space-y-3"><p>{service.description}</p><p>{money(service.price_amount)} · ~{service.estimated_duration_minutes} min</p><Badge active={service.is_active} /></div>}</Panel>
    <Counters path={path + '/counters'} canWrite={canWrite} />
  </div></>;
}
