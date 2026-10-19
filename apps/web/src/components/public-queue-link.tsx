import {useState} from 'react';
import {Button,ErrorNotice} from './ui';
export function PublicQueueLink({slug,active}:{slug:string;active:boolean}){
 const url=new URL('/q/'+encodeURIComponent(slug),window.location.origin).href;
 const [copied,setCopied]=useState(false),[error,setError]=useState<string|null>(null);
 async function copy(){try{await navigator.clipboard.writeText(url);setCopied(true);setError(null);}catch{setError('Unable to copy automatically. Select and copy the link above.');}}
 return <><p className="break-all rounded-lg bg-slate-50 p-3 text-sm text-teal-800" data-testid="public-queue-url">{url}</p>
 <div className="mt-4 flex flex-wrap gap-3"><Button onClick={()=>{void copy();}}>Copy Link</Button><a className="button" href={url} target="_blank" rel="noreferrer">Open Public Page</a></div>
 {copied&&<p role="status" className="mt-3 text-sm text-teal-800">Link copied.</p>}<ErrorNotice message={error}/>
 <p className="mt-3 text-sm text-slate-500">{active?'Share this link with customers. Open a service queue to start accepting customers.':'This branch is currently hidden from public visitors.'}</p></>;
}
