import {build,preview} from 'vite';
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const outDir=await mkdtemp(join(tmpdir(),'qevra-archive-'));
let server,browser;
try {
  await build({root:'apps/web',envDir:false,define:{
    'import.meta.env.VITE_SUPABASE_URL':JSON.stringify('https://offline.example.test'),
    'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify('offline-key'),
    'import.meta.env.VITE_API_URL':JSON.stringify('/api/v1')
  },build:{outDir}});
  server=await preview({root:'apps/web',configFile:false,envDir:false,build:{outDir},preview:{host:'127.0.0.1',port:0}});
  const origin='http://127.0.0.1:'+server.httpServer.address().port;
  browser=await chromium.launch({channel:'chrome'});
  for(const kind of ['service','business']){
    const page=await browser.newPage();
    const biz={id:randomUUID(),name:'Demo Business',slug:'demo',role:'OWNER',status:'ACTIVE'};
    const branch={id:randomUUID(),name:'Demo Branch'};
    const service={id:randomUUID(),name:'Demo Service',is_active:true,price_amount:'0',currency:'IDR',payment_mode:'NONE',estimated_duration_minutes:10,queue_prefix:'Q'};
    const base='/businesses/'+biz.id,branchPath=base+'/branches/'+branch.id,servicePath=branchPath+'/services/'+service.id;
    const target=kind==='business'?base:servicePath;
    const name=kind==='business'?biz.name:service.name;
    let calls=0;
    const expires=Math.floor(Date.now()/1000)+3600,user=randomUUID();
    const token=[{alg:'HS256',typ:'JWT'},{sub:user,exp:expires},'demo'].map(v=>Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
    await page.addInitScript(session=>localStorage.setItem('sb-offline-auth-token',JSON.stringify(session)),{access_token:token,refresh_token:'offline',expires_at:expires,user:{id:user,is_anonymous:false}});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());
      if(url.origin!==origin)return route.abort();
      if(!url.pathname.startsWith('/api/v1'))return route.continue();
      const path=url.pathname.slice(7);
      if(route.request().method()==='DELETE'){
        assert.equal(path,target);assert.deepEqual(route.request().postDataJSON(),{name});calls++;
        if(calls===1)return route.fulfill({status:409,json:{error:{message:'Active work remains.'}}});
        return route.fulfill({json:{archived:true}});
      }
      const data=new Map([['/businesses',[biz]],[base,biz],[branchPath,branch],[servicePath,service],[base+'/archive-counts',{branches:1,services:1}]]);
      return route.fulfill({json:data.get(path)??[]});
    });
    await page.goto(origin+'/app/'+biz.id+(kind==='service'?'/branches/'+branch.id+'/services/'+service.id+'/settings':''));
    const open=page.getByRole('button',{name:'Delete '+kind});
    await open.click();
    const dialog=page.getByRole('dialog');
    await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
    assert.equal(calls,0);
    await open.click();
    const confirm=dialog.getByRole('button',{name:'Confirm archive'});
    if(kind==='business'){
      await dialog.getByText('1 branches and 1 unarchived services affected.').waitFor();
      await dialog.getByRole('textbox').fill(name.toLowerCase());assert.ok(await confirm.isDisabled());
      await dialog.getByRole('textbox').fill(name);
    }else await dialog.getByText('Demo Business / Demo Branch',{exact:false}).waitFor();
    await confirm.click();await dialog.getByText('Active work remains.').waitFor();
    await confirm.click();await dialog.getByText(name+' has been archived.').waitFor();
    await dialog.getByRole('button',{name:'Continue'}).click();
    await page.waitForURL(origin+(kind==='business'?'/app':'/app/'+biz.id+'/branches/'+branch.id+'/services'));
    assert.equal(calls,2);await page.close();
    console.log(kind+' dialog passed');
  }
} finally {
  await browser?.close();
  if(server)await new Promise(resolve=>server.httpServer.close(resolve));
  await rm(outDir,{recursive:true,force:true});
}
