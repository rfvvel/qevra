import assert from 'node:assert/strict';
import {test} from 'node:test';
import {registrationSchema,memberByEmailSchema,staffCredentialsSchema} from '@qevra/contracts';
import {assertProductionReady} from '../apps/api/src/config/production.js';
test('registration validates names, normalized email, password length and matching confirmation',()=>{
 const data={name:' Anna ',email:' ANNA@EXAMPLE.COM ',password:'long-test-password',confirmPassword:'long-test-password'};
 assert.equal(registrationSchema.parse(data).email,'anna@example.com');assert.equal(registrationSchema.parse(data).name,'Anna');
 for(const invalid of [{...data,name:' '},{...data,email:'bad'},{...data,confirmPassword:'different'},{...data,password:'short'},{...data,role:'OWNER'}])assert.equal(registrationSchema.safeParse(invalid).success,false);
 assert.equal(staffCredentialsSchema.parse({email:' STAFF@EXAMPLE.COM ',password:'test'}).email,'staff@example.com');
});
test('email member assignment is exact and cannot inject owner role or UUID',()=>{
 assert.deepEqual(memberByEmailSchema.parse({email:' STAFF@EXAMPLE.COM ',role:'STAFF'}),{email:'staff@example.com',role:'STAFF'});
 for(const value of [{email:'x@example.com',role:'OWNER'},{email:'x',role:'STAFF'},{email:'x@example.com',role:'STAFF',user_id:'extra'}])assert.equal(memberByEmailSchema.safeParse(value).success,false);
});
test('production startup requires configured HTTPS origins and verified database TLS',()=>{
 const valid={NODE_ENV:'production',WEB_ORIGIN:'https://web.example',SUPABASE_URL:'https://project.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public-placeholder',DATABASE_URL:'postgresql://db.example/database?sslmode=verify-full'};
 assert.doesNotThrow(()=>assertProductionReady(valid));
 for(const change of [{WEB_ORIGIN:'*'},{WEB_ORIGIN:'http://web.example'},{WEB_ORIGIN:'https://web.example/path'},{SUPABASE_URL:undefined},{SUPABASE_URL:'https://project.supabase.co/auth/v1'},{DATABASE_URL:'postgresql://db.example/database?sslmode=no-verify'}])assert.throws(()=>assertProductionReady({...valid,...change}));
 assert.doesNotThrow(()=>assertProductionReady({NODE_ENV:'development',WEB_ORIGIN:'http://localhost:5173'}));
});
