import {spawnSync} from 'node:child_process';
import {devNull} from 'node:os';

// Process configuration only: never load a developer's .env in these tests.
const database=process.argv.includes('--database');
if(database&&!process.env.TEST_DATABASE_URL){
  console.error('Pending: set TEST_DATABASE_URL to a separate, migrated test database.');
  process.exit(1);
}
const result=spawnSync(process.execPath,['--import','tsx','--test',...(database?['tests/whatsapp.integration.test.ts']:['tests/whatsapp.test.ts','tests/twilio.test.ts'])],{
  env:{...process.env,DOTENV_CONFIG_PATH:devNull,NODE_ENV:'test',WHATSAPP_PROVIDER:'DISABLED'},encoding:'utf8',
});
let output=(result.stdout??'')+(result.stderr??'');
const sensitive=Object.entries(process.env).filter(([name,value])=>/TOKEN|SECRET|PASSWORD|DATABASE_URL/.test(name)&&value?.length>5).map(([,value])=>value);
try{sensitive.push(decodeURIComponent(new URL(process.env.TEST_DATABASE_URL).password));}catch{/* Never print configuration. */}
for(const value of sensitive.filter(Boolean))output=output.split(value).join('[REDACTED]');
process.stdout.write(output);
if(result.error)console.error('Could not start WhatsApp tests.');
process.exitCode=result.status??1;
