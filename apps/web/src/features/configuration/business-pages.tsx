import { Link, useNavigate } from 'react-router-dom';
import { BusinessRole, type BusinessDto } from '@qevra/contracts';
import { useResource } from '../../lib/use-resource';
import { request } from '../../lib/configuration-api';
import { PageTitle, Panel, Badge, ErrorNotice, Loading } from '../../components/ui';
import { useBusiness } from '../../components/layouts';
import { BusinessForm } from './forms';
export function BusinessSelectorPage() {
  const resource = useResource<BusinessDto[]>('/businesses');
  return <><PageTitle title="Your businesses" description="Choose a workspace to configure branches, services and team access." actions={<Link className="button" to="/app/onboarding">Create business</Link>} />
    <ErrorNotice message={resource.error} />{resource.loading ? <Loading /> : resource.data?.length ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{resource.data.map(item => <Link key={item.id} to={'/app/' + item.id} className="rounded-xl border border-slate-200 bg-white p-6 transition hover:border-teal-400"><div className="mb-5 flex justify-between gap-2"><span className="text-xs font-medium text-teal-700">{item.role}</span><Badge active={item.status === 'ACTIVE'} /></div><h2 className="text-xl font-semibold">{item.name}</h2><p className="mt-1 text-sm text-slate-500">{item.slug}</p><p className="mt-6 text-sm font-medium text-teal-800">Open workspace →</p></Link>)}</div> : !resource.error && <Panel><p className="text-slate-600">Welcome to Qevra. Create your first business, or ask an owner to add your registered email. You have not been assigned to a business yet.</p></Panel>}</>;
}
export function OnboardingPage() {
  const navigate = useNavigate();
  return <div className="max-w-2xl"><PageTitle title="Create your business" description="You will automatically become its owner." /><Panel><BusinessForm label="Create business" save={async body => {
    const business = await request<BusinessDto>('/businesses', { method: 'POST', body }); navigate('/app/' + business.id);
  }} /></Panel></div>;
}
export function BusinessOverviewPage() {
  const { business, reloadBusiness } = useBusiness();
  return <><PageTitle title={business.name} description="Set up your business, then welcome customers to your queue." />
    <div className="mb-6 grid gap-4 sm:grid-cols-2"><Panel title="Branches & services"><p className="mb-4 text-sm text-slate-500">Configure locations, service offerings and serving capacity.</p><Link className="text-sm font-medium text-teal-800" to={'/app/' + business.id + '/branches'}>Manage branches →</Link></Panel><Panel title="Your access"><p className="text-lg font-semibold">{business.role}</p><p className="mt-2 text-sm text-slate-500">{business.role === BusinessRole.OWNER ? 'Business-wide configuration and team management.' : 'Your branch and service assignments determine what you can access.'}</p></Panel></div>
    {business.role === BusinessRole.OWNER && <div className="mb-6"><Panel title="Get your first queue ready"><ol className="list-inside list-decimal space-y-2 text-sm text-slate-600"><li>Create a branch for your location.</li><li>Add a service and its counters.</li><li>Open the service queue.</li><li>Copy the Customer Queue Link from the branch page.</li></ol><Link className="button mt-5" to={'/app/' + business.id + '/branches'}>Set up branches & services</Link></Panel></div>}
    {business.role === BusinessRole.OWNER && <div className="max-w-2xl"><Panel title="Business information"><BusinessForm key={business.id} initial={business} save={async body => { await request('/businesses/' + business.id, { method: 'PATCH', body }); reloadBusiness(); }} /></Panel></div>}</>;
}
