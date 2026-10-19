import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { assignmentsSchema, memberByEmailSchema, memberPatchSchema, BusinessRole, type MemberDto, type BranchDto, type ServiceDto } from '@qevra/contracts';
import { useBusiness } from '../../components/layouts';
import { useAuth } from '../../app/auth-context';
import { useResource } from '../../lib/use-resource';
import { request, errorMessage } from '../../lib/configuration-api';
import { PageTitle, Panel, ErrorNotice, Loading, Button, Field, Badge } from '../../components/ui';
function MemberEditor({ member, branches, services, base, reload }: { member: MemberDto; branches: BranchDto[]; services: ServiceDto[]; base: string; reload: () => void }) {
  const [branchIds, setBranchIds] = useState(member.branch_ids), [serviceIds, setServiceIds] = useState(member.service_ids);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const { session } = useAuth(), navigate = useNavigate();
  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    const parsed = memberPatchSchema.safeParse({ role: form.get('role'), is_active: form.has('is_active') });
    if (!parsed.success) { setError('Choose a valid role.'); return; }
    if ((parsed.data.role !== member.role || parsed.data.is_active === false) && !window.confirm('Change this member’s access? Role changes and deactivation clear their branch and service assignments.')) return;
    setBusy(true); setError(null);
    try {
      await request(base + '/members/' + member.id, { method: 'PATCH', body: parsed.data });
      if (session?.user.id === member.user_id && (parsed.data.role !== 'OWNER' || !parsed.data.is_active)) navigate('/app');
      else reload();
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function assign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = assignmentsSchema.safeParse({ branch_ids: branchIds, service_ids: member.role === 'STAFF' ? serviceIds : [] });
    if (!parsed.success) { setError('Check branch and service assignments.'); return; }
    setBusy(true); setError(null);
    try { await request(base + '/members/' + member.id + '/assignments', { method: 'PUT', body: parsed.data }); reload(); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  function toggleBranch(id: string, checked: boolean) {
    const next = checked ? [...branchIds, id] : branchIds.filter(value => value !== id);
    setBranchIds(next);
    setServiceIds(current => current.filter(serviceId => services.some(service => service.id === serviceId && next.includes(service.branch_id))));
  }
  return <Panel><div className="mb-4 flex justify-between gap-3"><div><h2 className="font-semibold">{member.display_name}</h2><p className="mt-1 break-all text-xs text-slate-500">{member.normalized_email || 'Email unavailable'}</p></div><Badge active={member.is_active} /></div>
    <form onSubmit={event => { void update(event); }} className="flex flex-wrap items-end gap-3"><div className="min-w-36 flex-1"><Field label="Member role"><select className="input" name="role" defaultValue={member.role}>{Object.values(BusinessRole).map(role => <option key={role}>{role}</option>)}</select></Field></div><label className="flex items-center gap-2 py-2 text-sm"><input name="is_active" type="checkbox" defaultChecked={member.is_active} />Member active</label><Button disabled={busy} type="submit">Save member</Button></form>
    <p className="mt-3 text-xs text-slate-500">Changing a role or deactivating a member clears their branch/service assignments.</p>
    {member.role !== 'OWNER' && member.is_active && <form onSubmit={event => { void assign(event); }} className="mt-5 border-t border-slate-100 pt-5">
      <fieldset><legend className="mb-3 text-sm font-medium">Assigned branches</legend><div className="space-y-2">{branches.map(branch => <label key={branch.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={branchIds.includes(branch.id)} onChange={event => toggleBranch(branch.id, event.target.checked)} />{branch.name}</label>)}{!branches.length && <p className="text-sm text-slate-500">Create a branch first.</p>}</div></fieldset>
      {member.role === 'STAFF' && <fieldset className="mt-5"><legend className="mb-3 text-sm font-medium">Assigned services</legend><div className="space-y-2">{services.filter(service => branchIds.includes(service.branch_id)).map(service => <label key={service.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={serviceIds.includes(service.id)} onChange={event => setServiceIds(current => event.target.checked ? [...current, service.id] : current.filter(id => id !== service.id))} />{branches.find(branch => branch.id === service.branch_id)?.name} · {service.name}</label>)}</div><p className="mt-2 text-xs text-slate-500">Staff can read only selected services, and cannot change configuration.</p></fieldset>}
      <Button disabled={busy} type="submit" className="mt-5">Save assignments</Button>
    </form>}<ErrorNotice message={error} />
  </Panel>;
}
export function StaffPage() {
  const { business } = useBusiness();
  if (business.role !== BusinessRole.OWNER) return <ErrorNotice message="Only owners can manage business members." />;
  return <StaffManagement businessId={business.id} />;
}
function StaffManagement({ businessId }: { businessId: string }) {
  const base = '/businesses/' + businessId;
  const members = useResource<MemberDto[]>(base + '/members'), branches = useResource<BranchDto[]>(base + '/branches');
  const [servicesLoading, setServicesLoading] = useState(true);
  const [services, setServices] = useState<ServiceDto[]>([]), [serviceError, setServiceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!branches.data) return;
    let active = true; setServicesLoading(true); setServiceError(null); setServices([]);
    void Promise.all(branches.data.map(branch => request<ServiceDto[]>(base + '/branches/' + branch.id + '/services'))).then(items => { if (active) { setServices(items.flat()); setServicesLoading(false); } }).catch(error => { if (active) { setServiceError(errorMessage(error)); setServicesLoading(false); } });
    return () => { active = false; };
  }, [branches.data, base]);
  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, data = new FormData(form);
    const parsed = memberByEmailSchema.safeParse({ email: data.get('email'), role: data.get('role') });
    if (!parsed.success) { setError('Enter a valid registered email and choose a role.'); return; }
    setBusy(true); setError(null);
    try { await request(base + '/members/by-email', { method: 'POST', body: parsed.data }); form.reset(); members.reload(); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <><PageTitle title="Team & access" description="Add existing confirmed users and control their business, branch and service access." />
    <div className="mb-6"><Panel title="Add a registered team member"><p className="mb-4 text-sm text-slate-500">Ask your team member to register and confirm their email first. Enter that exact email below. Invitations are not sent.</p>
      <form onSubmit={event => { void add(event); }} className="flex flex-wrap items-end gap-3"><div className="min-w-48 flex-1"><Field label="Member email"><input className="input" name="email" type="email" autoComplete="off" required maxLength={254} /></Field></div><Field label="New member role"><select aria-label="New member role" className="input" name="role" defaultValue="STAFF">{[BusinessRole.MANAGER,BusinessRole.STAFF].map(role => <option key={role}>{role}</option>)}</select></Field><Button disabled={busy} type="submit">Add member</Button></form><ErrorNotice message={error} /></Panel></div>
    <ErrorNotice message={members.error || branches.error || serviceError} />{members.error || branches.error || serviceError ? null : members.loading || branches.loading || servicesLoading ? <Loading /> : <div className="space-y-5">{members.data?.map(member => <MemberEditor key={member.id + JSON.stringify(member)} member={member} branches={branches.data || []} services={services} base={base} reload={members.reload} />)}</div>}
  </>;
}
