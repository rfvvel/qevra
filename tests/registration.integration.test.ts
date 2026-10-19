import assert from 'node:assert/strict';
import {test,mock} from 'node:test';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import pg from 'pg';
import type {BusinessDto,MemberDto,BranchDto,ServiceDto} from '@qevra/contracts';
test('Phase 8 registration profiles and private team email assignment',{skip:!process.env.TEST_DATABASE_URL},async t=>{
 process.env.NODE_ENV='test';process.env.SUPABASE_URL='https://example.supabase.co';process.env.SUPABASE_PUBLISHABLE_KEY='test-public-key';
 const {createApp}=await import('../apps/api/src/app.js'),{getSupabaseAuth}=await import('../apps/api/src/config/supabase.js');
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,max:1,connectionTimeoutMillis:15000}),c=await pool.connect();
 const [owner,staff,manager,outsider,unconfirmed,anonymous]=Array.from({length:6},()=>randomUUID()) as [string,string,string,string,string,string];
 const email=(id:string)=>id+'@example.test';let serial:Promise<unknown>=Promise.resolve();
 await c.query('BEGIN');
 async function run<T>(op:(client:pg.PoolClient)=>Promise<T>){const job=serial.then(async()=>{await c.query('SAVEPOINT request');try{const v=await op(c);await c.query('RELEASE SAVEPOINT request');return v;}catch(e){await c.query('ROLLBACK TO SAVEPOINT request');throw e;}});serial=job.catch(()=>{});return job;}
 const auth=mock.method(getSupabaseAuth().auth,'getUser',async(token:string)=>[owner,staff,manager,outsider,unconfirmed,anonymous].includes(token)?{data:{user:{id:token,is_anonymous:token===anonymous}},error:null}:{data:{user:null},error:new Error('Invalid')});
 const server=createApp({runTransaction:run}).listen(0,'127.0.0.1');await once(server,'listening');
 async function api<T>(user:string,path:string,method='GET',body?:unknown,status=200):Promise<T>{const r=await fetch('http://127.0.0.1:'+(server.address() as AddressInfo).port+'/api/v1'+path,{method,headers:{Authorization:'Bearer '+user,'Content-Type':'application/json',Origin:'https://untrusted.example'},body:body===undefined?undefined:JSON.stringify(body)});assert.equal(r.status,status,path);assert.notEqual(r.headers.get('access-control-allow-origin'),'https://untrusted.example');return await r.json() as T;}
 let business:BusinessDto,other:BusinessDto,member:MemberDto,branch:BranchDto,foreignBranch:BranchDto,service:ServiceDto;
 try{
  for(const id of [owner,staff,manager,outsider,unconfirmed,anonymous])await c.query("INSERT INTO auth.users(id,email,is_anonymous,email_confirmed_at,raw_user_meta_data) VALUES($1,$2,$3,$4,$5)",[id,email(id),id===anonymous,id===unconfirmed?null:new Date(),{full_name:'Registered '+(id===owner?'Owner':'Staff'),role:'OWNER'}]);
  await t.test('Auth creates canonical profiles, metadata grants no memberships, anonymous gets no profile',async()=>{
   const p=(await c.query('SELECT * FROM public.profiles WHERE user_id=$1',[owner])).rows[0];assert.equal(p.display_name,'Registered Owner');assert.equal(p.normalized_email,email(owner));assert.ok(p.created_at);
   assert.equal((await c.query('SELECT 1 FROM public.profiles WHERE user_id=$1',[anonymous])).rowCount,0);
   assert.deepEqual(await api(staff,'/businesses'),[]);
  });
  await t.test('registered owner creates business and gets OWNER without manual profile work',async()=>{
   business=await api<BusinessDto>(owner,'/businesses','POST',{name:'Registration business',slug:'register-'+owner},201);
   other=await api<BusinessDto>(outsider,'/businesses','POST',{name:'Other business',slug:'register-'+outsider},201);assert.equal(business.role,'OWNER');
   branch=await api<BranchDto>(owner,'/businesses/'+business.id+'/branches','POST',{name:'Main',public_slug:'register-'+staff},201);
   foreignBranch=await api<BranchDto>(outsider,'/businesses/'+other.id+'/branches','POST',{name:'Other',public_slug:'register-'+manager},201);
   service=await api<ServiceDto>(owner,'/businesses/'+business.id+'/branches/'+branch.id+'/services','POST',{name:'Service',price_amount:'0',estimated_duration_minutes:20,queue_prefix:'S'},201);
  });
  await t.test('exact normalized email adds registered staff and rejects duplicates and unknown/unconfirmed accounts',async()=>{
   const path='/businesses/'+business.id+'/members/by-email';
   member=await api<MemberDto>(owner,path,'POST',{email:' '+email(staff).toUpperCase()+' ',role:'STAFF'},201);
   assert.equal(member.user_id,staff);assert.equal(member.normalized_email,email(staff));assert.equal(member.role,'STAFF');
   await api(owner,path,'POST',{email:email(staff),role:'STAFF'},409);
   for(const address of [email(unconfirmed),email(anonymous),'missing-'+email(owner)]){const r=await api<{error:{code:string;message:string}}>(owner,path,'POST',{email:address,role:'STAFF'},404);assert.equal(r.error.code,'ACCOUNT_NOT_FOUND');assert.ok(r.error.message.includes('register first'));}
   await api(owner,path,'POST',{email:email(manager),role:'OWNER'},400);
  });
  await t.test('manager addition, branch/service assignment and tenant boundary enforced',async()=>{
   await api(owner,'/businesses/'+business.id+'/members/by-email','POST',{email:email(manager),role:'MANAGER'},201);
   const path='/businesses/'+business.id+'/members/'+member.id+'/assignments';
   await api(owner,path,'PUT',{branch_ids:[foreignBranch.id],service_ids:[]},400);
   await api(owner,path,'PUT',{branch_ids:[branch.id],service_ids:[service.id]});
   assert.equal((await api<BranchDto[]>(staff,'/businesses/'+business.id+'/branches')).length,1);
   await api(staff,'/businesses/'+business.id+'/branches/'+branch.id,'PATCH',{name:'Forbidden'},403);
   await api(staff,'/businesses/'+business.id+'/analytics','GET',undefined,403);
   await api(outsider,path,'PUT',{branch_ids:[],service_ids:[]},404);
  });
  await t.test('lookup is never public, manager-accessible or cross-business',async()=>{
   const path='/businesses/'+business.id+'/members/by-email',body={email:email(staff),role:'STAFF'};
   await api('invalid',path,'POST',body,401);await api(anonymous,path,'POST',body,403);await api(staff,path,'POST',body,403);await api(manager,path,'POST',body,403);await api(outsider,path,'POST',body,404);
   await api(owner,'/public/users?email='+email(staff),'GET',undefined,404);
  });
  await t.test('Auth email/name updates synchronize; browser database access remains denied',async()=>{
   const next='updated-'+email(staff);await c.query('UPDATE auth.users SET email=$2,raw_user_meta_data=$3 WHERE id=$1',[staff,next,{full_name:'Updated Staff'}]);
   const p=(await c.query('SELECT * FROM public.profiles WHERE user_id=$1',[staff])).rows[0];assert.equal(p.normalized_email,next);assert.equal(p.display_name,'Updated Staff');
   await c.query('SAVEPOINT permissions');await c.query('SET LOCAL ROLE authenticated');
   await assert.rejects(c.query('SELECT normalized_email FROM public.profiles'),{code:'42501'});await c.query('ROLLBACK TO SAVEPOINT permissions');
  });
  await t.test('last owner remains protected and deactivation clears assignments',async()=>{
   const members=await api<MemberDto[]>(owner,'/businesses/'+business.id+'/members');const own=members.find(m=>m.user_id===owner)!;
   await api(owner,'/businesses/'+business.id+'/members/'+own.id,'PATCH',{is_active:false},409);
   await api(owner,'/businesses/'+business.id+'/members/'+member.id,'PATCH',{is_active:false});
   await api(staff,'/businesses/'+business.id+'/branches','GET',undefined,404);
  });
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));auth.mock.restore();await serial;await c.query('ROLLBACK');c.release();await pool.end();}
});
