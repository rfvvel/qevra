import {Link,Outlet,useLocation} from 'react-router-dom';
import {TicketShortcut} from './shortcut';
export function CustomerLayout(){
  const location=useLocation();
  return <div className="min-h-screen bg-slate-50"><header className="border-b border-slate-200 bg-white"><div className="mx-auto max-w-3xl px-5 py-5"><Link to="/" className="text-xl font-bold tracking-tight text-teal-800">Qevra</Link></div></header><main className="mx-auto max-w-3xl px-5 py-8">{!location.pathname.startsWith('/ticket/')&&<TicketShortcut key={location.pathname}/>}<Outlet/></main><footer className="px-5 py-6 text-center text-xs text-slate-500">A little less waiting.</footer></div>;
}
