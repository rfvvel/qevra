import { PublicQueueLink } from '../../components/public-queue-link';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';
import { BusinessRole, type BranchDto } from '@qevra/contracts';
import { useBusiness } from '../../components/layouts';
import { useResource } from '../../lib/use-resource';
import { request } from '../../lib/configuration-api';
import { PageTitle, Panel, Badge, ErrorNotice, Loading, Button } from '../../components/ui';
import { BranchForm } from './forms';
export function BranchesPage() {
  const { business } = useBusiness(), navigate = useNavigate();
  const [create, setCreate] = useState(false);
  const resource = useResource<BranchDto[]>('/businesses/' + business.id + '/branches');
  return <><PageTitle title="Branches" description="Each location has its own public link, services and capacity." actions={business.role !== BusinessRole.STAFF && <Button onClick={() => setCreate(value => !value)}>{create ? 'Close form' : 'Create branch'}</Button>} />
    {create && <div className="mb-6 max-w-2xl"><Panel title="New branch"><BranchForm label="Create branch" save={async body => {
      const branch = await request<BranchDto>('/businesses/' + business.id + '/branches', { method: 'POST', body }); navigate('/app/' + business.id + '/branches/' + branch.id);
    }} /></Panel></div>}
    <ErrorNotice message={resource.error} />{resource.loading ? <Loading /> : resource.data?.length ? <div className="grid gap-4 lg:grid-cols-2">{resource.data.map(branch => <Panel key={branch.id}><div className="flex justify-between gap-3"><h2 className="text-lg font-semibold">{branch.name}</h2><Badge active={branch.is_active} /></div><p className="mt-3 text-sm text-slate-500">{branch.address || 'No address added'}</p><p className="mt-1 text-xs text-slate-500">{branch.timezone}</p><Link className="mt-5 inline-block text-sm font-medium text-teal-800" to={'/app/' + business.id + '/branches/' + branch.id}>Open branch →</Link></Panel>)}</div> : !resource.error && <Panel><p className="text-slate-500">No branches are available for your account yet.</p></Panel>}</>;
}
export function BranchDetailPage() {
  const { business } = useBusiness(), { branchId } = useParams();
  const path = '/businesses/' + business.id + '/branches/' + branchId;
  const resource = useResource<BranchDto>(path);
  if (resource.loading) return <Loading />;
  if (!resource.data) return <ErrorNotice message={resource.error} />;
  const branch = resource.data;
  return <><PageTitle title={branch.name} description={branch.timezone} actions={<Link className="button" to={'/app/' + business.id + '/branches/' + branch.id + '/services'}>View services</Link>} />
    <div className="mb-6"><Panel title="Customer Queue Link"><PublicQueueLink slug={branch.public_slug} active={branch.is_active && business.status === 'ACTIVE'}/></Panel></div>
    {business.role !== BusinessRole.STAFF ? <div className="max-w-2xl"><Panel title="Branch settings"><BranchForm key={branch.id} initial={branch} save={async body => { await request(path, { method: 'PATCH', body }); resource.reload(); }} /></Panel></div> : <Panel><p>{branch.address || 'No address added'}</p><p className="mt-3 text-sm text-slate-500">Your staff access is read-only for configuration.</p></Panel>}</>;
}
