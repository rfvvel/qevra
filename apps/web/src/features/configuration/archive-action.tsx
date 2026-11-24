import {useRef,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {request,errorMessage} from '../../lib/configuration-api';
import {ErrorNotice} from '../../components/ui';

type Props = {path:string; name:string; business:string; branch?:string; destination:string};
export function ArchiveAction({path,name,business,branch,destination}:Props) {
  const dialog=useRef<HTMLDialogElement>(null), sending=useRef(false);
  const navigate=useNavigate();
  const [typed,setTyped]=useState(''),[busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null),[done,setDone]=useState(false);
  const [counts,setCounts]=useState<{branches:number;services:number}|null>(null);
  const kind=branch?'service':'business';
  async function open() {
    setTyped(''); setError(null); setCounts(null);
    dialog.current?.showModal();
    if (!branch) {
      try { setCounts(await request(path+'/archive-counts')); }
      catch(e) { setError(errorMessage(e)); }
    }
  }
  async function confirm() {
    if (sending.current || (!branch && typed!==name)) return;
    sending.current=true; setBusy(true); setError(null);
    try {
      await request(path,{method:'DELETE',body:{name:branch?name:typed}});
      setDone(true);
    } catch(e) { setError(errorMessage(e)); }
    finally { sending.current=false; setBusy(false); }
  }
  const finish=()=>navigate(destination,{replace:true});
  return <section className="mt-6">
    <button className="rounded-lg border border-red-700 px-4 py-2 text-red-800" onClick={()=>void open()}>Delete {kind}</button>
    <dialog ref={dialog} aria-label={'Delete '+kind} className="m-auto max-w-md rounded-xl p-6 shadow-xl backdrop:bg-black/40"
      onCancel={e=>{if(busy)e.preventDefault();else if(done)finish();}}>
      {done?<><p role="status">{name} has been archived.</p><button className="button mt-4" onClick={finish}>Continue</button></>:<>
        <h2 className="text-xl font-semibold">Archive {name}?</h2>
        <p className="my-3">{branch?business+' / '+branch:business} will stop accepting new customers{branch?' for this service':' across all its branches and services'}. Queue history, tickets and payments are retained.</p>
        {counts&&<p>{counts.branches} branches and {counts.services} unarchived services affected.</p>}
        {!branch&&<label>Type the exact business name <strong>{name}</strong><input className="input" value={typed} onChange={e=>setTyped(e.target.value)}/></label>}
        <ErrorNotice message={error}/>
        <div className="mt-4 flex gap-3"><button className="button" disabled={busy} onClick={()=>dialog.current?.close()}>Cancel</button>
        <button className="rounded-lg bg-red-700 px-4 py-2 text-white disabled:opacity-50" disabled={busy||(!branch&&(typed!==name||!counts))} onClick={()=>void confirm()}>{busy?'Archiving…':'Confirm archive'}</button></div>
      </>}
    </dialog>
  </section>;
}
