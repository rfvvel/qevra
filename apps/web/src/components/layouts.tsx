import { Link, NavLink, Outlet, useNavigate, useParams, useOutletContext } from 'react-router-dom';
import { BusinessRole, type BusinessDto } from '@qevra/contracts';
import { useState } from 'react';
import { signOut } from '../lib/auth';
import { useResource } from '../lib/use-resource';
import { ErrorNotice, Loading } from './ui';
export function PublicLayout() {
  return <div className="min-h-screen"><header className="border-b border-slate-200 bg-white"><nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
    <Link to="/" className="text-xl font-bold tracking-tight text-teal-800">Qevra</Link><NavLink to="/app" className="text-sm font-medium text-slate-600">Business dashboard</NavLink>
  </nav></header><main className="mx-auto max-w-6xl px-6 py-12"><Outlet /></main><footer className="mx-auto max-w-6xl px-6 py-6 text-sm text-slate-500">Qevra · Virtual queues for service businesses</footer></div>;
}
export function BusinessLayout() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  async function logout() {
    setBusy(true);
    try { await signOut(); navigate('/login'); } catch { setError('Unable to sign out. Please try again.'); } finally { setBusy(false); }
  }
  return <div className="min-h-screen"><header className="border-b border-slate-200 bg-white"><div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-4">
    <Link to="/app" className="text-xl font-bold tracking-tight text-teal-800">Qevra<span className="ml-3 hidden text-sm font-normal text-slate-500 sm:inline">Business workspace</span></Link>
    <div className="flex items-center gap-4 text-sm"><Link to="/app" className="text-slate-600">All businesses</Link><button disabled={busy} onClick={() => { void logout(); }} className="font-medium text-slate-600 disabled:opacity-50">Sign out</button></div>
  </div></header><div className="mx-auto max-w-7xl px-4 py-8 sm:px-6"><ErrorNotice message={error} /><Outlet /></div></div>;
}
interface WorkspaceContext { business: BusinessDto; reloadBusiness: () => void; }
export const useBusiness = () => useOutletContext<WorkspaceContext>();
export function WorkspaceLayout() {
  const { businessId } = useParams(), navigate = useNavigate();
  const business = useResource<BusinessDto>('/businesses/' + businessId);
  const businesses = useResource<BusinessDto[]>('/businesses');
  if (business.loading) return <Loading />;
  if (!business.data) return <><ErrorNotice message={business.error} /><Link to="/app" className="text-teal-800 underline">Choose another business</Link></>;
  const base = '/app/' + businessId, data = business.data;
  return <div className="grid gap-8 md:grid-cols-[210px_minmax(0,1fr)]">
    <aside><label className="mb-6 block text-xs font-semibold uppercase tracking-wide text-slate-500">Business<select aria-label="Select business" className="input mt-2 text-sm font-normal normal-case tracking-normal" value={businessId} onChange={event => navigate('/app/' + event.target.value)}>
      {(businesses.data || [data]).map(item => <option key={item.id} value={item.id}>{item.id === data.id ? data.name : item.name}</option>)}
    </select></label><p className="mb-3 text-xs font-medium text-slate-500">{data.role} ACCESS</p>
    <nav aria-label="Workspace" className="flex flex-wrap gap-1 md:flex-col">
      <NavLink to={base} end className={({ isActive }) => 'nav-link ' + (isActive ? 'nav-active' : '')}>Overview</NavLink>
      <NavLink to={base + '/branches'} className={({ isActive }) => 'nav-link ' + (isActive ? 'nav-active' : '')}>Branches & services</NavLink>
      {data.role !== BusinessRole.STAFF && <NavLink to={base + '/analytics'} className={({ isActive }) => 'nav-link ' + (isActive ? 'nav-active' : '')}>Analytics</NavLink>}
      {data.role === BusinessRole.OWNER && <NavLink to={base + '/staff'} className={({ isActive }) => 'nav-link ' + (isActive ? 'nav-active' : '')}>Team & access</NavLink>}
    </nav></aside><div className="min-w-0">{data.status === 'INACTIVE' && <p className="mb-5 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">This business is inactive. Its public branches are unavailable.</p>}<Outlet context={{ business: data, reloadBusiness: business.reload } satisfies WorkspaceContext} /></div>
  </div>;
}
