import {readFileSync} from 'node:fs';
import {parse} from 'dotenv';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {uuidSchema} from '@qevra/contracts';
const config=parse(readFileSync('apps/api/.env'));
const production=process.env.NODE_ENV==='production' || config.NODE_ENV==='production';
Object.assign(process.env,config);
const [flag,businessId,branchId,serviceId,countText='5']=process.argv.slice(2);
if(flag!=='--development' || production){
  console.error('Usage: npm run seed:queue -- --development BUSINESS_ID BRANCH_ID SERVICE_ID [COUNT]. Development only.');
  process.exit(1);
}
const count=Number(countText);
if(![businessId,branchId,serviceId].every(id=>uuidSchema.safeParse(id).success)||!Number.isInteger(count)||count<1||count>20){
  console.error('Provide valid IDs and a count between 1 and 20.');process.exit(1);
}
const pool=new pg.Pool({connectionString:config.DATABASE_URL,max:1,connectionTimeoutMillis:10000});
let client;
try{
  if(!config.TEST_STAFF_EMAIL || !config.TEST_STAFF_PASSWORD)throw new Error('TEST_CREDENTIALS_REQUIRED');
  const auth=createClient(config.SUPABASE_URL,config.SUPABASE_PUBLISHABLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data,error}=await auth.auth.signInWithPassword({email:config.TEST_STAFF_EMAIL,password:config.TEST_STAFF_PASSWORD});
  if(error || !data.user || data.user.is_anonymous)throw new Error('STAFF_AUTH_FAILED');
  const {admitJoinRequest}=await import('../apps/api/src/modules/queues/admission.ts');
  const {authorizeQueue,lockQueueContext}=await import('../apps/api/src/modules/queues/context.ts');
  const {session,requireOpen}=await import('../apps/api/src/modules/queues/engine.ts');
  client=await pool.connect();await client.query('BEGIN');
  const ids={businessId,branchId,serviceId},actor={userId:data.user.id,type:'STAFF'};
  await authorizeQueue(client,ids,actor.userId);
  const context=await lockQueueContext(client,ids),current=await session(client,context);requireOpen(context,current);
  if(context.paymentMode!=='NONE')throw new Error('PAYMENT_MODE_MUST_BE_NONE');
  for(let index=0;index<count;index++){
    const customer=randomUUID();
    // Synthetic development identities have no usable password/session. They are
    // deliberately never supplied to a customer or treated as real Auth sessions.
    await client.query("INSERT INTO auth.users(id,is_anonymous,raw_user_meta_data) VALUES($1,true,$2)",[customer,JSON.stringify({qevraDevelopmentFixture:true})]);
    const joined=(await client.query(`INSERT INTO public.join_requests(business_id,branch_id,service_id,queue_session_id,customer_auth_id,customer_name,status,payment_mode_snapshot,price_snapshot,amount_due,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'READY','NONE',$7,0,clock_timestamp()+interval '1 hour') RETURNING id`,
      [businessId,branchId,serviceId,current.id,customer,'Demo customer '+(index+1),context.price])).rows[0];
    await admitJoinRequest(client,ids,actor,joined.id);
  }
  await client.query('COMMIT');console.log('Created '+count+' development WAITING tickets. Refresh the staff queue.');
  await auth.auth.signOut({scope:'local'});
}catch(error){
  if(client)await client.query('ROLLBACK');
  const allowed=['TEST_CREDENTIALS_REQUIRED','STAFF_AUTH_FAILED','PAYMENT_MODE_MUST_BE_NONE'];
  console.error(allowed.includes(error?.message)?error.message:'Demo creation failed. Check staff access, active service, open session and development configuration.');
  process.exitCode=1;
}finally{client?.release();await pool.end();}
