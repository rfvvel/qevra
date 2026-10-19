import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parse} from 'dotenv';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium,expect as baseExpect} from '@playwright/test';
import assert from 'node:assert/strict';
const api=parse(readFileSync('apps/api/.env')),web=parse(readFileSync('apps/web/.env')),logs=[],result={};
const expect=baseExpect.configure({timeout:15000});let backend,preview,browser,stage='startup';
function observe(child){child.stdout.on('data',c=>logs.push(c.toString()));child.stderr.on('data',c=>logs.push(c.toString()));}
async function ready(url){for(let i=0;i<60;i++){try{if((await fetch(url,{signal:AbortSignal.timeout(1000)})).ok)return;}catch{/* Wait for local startup. */}await delay(250);}throw new Error('STARTUP_TIMEOUT');}
try{
 backend=spawn(process.execPath,[resolve('apps/api/dist/server.js')],{cwd:resolve('apps/api'),env:{...process.env,...api,NODE_ENV:'production',WEB_ORIGIN:'https://frontend.example',PORT:'3110',PAYMENT_PROVIDER:'MOCK',MOCK_WHATSAPP_ENABLED:'true'},stdio:['ignore','pipe','pipe'],windowsHide:true});observe(backend);
 await ready('http://localhost:3110/api/v1/health');
 assert.deepEqual(await(await fetch('http://localhost:3110/api/v1/health')).json(),{status:'ok',service:'qevra-api'});
 assert.equal((await fetch('http://localhost:3110/api/v1/health/database')).status,200);result.productionStartupAndHealth=true;
 for(const path of ['/payments/00000000-0000-4000-8000-000000000001/mock','/join-requests/00000000-0000-4000-8000-000000000001/payments'])assert.equal((await fetch('http://localhost:3110/api/v1/customer'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);
 assert.equal((await fetch('http://localhost:3110/api/v1/customer/tickets/00000000-0000-4000-8000-000000000001/mock-whatsapp')).status,404);result.productionMockEndpointsDisabled=true;
 const cors=await fetch('http://localhost:3110/api/v1/health',{headers:{Origin:'https://untrusted.example'}});assert.equal(cors.headers.get('access-control-allow-origin'),'https://frontend.example');result.explicitCors=true;
 const error=await fetch('http://localhost:3110/api/v1/businesses',{method:'POST',headers:{'Content-Type':'application/json'},body:'{'});
 const body=await error.json();assert.equal(error.status,400);assert.deepEqual(Object.keys(body),['error']);assert.equal(body.error.code,'INVALID_JSON');assert.ok(!JSON.stringify(body).includes('stack'));result.sanitizedErrors=true;
 preview=spawn(process.execPath,[resolve('node_modules/vite/bin/vite.js'),'preview','--host','localhost','--port','5182','--strictPort'],{cwd:resolve('apps/web'),stdio:['ignore','pipe','pipe'],windowsHide:true});observe(preview);await ready('http://localhost:5182');
 browser=await chromium.launch({channel:'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding']});const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(15000);
 page.on('console',m=>logs.push(m.text()));let signupMode='duplicate';
 // These two public Auth error/confirmation states are deterministic UI tests,
 // not replacements for the separate real-registration MVP scenario.
 await page.route('**/auth/v1/signup**',route=>route.fulfill({status:signupMode==='duplicate'?422:200,headers:{'x-supabase-api-version':'2024-01-01','access-control-allow-origin':'http://localhost:5182','access-control-expose-headers':'X-Supabase-Api-Version','access-control-allow-headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','access-control-allow-methods':'POST,OPTIONS'},contentType:'application/json',body:JSON.stringify(signupMode==='duplicate'?{code:'user_already_exists',error_code:'user_already_exists',msg:'Account exists'}:{id:'10000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'ui-test@example.test',identities:[]})}));
 await page.route('**/auth/v1/token**',route=>route.fulfill({status:400,headers:{'x-supabase-api-version':'2024-01-01','access-control-allow-origin':'http://localhost:5182','access-control-expose-headers':'X-Supabase-Api-Version','access-control-allow-headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version','access-control-allow-methods':'POST,OPTIONS'},contentType:'application/json',body:JSON.stringify({code:'invalid_credentials',error_code:'invalid_credentials',msg:'Invalid login credentials'})}));
 stage='registration-ui';await page.goto('http://localhost:5182/register');await page.getByLabel('Name',{exact:true}).fill('UI test');await page.getByLabel('Email',{exact:true}).fill('ui-test@example.test');await page.getByLabel('Password',{exact:true}).fill('Ui-test-password!');await page.getByLabel('Confirm password',{exact:true}).fill('Ui-test-password!');await page.getByRole('button',{name:'Create account',exact:true}).click();await expect(page.getByRole('alert')).toContainText('An account may already exist');result.duplicateEmailGuidance=true;
 signupMode='confirm';await page.getByRole('button',{name:'Create account',exact:true}).click();await page.getByRole('heading',{name:'Check your email',exact:true}).waitFor();result.confirmationGuidance=true;
 stage='login-ui';await page.goto('http://localhost:5182/login');await page.getByLabel('Email',{exact:true}).fill('ui-test@example.test');await page.getByLabel('Password',{exact:true}).fill('Wrong-test-password!');await page.getByRole('button',{name:'Sign in',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Unable to sign in');result.invalidLoginGuidance=true;
 stage='production-views';await page.goto('http://localhost:5182/checkout/10000000-0000-4000-8000-000000000001');await page.getByRole('heading',{name:'Online payments unavailable'}).waitFor();await expect(page.getByRole('button',{name:/Simulate/})).toHaveCount(0);result.productionCheckoutDisabled=true;
 await page.goto('http://localhost:5182/__verify');await page.getByRole('heading',{name:'Page not found'}).waitFor();result.developmentVerificationRouteAbsent=true;
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));result.mobileNoOverflow=true;
}catch(e){result.failureStage=stage;let message=String(e?.message??'');for(const secret of [...Object.values(api),...Object.values(web)].filter(v=>v.length>5))message=message.split(secret).join('[redacted]');result.failureDetail=message.replace(/https?:\/\/[^\s]+/g,'[url]').slice(0,1500);process.exitCode=1;
}finally{await browser?.close().catch(()=>{});preview?.kill();backend?.kill();
 const secrets=[...Object.entries(api),...Object.entries(web)].filter(([k,v])=>/KEY|PASSWORD|SECRET|DATABASE_URL|TEST_STAFF_EMAIL/.test(k)&&v.length>5).map(([,v])=>v);try{secrets.push(decodeURIComponent(new URL(api.DATABASE_URL).password));}catch{/* Never print credentials. */}
 result.noCredentialsInLogs=!secrets.some(v=>logs.join('').includes(v));if(Object.values(result).some(v=>v===false))process.exitCode=1;mkdirSync('.runtime',{recursive:true});writeFileSync('.runtime/phase8-production.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));}
